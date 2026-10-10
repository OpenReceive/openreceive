import { execFile, spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { inspectBtcpay, removeBtcpayState, setupBtcpay } from "./btcpay.ts";
import { compose, InfraError, platformOverrideFile, walletOverrideFile } from "./docker.ts";
import type { Check, Platform } from "./types.ts";

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
  /** Absent on shops that are not PHP. */
  readonly gmp?: boolean;
  readonly openreceive: boolean;
  readonly nwcInEnv: boolean;
}

function serviceOf(platform: Platform): string {
  return platform.service ?? "wordpress";
}

function containerPortOf(platform: Platform): number {
  return platform.container_port ?? 80;
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

const FIXTURE_PORT = "127.0.0.1:8080:";

/** Beside the shop, never inside it: the agent's `git add -A` must not pick it up. */
export function platformEnvFile(directory: string): string {
  return `${directory}.platform.env`;
}

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
 * when the agent recreates the container, and links the shop prints then point
 * at the old port. The container port after the marker stays as the fixture wrote it.
 */
export async function prepareShop(
  fixtureDir: string,
  slug: string,
  platformEnv?: Readonly<Record<string, string>>,
  service = "web",
  walletOverride?: string,
): Promise<string> {
  const id = Math.random().toString(16).slice(2, 10);
  const directory = await mkdtemp(path.join(tmpdir(), `ortrial-${slug}-${id}-`));
  await cp(fixtureDir, directory, { recursive: true });
  const composeFile = path.join(directory, "compose.yml");
  let fixture = await readFile(composeFile, "utf8");
  if (!fixture.includes(FIXTURE_PORT))
    throw new InfraError(`${composeFile} does not publish ${FIXTURE_PORT}.`);
  fixture = fixture.replace(FIXTURE_PORT, `127.0.0.1:${await freePort()}:`);
  // A hosting platform's variables reach the web service the way a Vercel or
  // Replit deployment gets them: from outside the app. Both files sit beside
  // the shop and no file in it names them; docker.ts adds the override to
  // every `docker compose` through COMPOSE_FILE, the agent's included.
  if (platformEnv !== undefined && Object.keys(platformEnv).length > 0) {
    const lines = Object.entries(platformEnv).map(([key, value]) => `${key}=${value}`);
    await writeFile(platformEnvFile(directory), `${lines.join("\n")}\n`, { mode: 0o600 });
    await writeFile(
      platformOverrideFile(directory),
      `services:\n  ${service}:\n    env_file:\n      - ${platformEnvFile(directory)}\n`,
      { mode: 0o600 },
    );
  }
  if (walletOverride !== undefined) await writeFile(walletOverrideFile(directory), walletOverride);
  await writeFile(composeFile, fixture);
  await run("git", ["init", "-b", "master"], directory);
  await run("git", ["add", "-A"], directory);
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

const execFileAsync = promisify(execFile);

async function removeShop(directory: string): Promise<void> {
  const id = path.basename(directory);
  await compose(directory, ["down", "-v", "--remove-orphans"], 120_000).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to remove ${id}: ${message}`);
  });
  // A container that ran as root on the bind-mounted shop (composer, bundle)
  // leaves files this user cannot delete: remove those through a container
  // too. A cleanup failure is logged, never thrown: it must not discard a
  // finished run's results.
  await rm(directory, { recursive: true, force: true }).catch(async () => {
    await execFileAsync(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${path.dirname(directory)}:/parent`,
        "alpine:3.20",
        "rm",
        "-rf",
        `/parent/${path.basename(directory)}`,
      ],
      { timeout: 120_000 },
    ).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to remove ${directory}: ${message}`);
    });
  });
  await rm(platformEnvFile(directory), { force: true }).catch(() => undefined);
  await rm(platformOverrideFile(directory), { force: true }).catch(() => undefined);
  await rm(walletOverrideFile(directory), { force: true }).catch(() => undefined);
  await removeBtcpayState(directory).catch(() => undefined);
}

export async function startShop(
  directory: string,
  seedDir: string,
  platform: Platform,
): Promise<Sandbox> {
  const id = path.basename(directory);
  const service = serviceOf(platform);
  try {
    await compose(directory, ["up", "-d", "--wait", "--wait-timeout", "300"], UP_TIMEOUT_MS);
    const baseUrl = `http://127.0.0.1:${await publishedPort(directory, service, containerPortOf(platform))}`;
    // A BTCPay merchant has an admin, a store and its products before the agent comes.
    if (platform.host === "btcpay") await setupBtcpay(directory, baseUrl);
    if (platform.seed === false) {
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
    }
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

async function publishedPort(
  directory: string,
  service: string,
  containerPort: number,
): Promise<string> {
  const published = await compose(directory, ["port", service, String(containerPort)], 30_000);
  const host = published.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
  const port = host.match(/:(\d+)\s*$/)?.[1];
  if (port === undefined) throw new InfraError(`${service} did not publish a port (${host}).`);
  return port;
}

export async function inspectShop(directory: string, platform: Platform): Promise<ShopEvidence> {
  const service = serviceOf(platform);
  const port = await publishedPort(directory, service, containerPortOf(platform));
  if (platform.host === "btcpay") return inspectBtcpay(directory, `http://127.0.0.1:${port}`);
  if (service !== "wordpress") return inspectContainerShop(directory, service, port, platform);
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

/** The shop's own record of an order: its status column, read inside the shop's container. */
export async function orderStatus(
  directory: string,
  platform: Platform,
  orderId: string,
): Promise<string> {
  const probe = platform.probes?.orderStatus ?? [
    "exec",
    "-T",
    serviceOf(platform),
    "node",
    "bin/order-status.js",
  ];
  const result = await compose(directory, [...probe, orderId], 60_000);
  return result.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
}

async function inspectContainerShop(
  directory: string,
  service: string,
  port: string,
  platform: Platform,
): Promise<ShopEvidence> {
  const count = await compose(
    directory,
    platform.probes?.products ?? ["exec", "-T", service, "node", "bin/product-count.js"],
    60_000,
  );
  const installed = await compose(
    directory,
    platform.probes?.openreceive ?? ["exec", "-T", service, "node", "bin/openreceive-installed.js"],
    30_000,
  );
  const env = await compose(directory, ["exec", "-T", service, "printenv"], 30_000);
  const lastLine = count.stdout.trim().split("\n").filter(Boolean).at(-1);
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    productCount: Number(lastLine),
    openreceive: installed.stdout.trim() === "yes",
    nwcInEnv: /^(?:NWC_URI|LSC_URI_)/m.test(env.stdout),
  };
}

/** `platformCodes`: the platform hands the shop its codes, so they should be there. */
export function shopChecks(evidence: ShopEvidence, platformCodes = false): Check[] {
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
    ...(evidence.gmp === undefined
      ? []
      : [
          {
            id: "gmp_absent",
            severity: "blocker" as const,
            pass: evidence.gmp === false,
            summary: "The stock WordPress image does not have GMP.",
            evidence: evidence.gmp ? "gmp is loaded" : "gmp is absent",
          },
        ]),
    {
      id: "openreceive_absent",
      severity: "blocker",
      pass: evidence.openreceive === false,
      summary: "OpenReceive is not installed.",
    },
    platformCodes
      ? {
          id: "platform_codes_present",
          severity: "blocker",
          pass: evidence.nwcInEnv,
          summary: "The platform gave the web service its NWC and LSC codes.",
        }
      : {
          id: "codes_absent",
          severity: "blocker",
          pass: evidence.nwcInEnv === false,
          summary: "The container environment has no NWC or LSC code.",
        },
  ];
}
