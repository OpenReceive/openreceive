import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compose, InfraError, shopComposeEnv } from "./docker.ts";
import { check, liveShopChecks, Visitor } from "./live.ts";
import { openingFor } from "./loop.ts";
import {
  inspectShop,
  orderStatus,
  prepareShop,
  removeShop,
  shopChecks,
  startShop,
} from "./sandbox.ts";
import { scanTrackedSecrets } from "./scan.ts";
import type { Check, Platform } from "./types.ts";
import { startTrialWallet, trialWalletOverride } from "./wallet.ts";

// A trial run by hand: any coding agent integrates the shop itself, following
// trials/by-hand.md, and this script does the harness's part around it. It
// prepares a plain shop wired to the trial wallet, and afterwards runs the
// same live checks an automated trial runs. Codes go to files, never to the
// console.

const trialsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Docker-only shops that need no account, no real wallet and no synced chain. */
const BY_HAND_PLATFORMS = [
  "node",
  "fastify",
  "next",
  "nestjs",
  "rails",
  "django",
  "fastapi",
  "flask",
  "php",
  "laravel",
  "woocommerce",
] as const;

interface State {
  readonly slug: string;
  readonly baseUrl: string;
  readonly name: string;
}

function value(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

function codesDir(directory: string): string {
  return `${directory}.codes`;
}

function stateFile(directory: string): string {
  return `${directory}.by-hand.json`;
}

async function loadPlatform(slug: string): Promise<Platform> {
  if (!(BY_HAND_PLATFORMS as readonly string[]).includes(slug)) {
    throw new InfraError(
      `"${slug}" is not a by-hand platform. Use one of: ${BY_HAND_PLATFORMS.join(", ")}`,
    );
  }
  return JSON.parse(
    await readFile(path.join(trialsRoot, "platforms", slug, "platform.json"), "utf8"),
  ) as Platform;
}

function print(checks: readonly Check[]): void {
  for (const item of checks) {
    const mark = item.pass ? "PASS" : item.severity === "blocker" ? "FAIL" : "WARN";
    console.log(`${mark} ${item.id}: ${item.summary}${item.evidence ? ` [${item.evidence}]` : ""}`);
  }
}

async function prepare(argv: readonly string[]): Promise<void> {
  const slug = value(argv, "--platform") ?? "";
  const name = (value(argv, "--name") ?? "").replace(/[^a-zA-Z0-9._-]/g, "-");
  if (name === "") throw new InfraError("--name <your model name> is required.");
  const platform = await loadPlatform(slug);
  // Reuses the shared stack when it is healthy; never restarts it.
  const wallet = await startTrialWallet();
  const swaps = platform.swap_provider !== "live";
  const directory = await prepareShop(
    path.join(trialsRoot, "platforms", slug, "fixture"),
    slug,
    undefined,
    platform.service,
    swaps
      ? trialWalletOverride(platform.wallet_services ?? [platform.service ?? "wordpress"], wallet)
      : undefined,
  );
  const sandbox = await startShop(
    directory,
    path.join(trialsRoot, "platforms", slug, "seed"),
    platform,
  );
  const codes = codesDir(directory);
  await mkdir(codes, { mode: 0o700 });
  await writeFile(path.join(codes, "nwc"), wallet.nwc, { mode: 0o600 });
  if (swaps) await writeFile(path.join(codes, "lsc"), wallet.lsc, { mode: 0o600 });
  const state: State = { slug, baseUrl: sandbox.baseUrl, name };
  await writeFile(stateFile(directory), `${JSON.stringify(state, null, 2)}\n`);

  const directionsUrl = `https://openreceive.org/agent-directions/${platform.directions_slug ?? slug}.md`;
  const plain = shopChecks(await inspectShop(directory, platform));
  console.log("");
  print(plain);
  const composeFile = shopComposeEnv(directory).COMPOSE_FILE;
  console.log(`
shop:             ${directory}
shop URL:         ${sandbox.baseUrl}
docker compose:   run every docker compose command for this shop from the shop
                  directory with this exported first (it wires the trial wallet):
                  export COMPOSE_FILE='${composeFile ?? "compose.yml"}'
directions:       ${directionsUrl}
merchant prompt:  ${await openingFor(platform, directionsUrl)}
doctor:           ${platform.doctor || "(none)"}
codes go in:      ${platform.credential_store.where}
NWC code file:    ${path.join(codes, "nwc")}
LSC code file:    ${swaps ? path.join(codes, "lsc") : "(none: this shop is Bitcoin only)"}${
    platform.live === true
      ? `
order status:     docker compose exec -T ${platform.service ?? "web"} ${(platform.probes?.orderStatus ?? []).slice(3).join(" ") || "node bin/order-status.js"} <order id>`
      : ""
  }
afterwards:       npm run trial:by-hand -- check --shop ${directory}`);
  if (plain.some((item) => item.severity === "blocker" && !item.pass)) process.exitCode = 2;
}

async function readState(directory: string): Promise<State> {
  return JSON.parse(await readFile(stateFile(directory), "utf8")) as State;
}

/**
 * The checkout's swap picker: with an LSC code, at least one method must be on
 * offer. The order is the $12 product: the test swap provider prices BTC at a
 * fixed $100,000 and takes at least 10 USDT, so the $7 one is too small
 * whenever BTC trades above about $70,000.
 */
async function swapCheck(baseUrl: string): Promise<Check> {
  const buyer = new Visitor(baseUrl);
  const order = await buyer.placeOrder(2);
  const prepared = await buyer.prepareCheckout(order, `/orders/${order}`);
  const methods = (() => {
    try {
      const body = JSON.parse(prepared.body) as {
        payment_methods?: { pay_in_asset: string; available: boolean }[];
      };
      return body.payment_methods ?? [];
    } catch {
      return [];
    }
  })();
  const available = methods
    .filter((method) => method.available)
    .map((method) => method.pay_in_asset);
  return check(
    "live_swap_methods",
    prepared.status === 200 && available.length > 0,
    "The checkout offers swap pay-in methods from the test swap provider.",
    prepared.status === 200
      ? `available: ${available.join(", ") || "none"}`
      : `${prepared.status} ${prepared.body.slice(0, 200)}`,
  );
}

async function checkShop(argv: readonly string[]): Promise<void> {
  const directory = path.resolve(value(argv, "--shop") ?? "");
  const state = await readState(directory);
  const platform = await loadPlatform(state.slug);
  const wallet = await startTrialWallet();
  const secrets = [wallet.nwc, wallet.lsc];
  const checks: Check[] = [await scanTrackedSecrets(directory, secrets, [])];
  if (platform.live === true) {
    checks.push(
      ...(await liveShopChecks(state.baseUrl, {
        paid: {
          settle: wallet.settle,
          orderStatus: (id: string) => orderStatus(directory, platform, id),
        },
      })),
    );
    if (platform.swap_provider !== "live") checks.push(await swapCheck(state.baseUrl));
  } else {
    console.log(
      "This platform has no scripted live checks: buy a product in the browser instead (trials/by-hand.md).",
    );
  }
  console.log("");
  print(checks);
  if (checks.some((item) => item.severity === "blocker" && !item.pass)) {
    process.exitCode = 1;
    const service = platform.service ?? "web";
    const logs = await compose(
      directory,
      platform.logs ?? ["logs", "--no-color", "--tail", "40", service],
      30_000,
    )
      .then((result) => `${result.stdout}\n${result.stderr}`.trim())
      .catch((error: unknown) => String(error));
    console.log(`\nThe shop's log:\n${logs}`);
  }
}

async function stop(argv: readonly string[]): Promise<void> {
  const directory = path.resolve(value(argv, "--shop") ?? "");
  await readState(directory);
  await removeShop(directory);
  await rm(codesDir(directory), { recursive: true, force: true });
  await rm(stateFile(directory), { force: true });
  console.log(`Removed ${directory}`);
}

async function main(): Promise<void> {
  const [command, ...argv] = process.argv.slice(2);
  if (command === "prepare") return prepare(argv);
  if (command === "check") return checkShop(argv);
  if (command === "stop") return stop(argv);
  console.log(`Usage: npm run trial:by-hand -- prepare --platform <${BY_HAND_PLATFORMS.join("|")}> --name <your model>
       npm run trial:by-hand -- check --shop <shop directory>
       npm run trial:by-hand -- stop --shop <shop directory>
See trials/by-hand.md.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
