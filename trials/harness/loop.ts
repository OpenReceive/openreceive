import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  blockersFailed,
  closingChecks,
  commandChecks,
  commandOutputCheck,
  containsSecret,
  evaluate,
  outputCheck,
  scopeViolation,
} from "./checks.ts";
import type { MerchantCodes } from "./codes.ts";
import type { AgentAdapter } from "./agents.ts";
import { cursorEnv, type SeenWrite } from "./cursor.ts";
import { compose, InfraError, shopComposeEnv } from "./docker.ts";
import { liveShopChecks } from "./live.ts";
import { localPublishChecks } from "./local-publish.ts";
import { classify, merchantReply } from "./merchant.ts";
import { redact } from "./redact.ts";
import { summaryMarkdown, writeRunReport } from "./report.ts";
import { inspectShop, orderStatus, prepareShop, shopChecks, startShop } from "./sandbox.ts";
import { scanTrackedSecrets } from "./scan.ts";
import type { Check, Platform, Scenario, Turn } from "./types.ts";
import { loadVercelConfig, vercelChecks, vercelCodeChecks } from "./vercel.ts";
import { type TrialWallet, trialWalletOverride } from "./wallet.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const trialsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PROMPT_BLOCK =
  /<!-- platform-prompt:begin -->\s*```text\n([\s\S]*?)\n```\s*<!-- platform-prompt:end -->/;

/** The first message: a guide's published prompt, or the platform's own template. */
export async function openingFor(platform: Platform, directionsUrl: string): Promise<string> {
  if (platform.opening_guide !== undefined) {
    const guide = await readFile(path.join(repoRoot, platform.opening_guide), "utf8");
    const prompt = guide.match(PROMPT_BLOCK)?.[1];
    if (prompt === undefined)
      throw new InfraError(`${platform.opening_guide} has no platform-prompt block.`);
    const published = /https:\/\/openreceive\.org\/agent-directions\/[a-z-]+(?:\/full)?\.md/g;
    const text = directionsUrl.startsWith("https://openreceive.org/")
      ? prompt
      : prompt.replace(published, directionsUrl);
    return [platform.opening_context, text].filter(Boolean).join(" ");
  }
  return (
    platform.opening?.replaceAll("{{directions_url}}", directionsUrl) ??
    `This is a ${platform.prompt_name}. Enable Bitcoin and stablecoin payments with OpenReceive. Follow these directions: ${directionsUrl}`
  );
}

export interface LoopRequest {
  readonly platform: Platform;
  readonly directionsUrl: string;
  readonly mode: string;
  readonly agent: AgentAdapter;
  readonly agentVersion: string;
  readonly model?: string;
  readonly keep: boolean;
  /** Deploy a Vercel shop to Vercel; otherwise it is checked where it runs, here. */
  readonly deploy?: boolean;
  readonly codes: MerchantCodes;
  /** The test wallet the codes belong to; it can pay an invoice. */
  readonly wallet?: TrialWallet;
  readonly registerStop?: (stop: () => Promise<void>) => void;
}

export interface LoopResult {
  readonly slug: string;
  readonly agent: string;
  /** The model the agent ran, or "default" for the CLI's own. */
  readonly model: string;
  readonly id: string;
  readonly elapsedMs: number;
  readonly ok: boolean;
  readonly infra: boolean;
  readonly message: string;
  readonly checks: readonly Check[];
}

function hide(text: string, uris: readonly string[]): string {
  return redact(text, uris);
}

function stayedInShop(turns: readonly Turn[], root: string): Check {
  const hit = turns
    .flatMap((turn) => turn.tools ?? [])
    .find((tool) => tool.type === "shell" && scopeViolation(tool.command, root) !== undefined);
  return {
    id: "stayed_in_shop",
    severity: "blocker",
    pass: hit === undefined,
    summary: "The agent did not read the OpenReceive checkout or credential files.",
    evidence: hit?.type === "shell" ? hit.command : undefined,
  };
}

function finishedCheck(done: boolean, reason: string): Check {
  return {
    id: "did_not_finish",
    severity: "blocker",
    pass: done,
    summary: done
      ? "The agent finished within the turn and time limits."
      : "The agent did not finish.",
    evidence: done ? undefined : reason,
  };
}

export async function runDirections(request: LoopRequest): Promise<LoopResult> {
  const { platform } = request;
  const fixture = path.join(trialsRoot, "platforms", platform.slug, "fixture");
  const seed = path.join(trialsRoot, "platforms", platform.slug, "seed");
  const platformCodes = platform.credential_store.kind === "platform";
  // The test wallet's code. On a hosting platform the codes are project
  // variables, so the shop has them from the start.
  const shopNwc = request.codes.nwc;
  const vercel =
    platform.deploy === "vercel" && request.deploy === true
      ? await loadVercelConfig(path.join(repoRoot, ".env"))
      : undefined;
  const directory = await prepareShop(
    fixture,
    platform.slug,
    {
      ...platform.platform_env,
      ...(platformCodes ? { NWC_URI: shopNwc, LSC_URI_PRIMARY: request.codes.lsc } : {}),
    },
    platform.service,
    // The test swap provider is the only part of the trial wallet the shop
    // reaches over the private network; the NWC relay is public.
    request.wallet === undefined || platform.swap_provider === "live"
      ? undefined
      : trialWalletOverride(
          platform.wallet_services ?? [platform.service ?? "wordpress"],
          request.wallet,
        ),
  );
  let sandbox: Awaited<ReturnType<typeof startShop>> | undefined;
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await sandbox?.stop(request.keep);
  };
  request.registerStop?.(stop);

  try {
    sandbox = await startShop(directory, seed, platform);
    const wallet = request.codes;
    const uris = [wallet.nwc, wallet.lsc, wallet.lscBackup, wallet.nwcVercel].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    const day = new Date().toISOString().slice(0, 10);
    const reportDir = path.join(
      trialsRoot,
      "reports",
      `${day}-${request.mode}`,
      platform.slug,
      request.agent.name,
      sandbox.id,
    );

    const pre = shopChecks(await inspectShop(directory, platform), platformCodes);
    const plain = pre.filter((check) => check.severity === "blocker" && check.pass === false);
    if (plain.length > 0) {
      const message = `plain shop failed: ${plain.map((check) => check.id).join(", ")}`;
      await writeRunReport({
        directory: reportDir,
        slug: platform.slug,
        agent: request.agent.name,
        model: request.model,
        id: sandbox.id,
        baseUrl: sandbox.baseUrl,
        directionsUrl: request.directionsUrl,
        agentVersion: request.agentVersion,
        elapsedMs: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
        toolNames: [],
        turns: [],
        rawStreams: [],
        checks: pre,
        uris,
      });
      return {
        slug: platform.slug,
        agent: request.agent.name,
        model: request.model ?? "default",
        id: sandbox.id,
        elapsedMs: 0,
        ok: false,
        infra: true,
        message,
        checks: pre,
      };
    }

    const scenario: Scenario = {
      id: "canonical",
      prompt: "",
      swaps: true,
      choice: "Yes, stablecoins too.",
    };
    const opening = await openingFor(platform, request.directionsUrl);
    console.log(`${sandbox.id} ${sandbox.baseUrl}`);
    console.log(`${sandbox.id} directions ${request.directionsUrl}`);

    const env = cursorEnv(process.env, shopComposeEnv(directory));
    const turns: Turn[] = [];
    const rawStreams: string[] = [];
    const writes: SeenWrite[] = [];
    const toolNames: string[] = [];
    const usage = { inputTokens: 0, outputTokens: 0 };
    let sessionId: string | undefined;
    let model = request.model;
    let nextPrompt = opening;
    let done = false;
    let reason = "";
    const started = Date.now();
    const budgetMs = platform.max_minutes * 60_000;

    for (let turn = 1; turn <= platform.max_turns; turn += 1) {
      const remaining = budgetMs - (Date.now() - started);
      if (remaining < 5_000) {
        reason = `stopped after ${platform.max_minutes} minutes`;
        break;
      }
      console.log(`${sandbox.id} cursor turn ${turn}`);
      const response = await request.agent.turn({
        workspace: directory,
        prompt: nextPrompt,
        resume: sessionId,
        model: request.model,
        timeoutMs: remaining,
        env,
      });
      if (response.sessionId !== undefined) sessionId = response.sessionId;
      if (model === undefined && response.model !== undefined) model = response.model;
      usage.inputTokens += response.usage.inputTokens;
      usage.outputTokens += response.usage.outputTokens;
      rawStreams.push(response.raw);
      writes.push(...response.writes);
      toolNames.push(...response.toolNames);
      turns.push({
        role: "agent",
        text: response.text,
        last: response.lastText,
        tools: response.tools,
      });
      const intent = classify(response.text);
      console.log(`${sandbox.id} merchant ${intent}`);
      if (sessionId === undefined) {
        reason = `${request.agent.label} did not return a session id`;
        break;
      }
      if (response.timedOut) {
        reason = "a turn timed out";
        break;
      }
      const reply = merchantReply(response.text, scenario, wallet, platformCodes);
      if (reply === null) {
        done = true;
        break;
      }
      if (containsSecret(reply, uris)) {
        console.log(`${sandbox.id} merchant pasted a code`);
      }
      turns.push({ role: "merchant", text: reply });
      nextPrompt = reply;
      if (turn === platform.max_turns) reason = `stopped after ${platform.max_turns} turns`;
    }

    const elapsedMs = Date.now() - started;
    const log = (line: string): void => console.log(`${sandbox?.id} ${hide(line, uris)}`);
    // The test wallet pays the buyer's invoice; the probe reads the shop's own order row.
    const paid =
      request.wallet === undefined
        ? undefined
        : {
            settle: request.wallet.settle,
            orderStatus: (orderId: string) => orderStatus(directory, platform, orderId),
          };
    const secret = await scanTrackedSecrets(directory, uris, writes);
    const checks = evaluate({
      scenario,
      platform,
      turns,
      nwc: shopNwc,
      lsc: wallet.lsc,
      lscBackup: wallet.lscBackup,
    }).map((check) => (check.id === "secret_not_tracked" ? secret : check));
    checks.push(stayedInShop(turns, repoRoot), finishedCheck(done, reason));
    checks.push(
      ...commandChecks(turns, writes),
      ...closingChecks(turns, platform.closing_max_lines ?? 5),
    );
    const secrets = [shopNwc, wallet.lsc, wallet.lscBackup].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    checks.push(
      platformCodes ? outputCheck(rawStreams, secrets) : commandOutputCheck(turns, secrets),
    );
    if (platform.deploy === "vercel" && vercel === undefined && done) {
      checks.push(...(await vercelCodeChecks(directory)));
    }
    if (
      (platform.live === true || (platform.deploy === "vercel" && vercel === undefined)) &&
      done
    ) {
      log("live: the shop's own order, a checkout, a stranger");
      const live = await liveShopChecks(sandbox.baseUrl, { paid });
      // A 500 page says nothing; the shop's own log says why.
      const logs = live.every((item) => item.pass)
        ? ""
        : await compose(
            directory,
            [
              ...(platform.logs ?? [
                "logs",
                "--no-color",
                "--tail",
                "40",
                platform.service ?? "web",
              ]),
            ],
            30_000,
          )
            .then((result) => `${result.stdout}\n${result.stderr}`.trim())
            .catch((error: unknown) => String(error));
      checks.push(
        ...live.map((item) =>
          item.pass ? item : { ...item, evidence: `${item.evidence ?? ""}\n${logs}`.trim() },
        ),
      );
    }
    if (vercel !== undefined && done) {
      checks.push(
        ...(await vercelChecks(directory, vercel, { nwc: shopNwc, lsc: wallet.lsc }, log)),
      );
    }
    if (platform.deploy === "local" && done) {
      checks.push(...(await localPublishChecks(directory, sandbox.baseUrl, log, paid)));
    }
    const redacted = checks.map((check) => ({
      ...check,
      evidence: check.evidence === undefined ? undefined : hide(check.evidence, uris),
      summary: hide(check.summary, uris),
    }));
    await writeRunReport({
      directory: reportDir,
      slug: platform.slug,
      agent: request.agent.name,
      id: sandbox.id,
      baseUrl: sandbox.baseUrl,
      directionsUrl: request.directionsUrl,
      agentVersion: request.agentVersion,
      model,
      elapsedMs,
      usage,
      toolNames,
      turns,
      rawStreams,
      checks: redacted,
      uris,
    });
    const failed = redacted.filter((check) => check.severity === "blocker" && check.pass === false);
    const message =
      failed.length === 0
        ? `${sandbox.id} passed`
        : `${sandbox.id}: ${failed.map((check) => `${check.id} (${check.evidence ?? check.summary})`).join("; ")}`;
    console.log(message);
    console.log(`report ${reportDir}`);
    return {
      slug: platform.slug,
      agent: request.agent.name,
      model: model ?? request.model ?? "default",
      id: sandbox.id,
      elapsedMs,
      ok: !blockersFailed(redacted),
      infra: false,
      message,
      checks: redacted,
    };
  } catch (error) {
    if (error instanceof InfraError) {
      return {
        slug: platform.slug,
        agent: request.agent.name,
        model: request.model ?? "default",
        id: sandbox?.id ?? path.basename(directory),
        elapsedMs: 0,
        ok: false,
        infra: true,
        message: error.message,
        checks: [],
      };
    }
    throw error;
  } finally {
    await stop();
    if (!request.keep) await request.agent.forget(directory);
  }
}

export function renderSummary(
  runs: readonly {
    readonly id: string;
    readonly elapsedMs?: number;
    readonly checks: readonly Check[];
  }[],
): string {
  return summaryMarkdown(runs);
}
