import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLiveWalletLock, loadMerchantCodes, type MerchantCodes } from "./codes.ts";
import { agentPool, pick } from "./agents.ts";
import { startTrialChain } from "./chain.ts";
import { dockerAvailable, InfraError } from "./docker.ts";
import type { LoopResult } from "./loop.ts";
import { renderSummary, runDirections } from "./loop.ts";
import type { Job } from "./pool.ts";
import { runPool } from "./pool.ts";
import { platformSummaryMarkdown } from "./report.ts";
import { startTrialWallet, type TrialWallet } from "./wallet.ts";
import { inspectShop, prepareShop, shopChecks, startShop } from "./sandbox.ts";
import { serveDirectory } from "./serve.ts";
import type { Check, Platform } from "./types.ts";

const trialsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(trialsRoot, "..");
const HEAVY_PARALLEL = 2;

function value(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1 || argv[index + 1] === undefined) return undefined;
  return argv[index + 1];
}

function help(): void {
  console.log(`Usage: npm run trial -- --platform woocommerce|node|fastify|next|vercel|replit|lovable|rails|django|fastapi|php|laravel|btcpay [--smoke] [--runs 1] [--parallel 1] [--keep]
       [--agent random|cursor|codex|claude|<a>,<b>] [--model <id>] [--directions-url <url> | --serve-directions]

Boots a plain shop in its own Compose project. Each run gets its own directory,
network, and published port, so --parallel can start several at once.
WordPress is heavy: at most ${HEAVY_PARALLEL} smoke stacks run together.
A trial pastes the codes of a test wallet (trials/wallet: a testkit NWC
wallet on a real relay, and a test swap provider), never the merchant's, and
the wallet pays the buyer's invoice so the trial can check the order turns
paid. --parallel runs trials together. Vercel deploys go one at a time: they
share one Vercel project and its database. Only one trial process runs at once.

--smoke              boot the shop, check that it is still plain, then tear it down
--serve-directions   give the agent this working tree's docs/agents file, on 127.0.0.1
--directions-url     give the agent this URL (default: the live openreceive.org file)
--agent              the coding agent for each trial; a list (or random, the default:
                     cursor,codex) picks one per trial. Claude Code only when named.
--model              the model, with a single --agent (Cursor default: grok-4.7-medium-fast;
                     list: agent --list-models; Codex and Claude: their CLI default)
--deploy             deploy a Vercel trial's shop to Vercel (default: check it where it runs)
--keep               leave the containers and the shop directory in place

Without --smoke, the agent integrates its own copy of the shop for each trial. That spends model usage and takes
several minutes. Reports land in trials/reports/ and are not committed.
Wallet codes are redacted there as <NWC> and <LSC>.
`);
}

/** The directions file as an agent would fetch it, hashed, so a badge can name what it tested. */
async function directionsHash(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new InfraError(`${url} answered ${response.status}`);
  return createHash("sha256")
    .update(await response.text())
    .digest("hex")
    .slice(0, 12);
}

async function releaseVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
    version: string;
  };
  return manifest.version;
}

async function platforms(requested: string): Promise<Platform[]> {
  const directory = path.join(trialsRoot, "platforms");
  const available = (await readdir(directory)).sort();
  const slugs = requested === "all" ? available : requested.split(",");
  const loaded: Platform[] = [];
  for (const slug of slugs) {
    if (!available.includes(slug)) {
      throw new Error(`Unknown platform "${slug}". Available: ${available.join(", ")}`);
    }
    const parsed = JSON.parse(
      await readFile(path.join(directory, slug, "platform.json"), "utf8"),
    ) as Platform;
    if (parsed.slug !== slug) throw new Error(`${slug}/platform.json says it is ${parsed.slug}`);
    loaded.push(parsed);
  }
  return loaded;
}

async function writeReport(
  slug: string,
  id: string,
  baseUrl: string,
  checks: readonly Check[],
): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const directory = path.join(trialsRoot, "reports", `${day}-smoke`, slug, id);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "result.json"),
    `${JSON.stringify({ slug, id, baseUrl, checks }, null, 2)}\n`,
  );
}

async function smokeOne(platform: Platform, keep: boolean): Promise<void> {
  const fixture = path.join(trialsRoot, "platforms", platform.slug, "fixture");
  const seed = path.join(trialsRoot, "platforms", platform.slug, "seed");
  const directory = await prepareShop(
    fixture,
    platform.slug,
    platform.platform_env,
    platform.service,
  );
  const sandbox = await startShop(directory, seed, platform);
  try {
    const evidence = await inspectShop(directory, platform);
    const checks = shopChecks(evidence);
    await writeReport(platform.slug, sandbox.id, sandbox.baseUrl, checks);
    const failed = checks.filter((item) => item.severity === "blocker" && item.pass === false);
    if (failed.length > 0) {
      throw new Error(
        `${platform.slug}: ${failed.map((item) => `${item.id} (${item.evidence ?? item.summary})`).join("; ")}`,
      );
    }
    console.log(`${sandbox.id} ${sandbox.baseUrl} plain shop ok`);
  } finally {
    await sandbox.stop(keep);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    help();
    return;
  }
  const requested = value(argv, "--platform");
  if (requested === undefined)
    throw new Error("--platform is required. Try: --platform woocommerce");
  const runs = Number(value(argv, "--runs") ?? "1");
  const parallel = Number(value(argv, "--parallel") ?? "1");
  if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
  if (!Number.isInteger(parallel) || parallel < 1)
    throw new Error("--parallel must be a positive integer");
  const keep = argv.includes("--keep");
  const deploy = argv.includes("--deploy");
  const smoke = argv.includes("--smoke");
  const pool = agentPool(value(argv, "--agent") ?? "random", value(argv, "--model"));
  const explicitUrl = value(argv, "--directions-url");
  const serve = argv.includes("--serve-directions");
  if (explicitUrl !== undefined && serve) {
    throw new Error("Pass either --directions-url or --serve-directions.");
  }
  await dockerAvailable();
  let codes: MerchantCodes | undefined;
  let wallet: TrialWallet | undefined;
  let releaseLock: (() => Promise<void>) | undefined;
  if (!smoke) {
    releaseLock = await acquireLiveWalletLock(path.join(trialsRoot, "reports"));
    // A trial never uses the merchant's wallet: the codes belong to the test
    // wallet, which can also pay the buyer's invoice.
    wallet = await startTrialWallet();
    codes = { nwc: wallet.nwc, lsc: wallet.lsc };
  }
  const selected = await platforms(requested);
  // BTCPay expects an NBXplorer; every BTCPay trial shares the trial chain's.
  if (!smoke && selected.some((platform) => platform.host === "btcpay")) await startTrialChain();
  // A Vercel deploy cannot reach the local test swap provider, and WordPress
  // does not trust its private CA: those shops get the real swap code.
  const liveSwap = (platform: Platform): boolean =>
    platform.swap_provider === "live" || (deploy && platform.deploy === "vercel");
  const liveLsc =
    !smoke && selected.some(liveSwap)
      ? (await loadMerchantCodes(path.join(repoRoot, ".env"))).lsc
      : undefined;
  const jobs: Job[] = [];
  const results: LoopResult[] = [];
  const stops: Array<() => Promise<void>> = [];
  const onStop = (): void => {
    void Promise.all(stops.map((stop) => stop()))
      .finally(() => releaseLock?.())
      .finally(() => process.exit(130));
  };
  if (!smoke) process.on("SIGINT", onStop);

  let served: Awaited<ReturnType<typeof serveDirectory>> | undefined;
  const agentVersions = new Map<string, string>();
  const directionsFor = new Map<string, { url: string; mode: string; sha256: string }>();
  try {
    served = serve ? await serveDirectory(path.resolve(trialsRoot, "../docs/agents")) : undefined;
    if (!smoke) {
      for (const { agent } of pool) agentVersions.set(agent.name, await agent.preflight());
    }

    for (const platform of selected) {
      const directionsSlug = platform.directions_slug ?? platform.slug;
      const directionsUrl =
        explicitUrl ??
        served?.fileUrl(`${directionsSlug}.md`) ??
        `https://openreceive.org/agent-directions/${directionsSlug}.md`;
      const mode =
        served === undefined && !directionsUrl.includes("127.0.0.1") ? "released" : "candidate";
      if (!smoke) {
        directionsFor.set(platform.slug, {
          url: directionsUrl,
          mode,
          sha256: await directionsHash(directionsUrl),
        });
      }
      for (let index = 0; index < runs; index += 1) {
        jobs.push({
          heavy: platform.heavy,
          // Every Vercel deploy goes to the one `openreceive-eval` project and wipes its database.
          serial: platform.deploy === "vercel" && deploy ? "vercel" : undefined,
          run: async () => {
            if (smoke) {
              await smokeOne(platform, keep);
              return;
            }
            if (codes === undefined) throw new InfraError("Wallet codes were not loaded.");
            const result = await runDirections({
              platform,
              directionsUrl,
              mode,
              ...(() => {
                const choice = pick(pool);
                return {
                  agent: choice.agent,
                  model: choice.model,
                  agentVersion: agentVersions.get(choice.agent.name) ?? "",
                };
              })(),
              keep,
              deploy,
              codes:
                liveSwap(platform) && liveLsc !== undefined ? { ...codes, lsc: liveLsc } : codes,
              wallet,
              registerStop: (stop) => stops.push(stop),
            });
            results.push(result);
            if (result.infra) throw new InfraError(result.message);
            if (!result.ok) throw new Error(result.message);
          },
        });
      }
    }
    try {
      await runPool(jobs, parallel, HEAVY_PARALLEL);
    } finally {
      if (!smoke && results.length > 0) {
        const day = new Date().toISOString().slice(0, 10);
        const mode =
          served === undefined && explicitUrl?.includes("127.0.0.1") !== true
            ? "released"
            : "candidate";
        const directory = path.join(trialsRoot, "reports", `${day}-${mode}`);
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, "summary.md"), renderSummary(results));
        // One file per platform, so a sweep run one platform at a time keeps them all.
        const release = await releaseVersion();
        for (const [slug, directions] of directionsFor) {
          const own = results.filter((result) => result.slug === slug);
          if (own.length === 0) continue;
          await mkdir(path.join(directory, slug), { recursive: true });
          await writeFile(
            path.join(directory, slug, "summary.md"),
            platformSummaryMarkdown({
              slug,
              day,
              mode: directions.mode,
              release,
              directionsUrl: directions.url,
              directions: directions.sha256,
              runs: own,
            }),
          );
        }
      }
    }
  } finally {
    process.off("SIGINT", onStop);
    await served?.close();
    await releaseLock?.();
  }
}

main().catch((error: unknown) => {
  if (error instanceof InfraError) {
    console.error(error.message);
    process.exit(2);
  }
  if (error instanceof AggregateError) {
    for (const item of error.errors) console.error(item instanceof Error ? item.message : item);
    const infra = error.errors.every((item) => item instanceof InfraError);
    process.exit(infra ? 2 : 1);
  }
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
