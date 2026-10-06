import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { compose, InfraError } from "./docker.ts";
import type { Check } from "./types.ts";

const UP_TIMEOUT_MS = 6 * 60 * 1000;
const SEED_TIMEOUT_MS = 15 * 60 * 1000;

export interface Sandbox {
  readonly id: string;
  readonly directory: string;
  readonly baseUrl: string;
  stop: (keep: boolean) => Promise<void>;
}

export interface ShopEvidence {
  readonly baseUrl: string;
  readonly productCount: number;
  readonly gmp: boolean;
  readonly openreceive: boolean;
  readonly nwcInEnv: boolean;
}

function run(command: string, args: readonly string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new InfraError(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

const FIXTURE_PORT = "127.0.0.1:8080:80";

/** A port nothing on 127.0.0.1 is listening on right now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null
          ? resolve(address.port)
          : reject(new InfraError("No free port on 127.0.0.1.")),
      );
    });
  });
}

/**
 * Copy the fixture to a unique directory. Its basename is the Compose project name.
 * The copy gets its own fixed host port: a random one ("127.0.0.1::80") changes
 * when the agent recreates the container after adding GMP, and the order-pay
 * links WordPress prints then point at the old port.
 */
export async function prepareShop(fixtureDir: string, slug: string): Promise<string> {
  const id = Math.random().toString(16).slice(2, 10);
  const directory = await mkdtemp(path.join(tmpdir(), `oreval-${slug}-${id}-`));
  await cp(fixtureDir, directory, { recursive: true });
  const composeFile = path.join(directory, "compose.yml");
  const fixture = await readFile(composeFile, "utf8");
  if (!fixture.includes(FIXTURE_PORT))
    throw new InfraError(`${composeFile} does not publish ${FIXTURE_PORT}.`);
  await writeFile(composeFile, fixture.replace(FIXTURE_PORT, `127.0.0.1:${await freePort()}:80`));
  await run("git", ["init", "-b", "master"], directory);
  await run("git", ["add", "README.md", "compose.yml"], directory);
  await run(
    "git",
    [
      "-c",
      "user.name=dev",
      "-c",
      "user.email=dev@example.com",
      "commit",
      "-m",
      "Plain Widget Shop",
    ],
    directory,
  );
  return directory;
}

async function removeShop(directory: string): Promise<void> {
  const id = path.basename(directory);
  await compose(directory, ["down", "-v", "--remove-orphans"], 120_000).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to remove ${id}: ${message}`);
  });
  await rm(directory, { recursive: true, force: true });
}

export async function startShop(directory: string, seedDir: string): Promise<Sandbox> {
  const id = path.basename(directory);
  try {
    await compose(directory, ["up", "-d", "--wait", "--wait-timeout", "300"], UP_TIMEOUT_MS);
    const baseUrl = `http://127.0.0.1:${await publishedPort(directory)}`;
    await compose(
      directory,
      [
        "--profile",
        "tools",
        "run",
        "--rm",
        "-T",
        "--no-deps",
        "--entrypoint",
        "sh",
        "-u",
        "0:0",
        "-e",
        `SHOP_URL=${baseUrl}`,
        "-e",
        "SHOP_ADMIN_PASSWORD=widget-shop-local",
        "-e",
        "WP_CLI_ALLOW_ROOT=1",
        "-v",
        `${seedDir}:/seed:ro`,
        "cli",
        "/seed/seed.sh",
      ],
      SEED_TIMEOUT_MS,
    );
    return {
      id,
      directory,
      baseUrl,
      stop: async (keep: boolean) => {
        if (keep) {
          console.log(`Kept ${id} at ${baseUrl} (${directory})`);
          return;
        }
        await removeShop(directory);
      },
    };
  } catch (error) {
    await removeShop(directory);
    throw error;
  }
}

async function publishedPort(directory: string): Promise<string> {
  const published = await compose(directory, ["port", "wordpress", "80"], 30_000);
  const host = published.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
  const port = host.match(/:(\d+)\s*$/)?.[1];
  if (port === undefined) throw new InfraError(`WordPress did not publish a port (${host}).`);
  return port;
}

export async function inspectShop(directory: string): Promise<ShopEvidence> {
  const port = await publishedPort(directory);
  // The same command the directions tell an agent to run.
  const count = await compose(
    directory,
    [
      "run",
      "--rm",
      "-T",
      "--no-deps",
      "cli",
      "wp",
      "post",
      "list",
      "--post_type=product",
      "--format=count",
    ],
    120_000,
  );
  const modules = await compose(directory, ["exec", "-T", "wordpress", "php", "-m"], 60_000);
  const plugins = await compose(
    directory,
    [
      "exec",
      "-T",
      "wordpress",
      "php",
      "-r",
      'require "/var/www/html/wp-load.php"; $active = get_option("active_plugins"); echo (is_array($active) && preg_match("/openreceive/i", implode(" ", $active))) ? "yes\n" : "no\n";',
    ],
    60_000,
  );
  const env = await compose(directory, ["exec", "-T", "wordpress", "printenv"], 30_000);
  const lastLine = count.stdout.trim().split("\n").filter(Boolean).at(-1);
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    productCount: Number(lastLine),
    gmp: modules.stdout.split("\n").some((line) => line.trim() === "gmp"),
    openreceive: plugins.stdout.trim().endsWith("yes"),
    nwcInEnv: /^(?:NWC_URI|LSC_URI_)/m.test(env.stdout),
  };
}

export function shopChecks(evidence: ShopEvidence): Check[] {
  return [
    {
      id: "shop_started",
      severity: "blocker",
      pass: evidence.baseUrl.startsWith("http://"),
      summary: "The stock shop published an address.",
      evidence: evidence.baseUrl,
    },
    {
      id: "products_seeded",
      severity: "blocker",
      pass: evidence.productCount === 5,
      summary: "The shop has five products and no OpenReceive code.",
      evidence: `${evidence.productCount} products`,
    },
    {
      id: "gmp_absent",
      severity: "blocker",
      pass: evidence.gmp === false,
      summary: "The stock WordPress image does not have GMP.",
      evidence: evidence.gmp ? "gmp is loaded" : "gmp is absent",
    },
    {
      id: "openreceive_absent",
      severity: "blocker",
      pass: evidence.openreceive === false,
      summary: "OpenReceive is not installed.",
    },
    {
      id: "codes_absent",
      severity: "blocker",
      pass: evidence.nwcInEnv === false,
      summary: "The container environment has no NWC or LSC code.",
    },
  ];
}
