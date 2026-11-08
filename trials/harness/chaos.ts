import path from "node:path";
import { compose } from "./docker.ts";
import { type Answer, check, type PaidPath, Visitor } from "./live.ts";
import type { Check, Platform } from "./types.ts";
import type { TrialInterceptor } from "./wallet.ts";

// The chaos phase: after the agent finished and the live checks passed, the
// harness breaks the network under the shop the agent built and watches what
// a buyer gets. It needs no agent, so it costs machine time, not tokens.
//
// Every fault goes through the trial interceptor (trials/wallet/interceptor),
// which stands in for the NWC relay and the price feeds for this shop alone:
// its rules name this shop's Compose project, so a trial running beside it
// keeps a healthy network.
//
// Each step is one 2026-11-06 video bug, generalized:
//   slow handshakes   PHP gave a relay handshake 1 s; Rizful's took 3.24 s
//   flapping relay    busy public relays cut connections; each checkout reconnects
//   relay down        createStack kept its first failed boot for the process
//   silent wallet     the payer saw bare engine text and no way forward
//   relay down        (while running) the same, from a refused connection
//   price feed down   WooCommerce hid the gateway on one failed rate lookup
//   restart           an invoice minted before a restart still settles after

const RELAY = "relay-nwc.rizful.com";
const FEEDS = ["api.coingecko.com", "openreceive.org"] as const;
/** Eight handshakes from a shop container to Rizful's relay, measured 2026-11-06 (video 10). */
export const MEASURED_HANDSHAKES_MS = [600, 630, 650, 670, 720, 980, 1710, 3240] as const;
const HEALTH_TIMEOUT_MS = 3 * 60_000;
/** After the relay is back, a shop must take a checkout within this. */
const RECOVERY_BUDGET_MS = 60_000;
/** A wallet that never answers must still get the buyer an answer within this. */
const SILENT_ANSWER_BUDGET_MS = 30_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The interceptor prefix for a shop: its Compose project name, as Docker spells container names. */
export function clientPrefix(directory: string): string {
  return `${path.basename(directory).toLowerCase()}-`;
}

export type InterceptMode = "pass" | "refuse" | "silent";

/** The interceptor's control API, for one shop. */
export class InterceptorControl {
  constructor(
    private readonly control: string,
    readonly client: string,
  ) {}

  private async post(route: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(`${this.control}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`interceptor ${route} answered ${response.status}: ${text}`);
    return JSON.parse(text) as unknown;
  }

  rule(
    host: string,
    mode: InterceptMode,
    extra: { delayMs?: readonly number[]; closeAfterMs?: number; forMs?: number } = {},
  ): Promise<unknown> {
    return this.post("/rules", { client: this.client, host, mode, ...extra });
  }

  /** Cut this shop's open connections, so its next call must connect again. */
  drop(host?: string): Promise<unknown> {
    return this.post("/drop", { client: this.client, ...(host === undefined ? {} : { host }) });
  }

  reset(): Promise<unknown> {
    return this.post("/reset", { client: this.client });
  }

  async stats(): Promise<Record<string, Record<string, number>>> {
    const response = await fetch(
      `${this.control}/stats?client=${encodeURIComponent(this.client)}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    const body = (await response.json()) as { stats?: Record<string, Record<string, number>> };
    return body.stats ?? {};
  }
}

/** One buyer's fresh order, and that order's checkout calls, one request each. */
export interface ChaosBuyer {
  readonly order: string;
  /** POST the checkout's create, with no retry. */
  createOnce(): Promise<Answer>;
  checkPayment(paymentHash: string): Promise<Answer>;
  /** The shop's own order status (onPaid's work); undefined when the target's `paid` reads it. */
  status?(): Promise<string>;
}

export interface ChaosTarget {
  readonly directory: string;
  readonly platform: Platform;
  readonly baseUrl: string;
  readonly interceptor: TrialInterceptor;
  /** The trial wallet's settle and the shop's order status, for the restart step. */
  readonly paid?: PaidPath;
  readonly log?: (line: string) => void;
  /**
   * A fresh order and its checkout. Default: the framework fixture's order
   * form (`Visitor.placeOrder`); WordPress stores pass their own.
   */
  readonly newBuyer?: () => Promise<ChaosBuyer>;
  /** What a restart waits for; default `/health`. */
  readonly healthPath?: string;
}

/** The services that hold the shop's wallet connection: the ones a restart must restart. */
export function walletServices(platform: Platform): string[] {
  const named = platform.wallet_services ?? [platform.service ?? "web"];
  // WP-CLI and seed containers run once and exit; there is nothing to restart.
  return [...new Set(named)].filter((service) => service !== "cli" && service !== "seed");
}

async function healthy(baseUrl: string, healthPath: string, timeoutMs: number): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const status = await fetch(`${baseUrl}${healthPath}`, { signal: AbortSignal.timeout(5_000) })
      .then((response) => response.status)
      .catch(() => 0);
    if (status === 200) return Date.now() - started;
    await sleep(1_000);
  }
  throw new Error(`the shop did not answer GET ${healthPath} within ${timeoutMs / 1000} s`);
}

async function restartShop(target: ChaosTarget): Promise<number> {
  const services = walletServices(target.platform);
  await compose(target.directory, ["restart", ...services], 5 * 60_000);
  return healthy(target.baseUrl, target.healthPath ?? "/health", HEALTH_TIMEOUT_MS);
}

/** An API error a checkout can turn into a payer sentence: JSON with a code, not a 500 page. */
export function structuredError(answer: Answer): boolean {
  if (answer.status !== 503 && answer.status !== 504) return false;
  try {
    const body = JSON.parse(answer.body) as { error?: unknown; code?: unknown };
    const error = body.error as { code?: unknown } | string | undefined;
    return (
      typeof body.code === "string" ||
      typeof error === "string" ||
      (typeof error === "object" && error !== null && typeof error.code === "string")
    );
  } catch {
    return false;
  }
}

function brief(answer: Answer): string {
  // A 429 is the shop's own per-address limit (`rateLimiting`), met by the
  // harness's many orders from one address, not a wallet fault.
  const limited =
    answer.status === 429 ? " (the shop's rateLimiting cap on the harness's address)" : "";
  return `${answer.status} in ${answer.ms} ms${limited}${answer.status === 201 ? "" : `: ${answer.body.slice(0, 140)}`}`;
}

/** The framework fixture's buyer: its order form, then the order page's checkout. */
export async function fixtureBuyer(baseUrl: string): Promise<ChaosBuyer> {
  const buyer = new Visitor(baseUrl, 3_000, 75_000);
  const order = await buyer.placeOrder();
  const page = buyer.orderPage(order);
  return {
    order,
    createOnce: () => buyer.createCheckoutOnce(order, page),
    checkPayment: (paymentHash: string) => buyer.checkPayment(order, paymentHash, page),
  };
}

function newBuyer(target: ChaosTarget): Promise<ChaosBuyer> {
  return target.newBuyer?.() ?? fixtureBuyer(target.baseUrl);
}

/**
 * Eight checkouts, each on a fresh relay connection whose handshake takes the
 * next of the eight times measured from a shop container on 2026-11-06. A
 * shop that gives a handshake 1 s (PHP 0.4.31) or 3 s (@getalby/sdk's pool)
 * fails some of them.
 */
async function slowHandshakes(target: ChaosTarget, control: InterceptorControl): Promise<Check> {
  const summary =
    "With the relay's handshakes as slow as measured from a shop (0.6 s to 3.24 s), every checkout still got an invoice.";
  const rounds: string[] = [];
  let failed = 0;
  // One measured time per round, in order, so the 3.24 s handshake is tested
  // every run rather than when a random draw lands on it.
  for (let round = 0; round < MEASURED_HANDSHAKES_MS.length; round += 1) {
    const handshakeMs = MEASURED_HANDSHAKES_MS[round] ?? 0;
    await control.rule(RELAY, "pass", { delayMs: [handshakeMs] });
    await control.drop(RELAY);
    const buyer = await newBuyer(target);
    const answer = await buyer.createOnce();
    if (answer.status !== 201) failed += 1;
    rounds.push(`#${round + 1} handshake ${handshakeMs} ms: ${brief(answer)}`);
  }
  const stats = await control.stats();
  await control.reset();
  return check(
    "chaos_slow_handshakes",
    failed === 0,
    summary,
    `${failed} of ${rounds.length} failed\n${rounds.join("\n")}\ninterceptor: ${JSON.stringify(stats)}`,
  );
}

/**
 * The relay keeps cutting connections, as busy public relays do: every
 * connection lives 4 s. Four checkouts 5 s apart each land on a connection the
 * relay just cut or is about to cut, and all must get an invoice. Four, not
 * more: every round mints an invoice, and a shop with `rateLimiting` on takes
 * 60 an hour from one address, the harness's.
 */
async function flappingRelay(target: ChaosTarget, control: InterceptorControl): Promise<Check> {
  await control.rule(RELAY, "pass", { closeAfterMs: 4_000 });
  await control.drop(RELAY);
  const rounds: string[] = [];
  let failed = 0;
  for (let round = 0; round < 4; round += 1) {
    if (round > 0) await sleep(5_000);
    const buyer = await newBuyer(target);
    const answer = await buyer.createOnce();
    if (answer.status !== 201) failed += 1;
    rounds.push(`#${round + 1} ${brief(answer)}`);
  }
  const stats = await control.stats();
  await control.reset();
  return check(
    "chaos_relay_flaps",
    failed === 0,
    "With the relay cutting every connection after 4 s, every checkout still got an invoice.",
    `${failed} of ${rounds.length} failed\n${rounds.join("\n")}\ninterceptor: ${JSON.stringify(stats)}`,
  );
}

/**
 * The wallet's relay accepts the connection and then answers nothing. The
 * buyer must get a structured, retryable error in bounded time, not a 500
 * and not a request that hangs; once the relay answers again, a checkout works.
 */
async function silentWallet(target: ChaosTarget, control: InterceptorControl): Promise<Check[]> {
  const buyer = await newBuyer(target);
  await control.rule(RELAY, "silent");
  await control.drop(RELAY);
  const during = await buyer.createOnce();
  await control.reset();
  await control.drop(RELAY);
  const answered = check(
    "chaos_silent_wallet_answers",
    structuredError(during) && during.ms <= SILENT_ANSWER_BUDGET_MS,
    `With the wallet silent, the checkout answered a structured 503 within ${SILENT_ANSWER_BUDGET_MS / 1000} s, which the payer's checkout turns into a sentence and Try again.`,
    brief(during),
  );
  return [answered, await recovery("chaos_silent_wallet_recovers", buyer)];
}

/** Checkouts every 3 s on one order until one gets an invoice, within RECOVERY_BUDGET_MS. */
async function recovery(id: string, buyer: ChaosBuyer): Promise<Check> {
  const back = Date.now();
  const timeline: string[] = [];
  let recoveredMs: number | undefined;
  while (Date.now() - back < RECOVERY_BUDGET_MS) {
    const answer = await buyer.createOnce();
    timeline.push(`+${Math.round((Date.now() - back) / 1000)} s ${brief(answer)}`);
    if (answer.status === 201) {
      recoveredMs = Date.now() - back;
      break;
    }
    await sleep(3_000);
  }
  return check(
    id,
    recoveredMs !== undefined,
    `Once the relay answered again, a checkout got an invoice within ${RECOVERY_BUDGET_MS / 1000} s, with no restart.`,
    `${recoveredMs === undefined ? "never recovered" : `recovered after ${Math.round(recoveredMs / 1000)} s`}\n${timeline.join("\n")}`,
  );
}

/**
 * The relay goes down while the shop runs: its connection is cut and every
 * new one refused. The buyer gets a structured, retryable 503 at once, and a
 * checkout works again once the relay is back, with no restart.
 */
async function relayDownWhileRunning(
  target: ChaosTarget,
  control: InterceptorControl,
): Promise<Check[]> {
  const buyer = await newBuyer(target);
  await control.rule(RELAY, "refuse");
  await control.drop(RELAY);
  const during = await buyer.createOnce();
  await control.reset();
  const answered = check(
    "chaos_relay_down_answers_503",
    structuredError(during) && during.ms <= SILENT_ANSWER_BUDGET_MS,
    "With the relay down while the shop ran, the checkout answered a structured 503, which the payer's checkout turns into a sentence and Try again.",
    brief(during),
  );
  return [answered, await recovery("chaos_relay_down_recovers", buyer)];
}

/**
 * Both price feeds refuse. A checkout is fine from a cached rate (201), or
 * fails closed with a structured error; never a 500, never a hang.
 */
async function priceFeedDown(target: ChaosTarget, control: InterceptorControl): Promise<Check> {
  for (const host of FEEDS) await control.rule(host, "refuse");
  for (const host of FEEDS) await control.drop(host);
  const buyer = await newBuyer(target);
  const answer = await buyer.createOnce();
  await control.reset();
  return check(
    "chaos_price_feed_down",
    (answer.status === 201 || structuredError(answer)) && answer.ms <= SILENT_ANSWER_BUDGET_MS,
    "With both price feeds down, a checkout used a cached rate or failed closed with a structured error, never a 500 or a hang.",
    brief(answer),
  );
}

/**
 * The shop restarts while its relay is down, as after a deploy during a relay
 * blip. While the relay is down a checkout gets a structured 503; once the
 * relay is back, the same process must take a checkout without another
 * restart. 0.4.31's createStack kept the failed boot for the life of the process.
 */
async function relayDownAtStart(
  target: ChaosTarget,
  control: InterceptorControl,
): Promise<Check[]> {
  await control.rule(RELAY, "refuse");
  let buyer: ChaosBuyer;
  let during: Answer;
  try {
    await restartShop(target);
    buyer = await newBuyer(target);
    during = await buyer.createOnce();
  } finally {
    await control.reset();
  }
  const outage = check(
    "chaos_outage_answers_503",
    structuredError(during),
    "While the relay was down, the checkout answered a structured 503 (not a 500 or an HTML error page).",
    brief(during),
  );
  return [outage, await recovery("chaos_boot_recovers", buyer)];
}

/** An invoice minted before a restart settles after it, and the order turns paid. */
async function pendingAcrossRestart(target: ChaosTarget, paid: PaidPath): Promise<Check> {
  const summary =
    "An invoice minted before the shop restarted settled after it, and the shop's order turned paid.";
  const buyer = await newBuyer(target);
  let created = await buyer.createOnce();
  // One retry as the checkout's Try again would: this step is about the restart.
  if (created.status === 503) created = await buyer.createOnce();
  const hash = created.body.match(/"payment_hash"\s*:\s*"([0-9a-f]{64})"/)?.[1];
  if (created.status !== 201 || hash === undefined) {
    return check("chaos_pending_across_restart", false, summary, `before: ${brief(created)}`);
  }
  const restartMs = await restartShop(target);
  await paid.settle(hash);
  const started = Date.now();
  let last: Answer | undefined;
  while (Date.now() - started < 90_000) {
    await sleep(3_000);
    last = await buyer.checkPayment(hash);
    if (last.status === 200 && /"status"\s*:\s*"settled"/.test(last.body)) break;
  }
  const settled = last !== undefined && /"status"\s*:\s*"settled"/.test(last.body);
  const status = settled ? await (buyer.status?.() ?? paid.orderStatus(buyer.order)) : "";
  return check(
    "chaos_pending_across_restart",
    settled && status.length > 0 && status !== "awaiting_payment",
    summary,
    `restart took ${Math.round(restartMs / 1000)} s; ${settled ? `settled after ${Math.round((Date.now() - started) / 1000)} s, order ${buyer.order} ${status || "(unread)"}` : `not settled: ${last === undefined ? "no answer" : brief(last)}`}`,
  );
}

/**
 * Runs every step and returns one check (or two) per step. A step that throws
 * is a failed check with the error, and the next step still runs; the
 * interceptor's rules for this shop are cleared whatever happens.
 */
export async function chaosChecks(target: ChaosTarget): Promise<Check[]> {
  const control = new InterceptorControl(
    target.interceptor.control,
    clientPrefix(target.directory),
  );
  const log = target.log ?? (() => {});
  const checks: Check[] = [];
  const step = async (
    ids: readonly string[],
    run: () => Promise<Check | Check[]>,
  ): Promise<void> => {
    log(`chaos: ${ids.join(", ")}`);
    try {
      const result = await run();
      checks.push(...(Array.isArray(result) ? result : [result]));
    } catch (error) {
      for (const id of ids) {
        checks.push(check(id, false, "The chaos step ran.", String(error)));
      }
    } finally {
      await control.reset().catch(() => {});
    }
  };
  await control.reset();
  await step(["chaos_slow_handshakes"], () => slowHandshakes(target, control));
  await step(["chaos_relay_flaps"], () => flappingRelay(target, control));
  await step(["chaos_silent_wallet_answers", "chaos_silent_wallet_recovers"], () =>
    silentWallet(target, control),
  );
  await step(["chaos_relay_down_answers_503", "chaos_relay_down_recovers"], () =>
    relayDownWhileRunning(target, control),
  );
  await step(["chaos_price_feed_down"], () => priceFeedDown(target, control));
  await step(["chaos_outage_answers_503", "chaos_boot_recovers"], () =>
    relayDownAtStart(target, control),
  );
  const { paid } = target;
  if (paid !== undefined) {
    await step(["chaos_pending_across_restart"], () => pendingAcrossRestart(target, paid));
  }
  return checks;
}
