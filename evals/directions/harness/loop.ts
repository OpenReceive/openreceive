import path from "node:path";
import { fileURLToPath } from "node:url";
import { blockersFailed, containsSecret, evaluate, scopeViolation } from "./checks.ts";
import type { MerchantCodes } from "./codes.ts";
import { agentTurn, cursorEnv, type SeenWrite } from "./cursor.ts";
import { InfraError } from "./docker.ts";
import { classify, merchantReply } from "./merchant.ts";
import { redact } from "./redact.ts";
import { summaryMarkdown, writeRunReport } from "./report.ts";
import { inspectShop, prepareShop, shopChecks, startShop } from "./sandbox.ts";
import { scanTrackedSecrets } from "./scan.ts";
import type { Check, Platform, Scenario, Turn } from "./types.ts";
import { loadVercelConfig, vercelChecks } from "./vercel.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const evalRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface LoopRequest {
  readonly platform: Platform;
  readonly directionsUrl: string;
  readonly mode: string;
  readonly agentVersion: string;
  readonly model?: string;
  readonly keep: boolean;
  readonly codes: MerchantCodes;
  readonly registerStop?: (stop: () => Promise<void>) => void;
}

export interface LoopResult {
  readonly id: string;
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
  const fixture = path.join(evalRoot, "platforms", platform.slug, "fixture");
  const seed = path.join(evalRoot, "platforms", platform.slug, "seed");
  const platformCodes = platform.credential_store.kind === "platform";
  // On a hosting platform the codes are project variables, so the shop has them from the start.
  const shopNwc = platformCodes
    ? (request.codes.nwcVercel ?? request.codes.nwc)
    : request.codes.nwc;
  const vercel =
    platform.deploy === "vercel" ? await loadVercelConfig(path.join(repoRoot, ".env")) : undefined;
  const directory = await prepareShop(fixture, platform.slug, {
    ...platform.platform_env,
    ...(platformCodes ? { NWC_URI: shopNwc, LSC_URI_PRIMARY: request.codes.lsc } : {}),
  });
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
      evalRoot,
      "reports",
      `${day}-${request.mode}`,
      platform.slug,
      "cursor",
      sandbox.id,
    );

    const pre = shopChecks(await inspectShop(directory, platform), platformCodes);
    const plain = pre.filter((check) => check.severity === "blocker" && check.pass === false);
    if (plain.length > 0) {
      const message = `plain shop failed: ${plain.map((check) => check.id).join(", ")}`;
      await writeRunReport({
        directory: reportDir,
        slug: platform.slug,
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
      return { id: sandbox.id, ok: false, infra: true, message, checks: pre };
    }

    const scenario: Scenario = {
      id: "canonical",
      prompt: "",
      swaps: true,
      choice: "Yes, stablecoins too.",
    };
    const opening =
      platform.opening?.replaceAll("{{directions_url}}", request.directionsUrl) ??
      `This is a ${platform.prompt_name}. Enable Bitcoin and stablecoin payments with OpenReceive. Follow these directions: ${request.directionsUrl}`;
    console.log(`${sandbox.id} ${sandbox.baseUrl}`);
    console.log(`${sandbox.id} directions ${request.directionsUrl}`);

    const env = cursorEnv();
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
      const response = await agentTurn({
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
      turns.push({ role: "agent", text: response.text, tools: response.tools });
      const intent = classify(response.text);
      console.log(`${sandbox.id} merchant ${intent}`);
      if (sessionId === undefined) {
        reason = "Cursor did not return a session id";
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
    if (vercel !== undefined && done) {
      checks.push(
        ...(await vercelChecks(directory, vercel, { nwc: shopNwc, lsc: wallet.lsc }, (line) =>
          console.log(`${sandbox?.id} ${hide(line, uris)}`),
        )),
      );
    }
    const redacted = checks.map((check) => ({
      ...check,
      evidence: check.evidence === undefined ? undefined : hide(check.evidence, uris),
      summary: hide(check.summary, uris),
    }));
    await writeRunReport({
      directory: reportDir,
      slug: platform.slug,
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
      id: sandbox.id,
      ok: !blockersFailed(redacted),
      infra: false,
      message,
      checks: redacted,
    };
  } catch (error) {
    if (error instanceof InfraError) {
      return {
        id: sandbox?.id ?? path.basename(directory),
        ok: false,
        infra: true,
        message: error.message,
        checks: [],
      };
    }
    throw error;
  } finally {
    await stop();
  }
}

export function renderSummary(
  runs: readonly { readonly id: string; readonly checks: readonly Check[] }[],
): string {
  return summaryMarkdown(runs);
}
