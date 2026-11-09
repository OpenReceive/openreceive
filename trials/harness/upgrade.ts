import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { type ChaosBuyer, fixtureBuyer } from "./chaos.ts";
import { compose, InfraError } from "./docker.ts";
import { check } from "./live.ts";
import { orderStatus, prepareShop, startShop } from "./sandbox.ts";
import { overlayFor } from "./scenarios.ts";
import type { Check, Platform, Scenario } from "./types.ts";
import { type TrialWallet, trialWalletOverride } from "./wallet.ts";

// A shop on an old release upgrades to the newest published one while an
// invoice is pending: the payment made across the upgrade must settle, and
// fulfillment must run exactly once. Published packages only: this installs
// from the registries, as a merchant's `npm install` does.

const execFileAsync = promisify(execFile);

const POLL_MS = 3_000;
const SETTLE_TIMEOUT_MS = 90_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const hashOf = (body: string) => body.match(/"payment_hash"\s*:\s*"([0-9a-f]{64})"/)?.[1];
const statusOf = (body: string) => body.match(/"status"\s*:\s*"([a-z_]+)"/)?.[1] ?? "";

export interface UpgradeInput {
  readonly directory: string;
  readonly platform: Platform;
  readonly baseUrl: string;
  readonly settle: (paymentHash: string) => Promise<void>;
  /** The newest published release; found on the registry when omitted. */
  readonly to?: string;
  readonly log?: (line: string) => void;
}

/** The shop's @openreceive packages from its package.json. */
export function openreceivePackages(manifest: {
  readonly dependencies?: Readonly<Record<string, string>>;
}): string[] {
  return Object.keys(manifest.dependencies ?? {}).filter(
    (name) => name === "openreceive" || name.startsWith("@openreceive/"),
  );
}

/** A dependency pinned to `version`, as package.json carries it. */
export function pinned(
  manifest: { readonly dependencies?: Readonly<Record<string, string>> },
  version: string,
): Record<string, string> {
  const deps = { ...manifest.dependencies };
  for (const name of openreceivePackages(manifest)) deps[name] = version;
  return deps;
}

/** The verdict on what the upgrade did. Pure: a test feeds it what a broken upgrade looks like. */
export function upgradeVerdict(seen: {
  readonly from: string;
  readonly to: string;
  readonly installedBefore: string;
  readonly installedAfter: string;
  readonly firstSettled: boolean;
  readonly firstOrder: string;
  readonly firstFulfillments: number | undefined;
  readonly secondSettled: boolean;
  readonly secondOrder: string;
  readonly newCheckout: number;
}): Check[] {
  const paidOnce =
    seen.firstSettled &&
    seen.firstOrder.length > 0 &&
    seen.firstOrder !== "awaiting_payment" &&
    (seen.firstFulfillments === undefined || seen.firstFulfillments === 1);
  return [
    check(
      "upgrade_started_on_the_old_release",
      seen.installedBefore === seen.from && seen.from !== seen.to,
      `The shop ran ${seen.from}, older than ${seen.to}, and took a checkout before the upgrade.`,
      `installed before: ${seen.installedBefore || "(unread)"}${seen.from === seen.to ? " (already the newest: nothing to upgrade)" : ""}`,
    ),
    check(
      "upgrade_installed_new_release",
      seen.installedAfter === seen.to,
      `After the upgrade the shop runs ${seen.to}.`,
      `installed after: ${seen.installedAfter || "(unread)"}`,
    ),
    check(
      "upgrade_pending_invoice_settled",
      seen.firstSettled,
      "The invoice minted on the old release settled after the upgrade.",
    ),
    check(
      "upgrade_paid_exactly_once",
      paidOnce,
      "The order turned paid, and fulfillment ran exactly once.",
      seen.firstFulfillments === undefined
        ? `order ${seen.firstOrder || "(unread)"}; this shop keeps no fulfillment count`
        : `order ${seen.firstOrder || "(unread)"}, fulfillments ${seen.firstFulfillments}`,
    ),
    check(
      "upgrade_second_pending_row_settles",
      seen.secondSettled && seen.secondOrder !== "awaiting_payment" && seen.secondOrder.length > 0,
      "A second invoice left pending across the upgrade also settled, and its order turned paid.",
      `settled ${seen.secondSettled}, order ${seen.secondOrder || "(unread)"}`,
    ),
    check(
      "upgrade_new_checkout_works",
      seen.newCheckout === 201,
      "On the new release, a new checkout gets an invoice.",
      String(seen.newCheckout),
    ),
  ];
}

async function installedVersion(directory: string, platform: Platform): Promise<string> {
  const service = platform.service ?? "web";
  const result = await compose(
    directory,
    [
      "exec",
      "-T",
      service,
      "node",
      "-e",
      "console.log(require('/app/node_modules/@openreceive/express/package.json').version)",
    ],
    60_000,
    { quiet: true },
  );
  return result.stdout.trim();
}

async function npm(args: readonly string[], cwd: string, timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync("npm", [...args], { cwd, timeout: timeoutMs });
  return stdout.trim();
}

async function newestPublished(): Promise<string> {
  return npm(["view", "@openreceive/express", "version"], process.cwd(), 60_000);
}

/** package.json to `version`, the lockfile to match, the image rebuilt, the shop restarted. */
async function moveTo(directory: string, platform: Platform, version: string): Promise<void> {
  const file = path.join(directory, "package.json");
  const manifest = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown> & {
    dependencies?: Record<string, string>;
  };
  await writeFile(
    file,
    `${JSON.stringify({ ...manifest, dependencies: pinned(manifest, version) }, null, 2)}\n`,
  );
  await npm(
    ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
    directory,
    180_000,
  );
  await compose(
    directory,
    ["up", "-d", "--build", "--wait", "--wait-timeout", "300", platform.service ?? "web"],
    15 * 60_000,
  );
}

async function fulfillments(
  directory: string,
  platform: Platform,
  reference: string,
): Promise<number | undefined> {
  const service = platform.service ?? "web";
  const result = await compose(
    directory,
    ["exec", "-T", service, "node", "bin/fulfillments.js", reference],
    60_000,
    { quiet: true },
  ).catch(() => undefined);
  if (result === undefined) return undefined;
  const count = Number(result.stdout.trim());
  return Number.isInteger(count) ? count : undefined;
}

async function settled(buyer: ChaosBuyer, hash: string): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < SETTLE_TIMEOUT_MS) {
    await sleep(POLL_MS);
    const answer = await buyer.checkPayment(hash);
    if (answer.status === 200 && statusOf(answer.body) === "settled") return true;
  }
  return false;
}

/** The upgrade, end to end, on a running shop still on its old release. */
export async function upgradeChecks(input: UpgradeInput): Promise<Check[]> {
  const log = input.log ?? (() => {});
  const { directory, platform, baseUrl } = input;
  const to = input.to ?? (await newestPublished());
  const from = await installedVersion(directory, platform);
  log(`upgrade: ${from} -> ${to}`);
  const installedBefore = from;

  // Two invoices minted on the old release, left pending across the upgrade.
  const firstBuyer = await fixtureBuyer(baseUrl);
  const secondBuyer = await fixtureBuyer(baseUrl);
  const first = await firstBuyer.createOnce();
  const second = await secondBuyer.createOnce();
  const firstHash = hashOf(first.body);
  const secondHash = hashOf(second.body);
  if (
    first.status !== 201 ||
    second.status !== 201 ||
    firstHash === undefined ||
    secondHash === undefined
  ) {
    return [
      check(
        "upgrade_started_on_the_old_release",
        false,
        `The shop ran ${from} and took a checkout before the upgrade.`,
        `first ${first.status}: ${first.body.slice(0, 160)}; second ${second.status}`,
      ),
    ];
  }

  log(`upgrade: moving to ${to}`);
  await moveTo(directory, platform, to);
  const installedAfter = await installedVersion(directory, platform);

  await input.settle(firstHash);
  const firstSettled = await settled(firstBuyer, firstHash);
  const firstOrder = firstSettled ? await orderStatus(directory, platform, firstBuyer.order) : "";
  // Extra passes over a settled row must not fulfil it again.
  for (let pass = 0; pass < 3; pass += 1) {
    await sleep(POLL_MS);
    await firstBuyer.checkPayment(firstHash);
  }
  const firstFulfillments = await fulfillments(directory, platform, firstBuyer.order);

  await input.settle(secondHash);
  const secondSettled = await settled(secondBuyer, secondHash);
  const secondOrder = secondSettled
    ? await orderStatus(directory, platform, secondBuyer.order)
    : "";

  const third = await fixtureBuyer(baseUrl);
  const newCheckout = (await third.createOnce()).status;
  log(`upgrade: settled ${firstSettled} ${secondSettled}, fulfillments ${firstFulfillments}`);
  return upgradeVerdict({
    from,
    to,
    installedBefore,
    installedAfter,
    firstSettled,
    firstOrder,
    firstFulfillments,
    secondSettled,
    secondOrder,
    newCheckout,
  });
}

/** The scenario that stands up a shop on an old release (trials/scenarios/old-version). */
const OLD_VERSION: Scenario = {
  id: "old-version",
  prompt: "",
  swaps: true,
  choice: "Yes, stablecoins too.",
  overlay: true,
};

/**
 * The Node shop as a 0.4.20-era merchant had it: the fixture plus the
 * quickstart's hooks, pinned to `from`, built and started on the trial wallet.
 */
export async function prepareOldNodeShop(
  fixtureDirectory: string,
  platform: Platform,
  wallet: TrialWallet,
  from: string,
): Promise<{ readonly directory: string; readonly baseUrl: string }> {
  if (platform.slug !== "node") throw new InfraError("The upgrade check is written for Express.");
  const directory = await prepareShop(
    fixtureDirectory,
    "node",
    { NWC_URI: wallet.nwc, LSC_URI_PRIMARY: wallet.lsc },
    "web",
    trialWalletOverride(["web"], wallet),
    undefined,
    overlayFor(OLD_VERSION, "node"),
  );
  const file = path.join(directory, "package.json");
  const manifest = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown> & {
    dependencies?: Record<string, string>;
  };
  await writeFile(
    file,
    `${JSON.stringify({ ...manifest, dependencies: pinned(manifest, from) }, null, 2)}\n`,
  );
  await npm(
    ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
    directory,
    180_000,
  );
  const sandbox = await startShop(directory, path.join(directory, "no-seed"), platform);
  return { directory, baseUrl: sandbox.baseUrl };
}
