import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  type ChaosBuyer,
  clientPrefix,
  fixtureBuyer,
  InterceptorControl,
  walletServices,
} from "./chaos.ts";
import { compose, walletOverrideFile } from "./docker.ts";
import { check } from "./live.ts";
import { slugOf } from "./recheck.ts";
import { containerPortOf, publishedPort } from "./sandbox.ts";
import type { Check, Platform } from "./types.ts";
import { startTrialWallet, trialWalletOverride } from "./wallet.ts";
import { wordpressChaosBuyers, wordpressKind } from "./wordpress.ts";

// R3 of a trial round: a shop an agent built runs for hours under a steady
// trickle of buyers while its relay misbehaves on a schedule, as a real shop's
// would. The chaos phase proves one recovery; a soak proves the hundredth, and
// watches for what only time shows: memory that grows, sockets or files that
// pile up, a process that slows.
//
//   npm run trial:soak -- --dir /tmp/ortrial-node-… [--minutes 120]
//
// One buyer every 2 minutes, and every invoice settled through the trial
// wallet. Each 20 minutes, a fault: the relay down for 45 s, then (10 minutes
// later) every handshake slowed to 3.2 s for 2 minutes. A checkout inside a
// fault or the 60 s after it may fail; every other one must not.

const trialsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const RELAY = "relay-nwc.rizful.com";
const BUYER_EVERY_MS = 2 * 60_000;
const FAULT_EVERY_MS = 20 * 60_000;
const GRACE_MS = 60_000;

interface Sample {
  readonly at: number;
  readonly memoryMiB: number;
  readonly fds: number;
}

interface Attempt {
  readonly at: number;
  readonly status: number;
  readonly ms: number;
  readonly inFault: boolean;
  readonly settled?: boolean;
}

function value(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Memory of the container (MiB) and the most file descriptors any one of its processes holds. */
async function sample(container: string): Promise<Sample> {
  const stats = await execFileAsync(
    "docker",
    ["stats", "--no-stream", "--format", "{{.MemUsage}}", container],
    { timeout: 30_000 },
  );
  const usage = stats.stdout.trim().split("/")[0]?.trim() ?? "";
  const number = Number.parseFloat(usage);
  const memoryMiB = /GiB/i.test(usage)
    ? number * 1024
    : /KiB/i.test(usage)
      ? number / 1024
      : number;
  const fds = await execFileAsync(
    "docker",
    [
      "exec",
      container,
      "sh",
      "-c",
      "for p in /proc/[0-9]*; do ls $p/fd 2>/dev/null | wc -l; done | sort -n | tail -1",
    ],
    { timeout: 30_000 },
  )
    .then((result) => Number.parseInt(result.stdout.trim(), 10))
    .catch(() => Number.NaN);
  return { at: Date.now(), memoryMiB, fds };
}

/** The mean of the first and of the last fifth of a series. */
export function drift(values: readonly number[]): { start: number; end: number } {
  const usable = values.filter((item) => Number.isFinite(item));
  const span = Math.max(1, Math.floor(usable.length / 5));
  const mean = (list: readonly number[]) =>
    list.length === 0 ? Number.NaN : list.reduce((sum, item) => sum + item, 0) / list.length;
  return { start: mean(usable.slice(0, span)), end: mean(usable.slice(-span)) };
}

/** The soak's verdicts from what it recorded. */
export function soakChecks(attempts: readonly Attempt[], samples: readonly Sample[]): Check[] {
  const outside = attempts.filter((attempt) => !attempt.inFault);
  const failed = outside.filter((attempt) => attempt.status !== 201 || attempt.settled === false);
  const memory = drift(samples.map((item) => item.memoryMiB));
  const fds = drift(samples.map((item) => item.fds));
  const slow = outside.filter((attempt) => attempt.status === 201).map((attempt) => attempt.ms);
  const latency = drift(slow);
  return [
    check(
      "soak_checkouts",
      outside.length > 0 && failed.length === 0,
      "Every checkout outside a fault (and the minute after it) got an invoice, and every invoice paid turned paid.",
      `${outside.length - failed.length} of ${outside.length} outside faults; ${attempts.length - outside.length} during faults` +
        (failed.length === 0
          ? ""
          : `\n${failed
              .slice(0, 5)
              .map(
                (item) =>
                  `${new Date(item.at).toISOString()} ${item.status} in ${item.ms} ms${item.settled === false ? ", never turned paid" : ""}`,
              )
              .join("\n")}`),
    ),
    check(
      "soak_memory_flat",
      Number.isFinite(memory.start) &&
        memory.end <= Math.max(memory.start * 1.5, memory.start + 64),
      "The shop's memory at the end was within 50% (or 64 MiB) of where it started.",
      `${memory.start.toFixed(0)} MiB → ${memory.end.toFixed(0)} MiB`,
    ),
    check(
      "soak_fds_flat",
      Number.isFinite(fds.start) && fds.end <= fds.start + 32,
      "No process in the shop's container held more than 32 more file descriptors (sockets included) at the end than at the start.",
      `${fds.start.toFixed(0)} → ${fds.end.toFixed(0)}`,
    ),
    {
      ...check(
        "soak_latency_flat",
        latency.end <= Math.max(latency.start * 2, latency.start + 1_000),
        "Checkouts at the end were no more than twice as slow as at the start.",
        `${latency.start.toFixed(0)} ms → ${latency.end.toFixed(0)} ms`,
      ),
      severity: "polish" as const,
    },
  ];
}

/**
 * A shop with `rateLimiting` on counts its last hour of invoices per address,
 * and a trial's live and chaos phases leave that hour full for the harness.
 * Wait it out, or the soak measures only the limiter.
 */
async function waitForInvoiceBudget(newBuyer: () => Promise<ChaosBuyer>): Promise<void> {
  const giveUp = Date.now() + 70 * 60_000;
  while (Date.now() < giveUp) {
    const answer = await (await newBuyer()).createOnce();
    if (answer.status !== 429) return;
    console.log(`${new Date().toISOString()} waiting: this address's last hour is still counted`);
    await sleep(BUYER_EVERY_MS);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dir = value(argv, "--dir");
  if (dir === undefined || argv.includes("--help")) {
    console.log("Usage: npm run trial:soak -- --dir <kept shop directory> [--minutes 120]");
    return;
  }
  const directory = path.resolve(dir);
  const minutes = Number(value(argv, "--minutes") ?? "120");
  const slug = slugOf(directory);
  const platform = JSON.parse(
    await readFile(path.join(trialsRoot, "platforms", slug, "platform.json"), "utf8"),
  ) as Platform;
  const wordpress = wordpressKind(platform);
  if (platform.host !== undefined)
    throw new Error(`${slug} has its own live module; soak covers framework and WordPress shops.`);
  const wallet = await startTrialWallet();
  const services = platform.wallet_services ?? [platform.service ?? "web"];
  await writeFile(walletOverrideFile(directory), trialWalletOverride(services, wallet));
  const service = platform.service ?? (wordpress === undefined ? "web" : "wordpress");
  await compose(directory, ["up", "-d", "--wait", service], 10 * 60_000);
  const baseUrl = `http://127.0.0.1:${await publishedPort(directory, service, containerPortOf(platform))}`;
  const container = `${clientPrefix(directory)}${walletServices(platform)[0] ?? service}-1`;
  const newBuyer: () => Promise<ChaosBuyer> =
    wordpress === undefined
      ? () => fixtureBuyer(baseUrl)
      : wordpressChaosBuyers(wordpress, directory, baseUrl);
  const control = new InterceptorControl(wallet.interceptor.control, clientPrefix(directory));
  await control.reset();
  await waitForInvoiceBudget(newBuyer);

  const started = Date.now();
  const end = started + minutes * 60_000;
  const attempts: Attempt[] = [];
  const samples: Sample[] = [];
  /** [from, to) windows where a fault (plus its grace) is in force. */
  const faults: [number, number][] = [];
  const inFault = (at: number) => faults.some(([from, to]) => at >= from && at < to);

  // Faults run on their own clock beside the buyers.
  const faulting = (async () => {
    let round = 0;
    while (Date.now() + FAULT_EVERY_MS / 2 < end) {
      await sleep(FAULT_EVERY_MS / 2);
      if (Date.now() >= end) break;
      const from = Date.now();
      if (round % 2 === 0) {
        console.log(`${new Date().toISOString()} fault: relay down for 45 s`);
        faults.push([from, from + 45_000 + GRACE_MS]);
        await control.rule(RELAY, "refuse", { forMs: 45_000 });
        await control.drop(RELAY);
      } else {
        console.log(`${new Date().toISOString()} fault: 3.2 s handshakes for 2 minutes`);
        faults.push([from, from + 120_000 + GRACE_MS]);
        await control.rule(RELAY, "pass", { delayMs: [3_200], forMs: 120_000 });
        await control.drop(RELAY);
      }
      round += 1;
    }
  })();

  while (Date.now() < end) {
    const at = Date.now();
    try {
      samples.push(await sample(container));
      const buyer = await newBuyer();
      const answer = await buyer.createOnce();
      let settled: boolean | undefined;
      const hash = answer.body.match(/"payment_hash"\s*:\s*"([0-9a-f]{64})"/)?.[1];
      if (answer.status === 201 && hash !== undefined) {
        await wallet.settle(hash);
        settled = false;
        for (let poll = 0; poll < 20 && settled === false; poll += 1) {
          await sleep(3_000);
          const checked = await buyer.checkPayment(hash);
          settled = /"status"\s*:\s*"settled"/.test(checked.body);
        }
      }
      attempts.push({ at, status: answer.status, ms: answer.ms, inFault: inFault(at), settled });
      const last = samples.at(-1);
      console.log(
        `${new Date(at).toISOString()} ${answer.status} in ${answer.ms} ms${settled === undefined ? "" : settled ? ", paid" : ", NOT paid"}${inFault(at) ? " (fault)" : ""}; ${last?.memoryMiB.toFixed(0)} MiB, ${last?.fds} fds`,
      );
    } catch (error) {
      attempts.push({ at, status: 0, ms: Date.now() - at, inFault: inFault(at) });
      console.log(`${new Date(at).toISOString()} error: ${String(error).slice(0, 200)}`);
    }
    await sleep(Math.max(0, BUYER_EVERY_MS - (Date.now() - at)));
  }
  await faulting;
  await control.reset();
  const checks = soakChecks(attempts, samples);
  const report = path.join(trialsRoot, "reports", "soak", `${path.basename(directory)}.json`);
  await mkdir(path.dirname(report), { recursive: true });
  await writeFile(
    report,
    `${JSON.stringify({ directory, minutes, attempts, samples, checks }, null, 2)}\n`,
  );
  for (const item of checks) {
    console.log(
      `${item.pass ? "PASS" : "FAIL"} ${item.id}: ${item.summary}\n     ${item.evidence ?? ""}`,
    );
  }
  console.log(`report ${report}`);
  if (checks.some((item) => item.severity === "blocker" && !item.pass)) process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
