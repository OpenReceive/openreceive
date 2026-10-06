import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLiveWalletLock, loadMerchantCodes, type MerchantCodes } from "./codes.ts";
import { preflight } from "./cursor.ts";
import { dockerAvailable, InfraError } from "./docker.ts";
import type { LoopResult } from "./loop.ts";
import { renderSummary, runDirections } from "./loop.ts";
import type { Job } from "./pool.ts";
import { runPool } from "./pool.ts";
import { inspectShop, prepareShop, shopChecks, startShop } from "./sandbox.ts";
import { serveDirectory } from "./serve.ts";
import type { Check, Platform } from "./types.ts";

const evalRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(evalRoot, "../..");
const HEAVY_PARALLEL = 2;

function value(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1 || argv[index + 1] === undefined) return undefined;
  return argv[index + 1];
}

function help(): void {
  console.log(`Usage: npm run eval:directions -- --platform woocommerce [--smoke] [--runs 1] [--parallel 1] [--keep]
       [--directions-url <url> | --serve-directions] [--model <id>]

Boots a plain shop in its own Compose project. Each run gets its own directory,
network, and published port, so --parallel can start several at once.
WordPress is heavy: at most ${HEAVY_PARALLEL} smoke stacks run together.
A live run pastes NWC_URI and LSC_URI_PRIMARY from the repo-root .env and
refuses --parallel above 1, because those codes are one wallet.

--smoke              boot the shop, check that it is still plain, then tear it down
--serve-directions   give the agent this working tree's docs/agents file, on 127.0.0.1
--directions-url     give the agent this URL (default: the live openreceive.org file)
--model              Cursor model id (default: the account default)
--keep               leave the containers and the shop directory in place

Without --smoke, Cursor integrates the shop. That spends model usage and takes
several minutes. Reports land in evals/directions/reports/ and are not committed.
Wallet codes are redacted there as <NWC> and <LSC>.
`);
}

async function platforms(requested: string): Promise<Platform[]> {
  const directory = path.join(evalRoot, "platforms");
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
  const directory = path.join(evalRoot, "reports", `${day}-smoke`, slug, id);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "result.json"),
    `${JSON.stringify({ slug, id, baseUrl, checks }, null, 2)}\n`,
  );
}

async function smokeOne(platform: Platform, keep: boolean): Promise<void> {
  const fixture = path.join(evalRoot, "platforms", platform.slug, "fixture");
  const seed = path.join(evalRoot, "platforms", platform.slug, "seed");
  const directory = await prepareShop(fixture, platform.slug);
  const sandbox = await startShop(directory, seed);
  try {
    const evidence = await inspectShop(directory);
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
  const smoke = argv.includes("--smoke");
  const agent = value(argv, "--agent") ?? "cursor";
  if (!smoke && agent !== "cursor") {
    throw new Error(`Only the Cursor adapter is wired. Got --agent ${agent}.`);
  }
  const explicitUrl = value(argv, "--directions-url");
  const serve = argv.includes("--serve-directions");
  if (explicitUrl !== undefined && serve) {
    throw new Error("Pass either --directions-url or --serve-directions.");
  }
  const model = value(argv, "--model");
  if (!smoke && parallel !== 1) {
    throw new InfraError("Live wallet codes are one wallet. Re-run with --parallel 1.");
  }
  await dockerAvailable();
  let codes: MerchantCodes | undefined;
  let releaseLock: (() => Promise<void>) | undefined;
  if (!smoke) {
    codes = await loadMerchantCodes(path.join(repoRoot, ".env"));
    releaseLock = await acquireLiveWalletLock(path.join(evalRoot, "reports"));
  }
  const selected = await platforms(requested);
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
  let agentVersion = "";
  try {
    served = serve ? await serveDirectory(path.resolve(evalRoot, "../../docs/agents")) : undefined;
    if (!smoke) agentVersion = await preflight();

    for (const platform of selected) {
      const directionsUrl =
        explicitUrl ??
        served?.fileUrl(`${platform.slug}.md`) ??
        `https://openreceive.org/agent-directions/${platform.slug}.md`;
      const mode =
        served === undefined && !directionsUrl.includes("127.0.0.1") ? "released" : "candidate";
      for (let index = 0; index < runs; index += 1) {
        jobs.push({
          heavy: platform.heavy,
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
              agentVersion,
              model,
              keep,
              codes,
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
        const directory = path.join(evalRoot, "reports", `${day}-${mode}`);
        await mkdir(directory, { recursive: true });
        await writeFile(
          path.join(directory, "summary.md"),
          renderSummary(results.map((result) => ({ id: result.id, checks: result.checks }))),
        );
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
