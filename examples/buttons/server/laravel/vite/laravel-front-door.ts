import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import type { Plugin } from "vite";

/**
 * The paths the Laravel app owns. Everything else — `/resources/**`,
 * `/@vite/**`, `/@fs/**`, `/node_modules/**` — is Vite's, and stays with Vite.
 * The explicit list is deliberate: a fall-through proxy would forward a typo
 * in an import to PHP and produce a Laravel 404 page where a Vite error
 * belongs.
 */
const LARAVEL_PREFIXES = ["/shop", "/openreceive", "/images", "/__testkit", "/checkout", "/up"];

/**
 * A development-only APP_KEY, so a fresh checkout boots with no .env at all —
 * Laravel refuses to start without one. compose.yml carries its own default,
 * and a real deployment sets APP_KEY like every other Laravel app.
 */
const DEV_APP_KEY = "base64:YnV5LWEtYnV0dG9uLWxhcmF2ZWwtZGV2LWtleS0zMiE=";

const ownedByLaravel = (url: string | undefined): boolean => {
  const pathname = (url ?? "/").split("?")[0] ?? "/";
  if (pathname === "/") return true;
  return LARAVEL_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
};

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("could not pick a port for php artisan serve"));
      });
    });
  });

const waitForHealth = async (port: number, child: ChildProcess): Promise<void> => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`php artisan serve exited with ${child.exitCode}`);
    const ok = await new Promise<boolean>((resolve) => {
      const request = http.get({ host: "127.0.0.1", port, path: "/up" }, (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      });
      request.on("error", () => resolve(false));
    });
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("php artisan serve did not answer /up within 60s");
};

/** One request, forwarded verbatim (method, path, headers, body) and streamed back. */
const forward = (req: http.IncomingMessage, res: http.ServerResponse, port: number): void => {
  const upstream = http.request(
    { host: "127.0.0.1", port, method: req.method, path: req.url, headers: req.headers },
    (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    },
  );
  upstream.on("error", (error) => {
    res.statusCode = 502;
    res.setHeader("Content-Type", "text/plain");
    res.end(`php artisan serve is not answering: ${error.message}`);
  });
  req.pipe(upstream);
};

export function laravelFrontDoor(options: {
  readonly demoRoot: string;
  readonly rootEnv: Record<string, string>;
}): Plugin {
  const { demoRoot, rootEnv } = options;
  const hotFile = path.join(demoRoot, "public/hot");
  let child: ChildProcess | undefined;

  const cleanup = (): void => {
    if (existsSync(hotFile)) rmSync(hotFile);
    if (child && child.exitCode === null) child.kill("SIGTERM");
    child = undefined;
  };

  return {
    name: "openreceive-buttons-laravel-front-door",
    apply: "serve",
    async configureServer(server) {
      // The root .env (NWC_URI, LSC_URI_*) reaches PHP and nothing else; the
      // process environment (DEMO_WALLET, OPENRECEIVE_DEMO_DB from the E2E
      // harness) wins over the file.
      const env: NodeJS.ProcessEnv = {
        ...rootEnv,
        ...process.env,
        APP_ENV: process.env.APP_ENV ?? "local",
        APP_DEBUG: process.env.APP_DEBUG ?? "true",
        APP_KEY: process.env.APP_KEY ?? DEV_APP_KEY,
        LOG_CHANNEL: process.env.LOG_CHANNEL ?? "stderr",
        // The built-in server is single-threaded by default; the checkout polls
        // while the shop loads, so give it a few workers.
        PHP_CLI_SERVER_WORKERS: process.env.PHP_CLI_SERVER_WORKERS ?? "4",
      };

      // config/database.php derives the SQLite path from OPENRECEIVE_DEMO_DB (or
      // examples/buttons/.data); Laravel creates the file, not the directory.
      const dataDir = env.OPENRECEIVE_DEMO_DB
        ? path.resolve(env.OPENRECEIVE_DEMO_DB)
        : path.resolve(demoRoot, "../../.data");
      if (!env.DB_CONNECTION || env.DB_CONNECTION === "sqlite")
        mkdirSync(dataDir, { recursive: true });

      for (const args of [
        ["artisan", "migrate", "--force", "--no-interaction"],
        ["artisan", "db:seed", "--force", "--no-interaction"],
      ]) {
        const result = spawnSync("php", args, { cwd: demoRoot, env, stdio: "inherit" });
        if (result.status !== 0) throw new Error(`php ${args.join(" ")} failed (${result.status})`);
      }

      const phpPort = await freePort();
      child = spawn(
        "php",
        ["artisan", "serve", "--host", "127.0.0.1", "--port", String(phpPort), "--no-reload"],
        { cwd: demoRoot, env, stdio: "inherit" },
      );
      child.on("exit", (code) => {
        if (code !== null && code !== 0)
          server.config.logger.error(`php artisan serve exited with ${code}`);
      });
      await waitForHealth(phpPort, child);
      server.config.logger.info(
        `[buttons-laravel] php artisan serve on 127.0.0.1:${phpPort}, fronted by Vite`,
      );

      // The `hot` file: Laravel's @vite directive reads it and points the
      // browser at THIS server for its modules and HMR client.
      server.httpServer?.once("listening", () => {
        const address = server.httpServer?.address();
        const port =
          address && typeof address === "object" ? address.port : server.config.server.port;
        writeFileSync(hotFile, `http://127.0.0.1:${port}`);
      });
      server.httpServer?.once("close", cleanup);
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.once(signal, () => {
          cleanup();
          process.exit(0);
        });
      }
      process.once("exit", cleanup);

      server.middlewares.use((req, res, next) => {
        if (ownedByLaravel(req.url)) forward(req, res, phpPort);
        else next();
      });
    },
  };
}
