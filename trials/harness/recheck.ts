import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type ChaosBuyer, chaosChecks, clientPrefix, fixtureBuyer } from "./chaos.ts";
import { DEVTOOLS_STEPS, type DevtoolsStep, devtoolsChecks } from "./devtools.ts";
import { compose, walletOverrideFile } from "./docker.ts";
import { shopLogCheck } from "./checks.ts";
import { describeInstalled, installedVersions } from "./installed.ts";
import { debugPageChecks } from "./leaks.ts";
import { hasPayerWalk, payerOrders } from "./payer-orders.ts";
import { payerWalkChecks } from "./payer.ts";
import { redact } from "./redact.ts";
import { liveShopChecks } from "./live.ts";
import { containerPortOf, orderStatus, publishedPort, removeShop } from "./sandbox.ts";
import { type TwoShopsSide, twoShopsChecks } from "./two-shops.ts";
import type { Check, Platform } from "./types.ts";
import { prepareOldNodeShop, upgradeChecks } from "./upgrade.ts";
import { startTrialWallet, type TrialWallet, trialWalletOverride } from "./wallet.ts";
import {
  liveEddChecks,
  liveWoocommerceChecks,
  wordpressChaosBuyers,
  wordpressKind,
  wordpressMethodListing,
} from "./wordpress.ts";
import { wpAdminSaveChecks } from "./wpadmin.ts";

// Re-run the harness's checks on a shop an earlier trial kept (`--keep`):
// the live checks, and the chaos phase, without another agent. This is how a
// new check is proved: it must fail on a shop running the release whose bug
// it targets and pass on the fixed one (trials/README.md, "Recheck").
//
//   npm run trial:recheck -- --dir /tmp/ortrial-node-… [--phases live,payer,leaks,chaos,logs,devtools]
//   npm run trial:recheck -- --dir <kept WordPress shop> --phases wpadmin
//   npm run trial:recheck -- --dir <kept shop> --other <another> --phases two-shops
//   npm run trial:recheck -- --phases upgrade [--from 0.4.20] [--keep]
//
// A hosted platform has its own live module, so only its payer walk runs here
// (--phases payer).
//
// The shop's wallet override is written again first, so a shop kept before
// the interceptor existed reaches the relay through it too.

const trialsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PHASES = ["live", "payer", "leaks", "chaos", "logs", "devtools"] as const;
/** Only when named: each changes the shop's settings or needs a second shop. */
const ON_REQUEST = ["wpadmin", "two-shops", "upgrade"] as const;
type Phase = (typeof PHASES)[number] | (typeof ON_REQUEST)[number];

function value(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

/** The platform slug in a kept shop's directory name: ortrial-<slug>-<8 hex>-<6>. */
export function slugOf(directory: string): string {
  const slug = path.basename(directory).match(/^ortrial-(.+)-[0-9a-f]{8}-[A-Za-z0-9]{6}$/)?.[1];
  if (slug === undefined) {
    throw new Error(`${directory} is not a kept trial shop (ortrial-<slug>-<id>-<suffix>).`);
  }
  return slug;
}

export function phasesOf(spec: string | undefined): Phase[] {
  const names = (spec ?? PHASES.join(",")).split(",").map((name) => name.trim());
  for (const name of names) {
    if (![...PHASES, ...ON_REQUEST].some((phase) => phase === name)) {
      throw new Error(`Unknown phase "${name}". Phases: ${[...PHASES, ...ON_REQUEST].join(", ")}`);
    }
  }
  return names as Phase[];
}

/** Throws unless a kept shop of this platform can run these phases. */
export function assertRecheckable(
  platform: Pick<Platform, "slug" | "host">,
  phases: readonly Phase[],
): void {
  if (platform.host === undefined) return;
  if (!hasPayerWalk(platform)) {
    throw new Error(
      `${platform.slug} has its own live module (${platform.host}) and no payer walk; recheck cannot run it.`,
    );
  }
  const other = phases.filter((phase) => phase !== "payer");
  if (other.length > 0) {
    throw new Error(
      `${platform.slug} has its own live module (${platform.host}), so recheck runs only its payer walk: pass --phases payer (not ${other.join(", ")}).`,
    );
  }
}

/** `--only build,hot`: the dev-tools steps to run, all of them when omitted. */
export function stepsOf(spec: string | undefined): DevtoolsStep[] {
  if (spec === undefined) return [...DEVTOOLS_STEPS];
  const names = spec.split(",").map((name) => name.trim());
  for (const name of names) {
    if (!(DEVTOOLS_STEPS as readonly string[]).includes(name)) {
      throw new Error(`Unknown step "${name}". Steps: ${DEVTOOLS_STEPS.join(", ")}`);
    }
  }
  return names as DevtoolsStep[];
}

function print(checks: readonly Check[], uris: readonly string[]): void {
  for (const item of checks) {
    console.log(`${item.pass ? "PASS" : "FAIL"} ${item.id}: ${item.summary}`);
    if (item.evidence !== undefined && (!item.pass || process.argv.includes("--verbose"))) {
      console.log(`     ${redact(item.evidence, uris).replaceAll("\n", "\n     ")}`);
    }
  }
}

interface AttachedShop {
  readonly directory: string;
  readonly platform: Platform;
  readonly wordpress: ReturnType<typeof wordpressKind>;
  readonly baseUrl: string;
}

/** A kept shop, up and on the trial network, as the recheck phases expect it. */
async function attach(directory: string, wallet: TrialWallet): Promise<AttachedShop> {
  const slug = slugOf(directory);
  const platform = JSON.parse(
    await readFile(path.join(trialsRoot, "platforms", slug, "platform.json"), "utf8"),
  ) as Platform;
  const wordpress = wordpressKind(platform);
  const services = platform.wallet_services ?? [platform.service ?? "web"];
  // WP-CLI runs once per command; there is no container of it to start.
  await writeFile(walletOverrideFile(directory), trialWalletOverride(services, wallet));
  const service = platform.service ?? (wordpress === undefined ? "web" : "wordpress");
  await compose(directory, ["up", "-d", "--wait", service], 10 * 60_000);
  const baseUrl = `http://127.0.0.1:${await publishedPort(directory, service, containerPortOf(platform))}`;
  return { directory, platform, wordpress, baseUrl };
}

const BUYER_OF = (shop: AttachedShop): (() => Promise<ChaosBuyer>) =>
  shop.wordpress === undefined
    ? () => fixtureBuyer(shop.baseUrl)
    : wordpressChaosBuyers(shop.wordpress, shop.directory, shop.baseUrl);

/**
 * `--phases upgrade` with no --dir builds its own shop on an old release
 * (trials/scenarios/old-version); with --dir, a kept one still on an old release.
 */
async function upgradePhase(argv: readonly string[]): Promise<Check[]> {
  const wallet = await startTrialWallet();
  const given = value(argv, "--dir");
  const from = value(argv, "--from") ?? "0.4.20";
  const platform = JSON.parse(
    await readFile(path.join(trialsRoot, "platforms", "node", "platform.json"), "utf8"),
  ) as Platform;
  const shop =
    given === undefined
      ? await prepareOldNodeShop(
          path.join(trialsRoot, "platforms", "node", "fixture"),
          platform,
          wallet,
          from,
        )
      : await attach(given, wallet);
  console.log(`upgrade: ${shop.directory} from ${from}`);
  try {
    return await upgradeChecks({
      directory: shop.directory,
      platform,
      baseUrl: shop.baseUrl,
      settle: wallet.settle,
      log: (line) => console.log(line),
    });
  } finally {
    if (given === undefined && !argv.includes("--keep")) await removeShop(shop.directory);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const phases = phasesOf(value(argv, "--phases"));
  const directory = value(argv, "--dir");
  if (argv.includes("--help") || (directory === undefined && phases.join() !== "upgrade")) {
    console.log(
      "Usage: npm run trial:recheck -- --dir <kept shop directory> [--phases live,payer,leaks,chaos,logs,devtools,wpadmin,two-shops,upgrade] [--only debug,build,tests,hot,workers] [--other <second kept shop>] [--verbose]\n       npm run trial:recheck -- --phases upgrade [--from 0.4.20] [--keep]",
    );
    return;
  }
  if (phases.join() === "upgrade") {
    const checks = await upgradePhase(argv);
    const { nwc, lsc } = await startTrialWallet();
    print(checks, [nwc, lsc]);
    if (checks.some((item) => item.severity === "blocker" && !item.pass)) process.exitCode = 1;
    return;
  }
  if (directory === undefined) throw new Error("--dir is required.");
  const wallet = await startTrialWallet();
  const here = await attach(directory, wallet);
  const { platform, wordpress, baseUrl } = here;
  assertRecheckable(platform, phases);
  console.log(`openreceive: ${describeInstalled(await installedVersions(directory, platform))}`);
  const paid = {
    settle: wallet.settle,
    orderStatus: (orderId: string) => orderStatus(directory, platform, orderId),
  };
  const checks: Check[] = [];
  if (phases.includes("live")) {
    console.log(`live: ${baseUrl}`);
    const options = { paid, swap: { ...paid, complete: wallet.completeSwap } };
    checks.push(
      ...(wordpress === "woocommerce"
        ? await liveWoocommerceChecks(directory, baseUrl, options)
        : wordpress === "edd"
          ? await liveEddChecks(directory, baseUrl, options)
          : await liveShopChecks(baseUrl, options)),
    );
  }
  if (phases.includes("payer")) {
    console.log(`payer: ${baseUrl}`);
    const placeOrder = payerOrders(platform, directory, baseUrl);
    checks.push(
      ...(await payerWalkChecks({
        baseUrl,
        directory,
        platform,
        wallet,
        client: clientPrefix(directory),
        reportDir: path.join(trialsRoot, "reports", "recheck", path.basename(directory)),
        ...(placeOrder === undefined ? {} : { placeOrder }),
      })),
    );
  }
  if (phases.includes("leaks")) checks.push(...(await debugPageChecks(directory, platform)));
  if (phases.includes("logs")) {
    const log = await compose(directory, ["logs", "--no-color", "--timestamps"], 60_000, {
      quiet: true,
    });
    checks.push(shopLogCheck(`${log.stdout}\n${log.stderr}`, [wallet.nwc, wallet.lsc]));
  }
  if (phases.includes("devtools")) {
    console.log(`devtools: ${baseUrl}`);
    checks.push(
      ...(await devtoolsChecks(
        { directory, platform, baseUrl, wallet, log: (line) => console.log(line) },
        stepsOf(value(argv, "--only")),
      )),
    );
  }
  if (phases.includes("chaos")) {
    console.log(`chaos: ${baseUrl}`);
    checks.push(
      ...(await chaosChecks({
        directory,
        platform,
        baseUrl,
        interceptor: wallet.interceptor,
        paid,
        log: (line) => console.log(line),
        ...(wordpress === undefined
          ? {}
          : {
              newBuyer: wordpressChaosBuyers(wordpress, directory, baseUrl),
              methodListing: wordpressMethodListing(wordpress, directory, baseUrl),
              healthPath: "/",
            }),
      })),
    );
  }
  if (phases.includes("wpadmin")) {
    if (wordpress === undefined) throw new Error(`${platform.slug} is not a WordPress store.`);
    console.log(`wpadmin: ${baseUrl}`);
    checks.push(
      ...(await wpAdminSaveChecks({
        kind: wordpress,
        directory,
        baseUrl,
        nwc: wallet.nwc,
        lsc: wallet.lsc,
        interceptor: wallet.interceptor,
        newBuyer: wordpressChaosBuyers(wordpress, directory, baseUrl),
      })),
    );
  }
  if (phases.includes("two-shops")) {
    const other = value(argv, "--other");
    if (other === undefined)
      throw new Error("--phases two-shops needs --other <second kept shop>.");
    const there = await attach(other, wallet);
    const side = (shop: AttachedShop): TwoShopsSide => ({
      name: path.basename(shop.directory),
      newBuyer: BUYER_OF(shop),
      orderStatus: async (buyer) =>
        (await buyer.status?.()) ?? orderStatus(shop.directory, shop.platform, buyer.order),
    });
    console.log(`two-shops: ${here.baseUrl} and ${there.baseUrl}`);
    checks.push(
      ...(await twoShopsChecks({
        a: side(here),
        b: side(there),
        settle: wallet.settle,
        log: (line) => console.log(line),
      })),
    );
  }
  print(checks, [wallet.nwc, wallet.lsc]);
  if (checks.some((item) => item.severity === "blocker" && !item.pass)) process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
