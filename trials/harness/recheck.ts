import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chaosChecks, clientPrefix } from "./chaos.ts";
import { compose, walletOverrideFile } from "./docker.ts";
import { debugPageChecks } from "./leaks.ts";
import { payerWalkChecks } from "./payer.ts";
import { liveShopChecks } from "./live.ts";
import { containerPortOf, orderStatus, publishedPort } from "./sandbox.ts";
import type { Check, Platform } from "./types.ts";
import { startTrialWallet, trialWalletOverride } from "./wallet.ts";
import {
  liveEddChecks,
  liveWoocommerceChecks,
  wordpressChaosBuyers,
  wordpressKind,
} from "./wordpress.ts";

// Re-run the harness's checks on a shop an earlier trial kept (`--keep`):
// the live checks, and the chaos phase, without another agent. This is how a
// new check is proved: it must fail on a shop running the release whose bug
// it targets and pass on the fixed one (trials/README.md, "Recheck").
//
//   npm run trial:recheck -- --dir /tmp/ortrial-node-… [--phases live,payer,leaks,chaos]
//
// The shop's wallet override is written again first, so a shop kept before
// the interceptor existed reaches the relay through it too.

const trialsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PHASES = ["live", "payer", "leaks", "chaos"] as const;
type Phase = (typeof PHASES)[number];

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
    if (!(PHASES as readonly string[]).includes(name)) {
      throw new Error(`Unknown phase "${name}". Phases: ${PHASES.join(", ")}`);
    }
  }
  return names as Phase[];
}

function print(checks: readonly Check[]): void {
  for (const item of checks) {
    console.log(`${item.pass ? "PASS" : "FAIL"} ${item.id}: ${item.summary}`);
    if (item.evidence !== undefined && (!item.pass || process.argv.includes("--verbose"))) {
      console.log(`     ${item.evidence.replaceAll("\n", "\n     ")}`);
    }
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const directory = value(argv, "--dir");
  if (directory === undefined || argv.includes("--help")) {
    console.log(
      "Usage: npm run trial:recheck -- --dir <kept shop directory> [--phases live,payer,leaks,chaos] [--verbose]",
    );
    return;
  }
  const phases = phasesOf(value(argv, "--phases"));
  const slug = slugOf(directory);
  const platform = JSON.parse(
    await readFile(path.join(trialsRoot, "platforms", slug, "platform.json"), "utf8"),
  ) as Platform;
  if (platform.host !== undefined) {
    throw new Error(
      `${slug} has its own live module (${platform.host}); recheck covers the framework and WordPress shops.`,
    );
  }
  const wordpress = wordpressKind(platform);
  const wallet = await startTrialWallet();
  const services = platform.wallet_services ?? [platform.service ?? "web"];
  // WP-CLI runs once per command; there is no container of it to start.
  await writeFile(walletOverrideFile(directory), trialWalletOverride(services, wallet));
  const service = platform.service ?? (wordpress === undefined ? "web" : "wordpress");
  await compose(directory, ["up", "-d", "--wait", service], 10 * 60_000);
  const baseUrl = `http://127.0.0.1:${await publishedPort(directory, service, containerPortOf(platform))}`;
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
  if (phases.includes("payer") && wordpress === undefined) {
    console.log(`payer: ${baseUrl}`);
    checks.push(
      ...(await payerWalkChecks({
        baseUrl,
        directory,
        platform,
        wallet,
        client: clientPrefix(directory),
        reportDir: path.join(trialsRoot, "reports", "recheck", path.basename(directory)),
      })),
    );
  }
  if (phases.includes("leaks")) checks.push(...(await debugPageChecks(directory, platform)));
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
          : { newBuyer: wordpressChaosBuyers(wordpress, directory, baseUrl), healthPath: "/" }),
      })),
    );
  }
  print(checks);
  if (checks.some((item) => item.severity === "blocker" && !item.pass)) process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
