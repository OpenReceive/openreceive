import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentAdapter } from "./agents.ts";
import { liveBoltChecks } from "./bolt.ts";
import { chaosChecks, clientPrefix } from "./chaos.ts";
import { asksPluginInstall, btcpayChecks, installPlugin, liveBtcpayChecks } from "./btcpay.ts";
import {
  blockersFailed,
  closingChecks,
  commandChecks,
  commandOutputCheck,
  containsSecret,
  evaluate,
  outputCheck,
  readPastCutCheck,
  scopeViolation,
} from "./checks.ts";
import type { MerchantCodes } from "./codes.ts";
import { cursorEnv, type SeenWrite } from "./cursor.ts";
import { compose, InfraError, shopComposeEnv } from "./docker.ts";
import { liveFossbillingChecks } from "./fossbilling.ts";
import { debugPageChecks } from "./leaks.ts";
import { donationWalkChecks, payerWalkChecks } from "./payer.ts";
import { check, liveShopChecks } from "./live.ts";
import { localPublishChecks } from "./local-publish.ts";
import { classify, GO_AHEAD, merchantReply } from "./merchant.ts";
import { liveMedusaChecks } from "./medusa.ts";
import { liveOdooChecks } from "./odoo.ts";
import { livePaymenterChecks } from "./paymenter.ts";
import { livePrestashopChecks } from "./prestashop.ts";
import { redact } from "./redact.ts";
import { scenarioFor } from "./scenarios.ts";
import { summaryMarkdown, writeRunReport } from "./report.ts";
import { inspectShop, orderStatus, prepareShop, shopChecks, startShop } from "./sandbox.ts";
import { scanTrackedSecrets } from "./scan.ts";
import { loadSupabaseProject, resetSupabase, supabaseChecks } from "./supabase.ts";
import type { Check, Platform, Scenario, Turn } from "./types.ts";
import { liveVendureChecks } from "./vendure.ts";
import {
  liveEddChecks,
  liveWoocommerceChecks,
  wordpressChaosBuyers,
  wordpressKind,
  wordpressPayerOrders,
} from "./wordpress.ts";
import { loadVercelConfig, vercelChecks, vercelCodeChecks } from "./vercel.ts";
import { type TrialWallet, trialWalletOverride } from "./wallet.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const trialsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PROMPT_BLOCK =
  /<!-- platform-prompt:begin -->\s*```text\n([\s\S]*?)\n```\s*<!-- platform-prompt:end -->/;

/** The first message: a guide's published prompt, or the platform's own template. */
/**
 * The agent said the same thing again without running anything: it is done,
 * whatever words it closed with. Without this, a closing the merchant script
 * does not recognize runs the trial to its turn limit.
 */
export function repeatedClosing(turns: readonly Turn[]): boolean {
  const agents = turns.filter((turn) => turn.role === "agent");
  const [before, last] = agents.slice(-2);
  if (before === undefined || last === undefined) return false;
  const words = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
  return (last.tools ?? []).length === 0 && words(last.text) === words(before.text);
}

export async function openingFor(
  platform: Platform,
  directionsUrl: string,
  scenario?: Scenario,
): Promise<string> {
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
  if (scenario?.opening !== undefined && platform.opening === undefined) {
    return scenario.opening
      .replaceAll("{{name}}", platform.prompt_name)
      .replaceAll("{{directions_url}}", directionsUrl);
  }
  return (
    platform.opening?.replaceAll("{{directions_url}}", directionsUrl) ??
    `This is a ${platform.prompt_name}. Enable Bitcoin and stablecoin payments with OpenReceive. Follow these directions: ${directionsUrl}`
  );
}

/** Asked after the trial is checked; the answer goes to friction.md, never into a check. */
export const FRICTION_QUESTION =
  "Thanks, that is everything I needed. One last question, and please do not run anything or change any files: what in the OpenReceive directions was wrong, missing or confusing while you did this? Answer in at most five short bullets, or say nothing was.";

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
  /** Run the chaos phase after the live checks (default true; `--no-chaos` turns it off). */
  readonly chaos?: boolean;
  /** Who the merchant is (scenarios.ts); canonical when omitted. */
  readonly scenario?: Scenario;
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

/**
 * The platform's own steps between the agent's last edit and a live visit,
 * each a compose command. A failure is a blocker with the command's output,
 * and the live checks still run so the report shows what a buyer would see.
 */
async function beforeLive(
  directory: string,
  platform: Platform,
  log: (line: string) => void,
): Promise<Check | undefined> {
  if (platform.before_live === undefined || platform.before_live.length === 0) return undefined;
  for (const args of platform.before_live) {
    log(`before live: docker compose ${args.join(" ")}`);
    const failure = await compose(directory, [...args], 10 * 60 * 1000)
      .then(() => undefined)
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    if (failure !== undefined)
      return {
        id: "before_live",
        severity: "blocker",
        pass: false,
        summary: "The platform's steps before going live succeeded.",
        evidence: `docker compose ${args.join(" ")}\n${failure}`,
      };
  }
  return {
    id: "before_live",
    severity: "blocker",
    pass: true,
    summary: "The platform's steps before going live succeeded.",
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
  const supabase = await loadSupabaseProject(platform);
  const directory = await prepareShop(
    fixture,
    platform.slug,
    {
      ...platform.platform_env,
      ...supabase?.env,
      // A Bitcoin-only merchant's project has no swap code to find.
      ...(platformCodes
        ? {
            NWC_URI: shopNwc,
            ...(request.scenario?.swaps === false ? {} : { LSC_URI_PRIMARY: request.codes.lsc }),
          }
        : {}),
    },
    platform.platform_env_service ?? platform.service,
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
    // The shop creates its own tables at start, on a project emptied first.
    if (supabase !== undefined) await resetSupabase(supabase);
    sandbox = await startShop(directory, seed, platform);
    const wallet = request.codes;
    const uris = [
      wallet.nwc,
      wallet.lsc,
      wallet.lscBackup,
      wallet.nwcVercel,
      supabase?.password,
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
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

    const scenario: Scenario = request.scenario ?? scenarioFor("canonical", 0);
    if (scenario.directionsCutAt !== undefined && !request.directionsUrl.includes("127.0.0.1")) {
      throw new InfraError("The directions-cut scenario needs --serve-directions.");
    }
    const opening = await openingFor(
      platform,
      scenario.directionsCutAt === undefined
        ? request.directionsUrl
        : `${request.directionsUrl}?cut=${scenario.directionsCutAt}`,
      scenario,
    );
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
      console.log(`${sandbox.id} ${request.agent.name} turn ${turn}`);
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
      let reply = merchantReply(response.text, scenario, wallet, platformCodes);
      if (reply === null || repeatedClosing(turns)) {
        done = true;
        break;
      }
      // BTCPay installs plugins only from its own UI, so the merchant does it when asked.
      if (platform.host === "btcpay" && asksPluginInstall(response.text)) {
        const installed = await installPlugin(directory);
        console.log(`${sandbox.id} merchant installed the plugin`);
        reply = reply === GO_AHEAD ? installed : `${installed} ${reply}`;
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
    // A swap too, when the merchant gave the test provider's code: never on a
    // live provider, which would want a real deposit.
    const swap =
      paid !== undefined &&
      request.wallet !== undefined &&
      scenario.swaps &&
      platform.swap_provider !== "live"
        ? { ...paid, complete: request.wallet.completeSwap }
        : undefined;
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
      ...commandChecks(turns, writes, platform.doctor !== ""),
      ...closingChecks(turns, platform.closing_max_lines ?? 5),
      ...(scenario.directionsCutAt === undefined ? [] : [readPastCutCheck(turns)]),
    );
    // BTCPay's health check is a page in its UI: read the store the agent configured instead.
    if (platform.host === "btcpay") checks.push(...(await btcpayChecks(directory, scenario.swaps)));
    const secrets = [shopNwc, wallet.lsc, wallet.lscBackup].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    checks.push(
      platformCodes ? outputCheck(rawStreams, secrets) : commandOutputCheck(turns, secrets),
    );
    // The test wallet's codes are throwaway; a real Supabase project's
    // password is the maintainer's, so it must not reach the agent at all.
    if (supabase !== undefined) {
      const leaked = rawStreams.some((raw) => containsSecret(raw, [supabase.password]));
      checks.push({
        id: "database_password_not_in_output",
        severity: "blocker",
        pass: !leaked,
        summary:
          "The database password never reached the agent: not in a command, its output, a message or its reasoning.",
        evidence: leaked ? "the password appeared in the agent's stream" : undefined,
      });
    }
    if (platform.deploy === "vercel" && vercel === undefined && done) {
      checks.push(...(await vercelCodeChecks(directory)));
    }
    if (
      (platform.live === true || (platform.deploy === "vercel" && vercel === undefined)) &&
      done
    ) {
      const prepared = await beforeLive(directory, platform, log);
      if (prepared !== undefined) checks.push(prepared);
      log("live: the shop's own order, a checkout, a stranger");
      const wordpress = wordpressKind(platform);
      // The donation merchant asked for /donate, not the shop's checkout: the
      // donation walk stands in for the live checks, the payer walk and chaos.
      const donation = scenario.kind === "donation";
      const live = donation
        ? request.wallet === undefined
          ? [check("donation_page", false, "The donation walk ran.", "no trial wallet")]
          : await donationWalkChecks({
              baseUrl: sandbox.baseUrl,
              directory,
              platform,
              wallet: request.wallet,
              client: clientPrefix(directory),
              reportDir,
            })
        : platform.host === "btcpay"
          ? await liveBtcpayChecks(directory, request.wallet?.settle)
          : platform.host === "bolt"
            ? await liveBoltChecks(directory, sandbox.baseUrl, { paid, ...(swap ? { swap } : {}) })
            : platform.host === "paymenter"
              ? await livePaymenterChecks(sandbox.baseUrl, { paid, ...(swap ? { swap } : {}) })
              : platform.host === "fossbilling"
                ? await liveFossbillingChecks(sandbox.baseUrl, { paid, ...(swap ? { swap } : {}) })
                : platform.host === "prestashop"
                  ? await livePrestashopChecks(sandbox.baseUrl, { paid, ...(swap ? { swap } : {}) })
                  : platform.host === "vendure"
                    ? await liveVendureChecks(directory, sandbox.baseUrl, {
                        paid,
                        ...(swap ? { swap } : {}),
                      })
                    : platform.host === "odoo"
                      ? await liveOdooChecks(sandbox.baseUrl, { paid, ...(swap ? { swap } : {}) })
                      : platform.host === "medusa"
                        ? await liveMedusaChecks(directory, sandbox.baseUrl, {
                            paid,
                            ...(swap ? { swap } : {}),
                          })
                        : wordpress !== undefined
                          ? await (wordpress === "edd" ? liveEddChecks : liveWoocommerceChecks)(
                              directory,
                              sandbox.baseUrl,
                              { paid, ...(swap ? { swap } : {}), bitcoinOnly: !scenario.swaps },
                            )
                          : await liveShopChecks(sandbox.baseUrl, {
                              paid,
                              ...(swap ? { swap } : {}),
                              bitcoinOnly: !scenario.swaps,
                            });
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
      // What the payer sees: the shop's own pages in Chromium, every state of
      // the checkout read for developer words, failures forced through the
      // interceptor and the test provider. The framework fixtures only.
      if (!donation && request.wallet !== undefined && platform.host === undefined) {
        log("payer: the checkout in Chromium, paid and failing");
        checks.push(
          ...(await payerWalkChecks({
            baseUrl: sandbox.baseUrl,
            directory,
            platform,
            wallet: request.wallet,
            client: clientPrefix(directory),
            reportDir,
            swaps: scenario.swaps && platform.swap_provider !== "live",
            ...(wordpress === undefined
              ? {}
              : { placeOrder: wordpressPayerOrders(wordpress, sandbox.baseUrl) }),
          })),
        );
      }
      // A framework's debug page can show the codes however well the agent
      // kept them out of its own code.
      checks.push(...(await debugPageChecks(directory, platform)));
      // The chaos phase needs the shop on the trial network, where the
      // interceptor stands in for its relay and price feeds.
      if (
        !donation &&
        request.chaos !== false &&
        platform.host === undefined &&
        request.wallet !== undefined &&
        platform.swap_provider !== "live"
      ) {
        log("chaos: the relay and price feeds fail under the shop");
        checks.push(
          ...(await chaosChecks({
            directory,
            platform,
            baseUrl: sandbox.baseUrl,
            interceptor: request.wallet.interceptor,
            paid,
            log,
            ...(wordpress === undefined
              ? {}
              : {
                  newBuyer: wordpressChaosBuyers(wordpress, directory, sandbox.baseUrl),
                  healthPath: "/",
                }),
          })),
        );
      }
    }
    if (supabase !== undefined && done) checks.push(await supabaseChecks(supabase));
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
    // One question after everything is checked, so its answer cannot change
    // what was checked: where the directions fell short. The 2026-11-06 video
    // agent's answer named three gaps its passing trial never showed.
    const friction =
      done && sessionId !== undefined
        ? await request.agent
            .turn({
              workspace: directory,
              prompt: FRICTION_QUESTION,
              resume: sessionId,
              model: request.model,
              timeoutMs: 5 * 60_000,
              env,
            })
            .then((response) => {
              usage.inputTokens += response.usage.inputTokens;
              usage.outputTokens += response.usage.outputTokens;
              const ran = response.tools.filter((tool) => tool.type !== "fetch").length;
              return `${response.lastText || response.text}${ran === 0 ? "" : `\n\n(The agent used ${ran} tool(s) while answering.)`}`;
            })
            .catch((error: unknown) => `(no answer: ${String(error)})`)
        : undefined;
    // Every service's whole log, kept with the report whatever the result: a
    // 5xx a buyer saw must be findable there, as a merchant would look for it.
    const shopLog = await compose(directory, ["logs", "--no-color", "--timestamps"], 60_000, {
      quiet: true,
    })
      .then((result) => `${result.stdout}\n${result.stderr}`.trim())
      .catch((error: unknown) => `docker compose logs failed: ${String(error)}`);
    await writeRunReport({
      directory: reportDir,
      slug: platform.slug,
      scenario: scenario.id,
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
    await writeFile(path.join(reportDir, "shop.log"), `${hide(shopLog, uris)}\n`);
    if (friction !== undefined) {
      await writeFile(
        path.join(reportDir, "friction.md"),
        `# What the agent says the directions got wrong\n\n> ${FRICTION_QUESTION}\n\n${hide(friction, uris)}\n`,
      );
    }
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
