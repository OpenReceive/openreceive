import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Check } from "./types.ts";

// The live checks every published shop gets, wherever it runs: it answers,
// a buyer's own order gets a real Lightning invoice, a reload resumes it, and
// a stranger asking for that order is refused. On the trial wallet the buyer
// also pays, by Lightning and by a swap through the test provider.

export function check(id: string, pass: boolean, summary: string, evidence?: string): Check {
  return { id, severity: "blocker", pass, summary, evidence };
}

async function sourceFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if ([".git", ".next", ".vercel", "node_modules"].includes(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(full)));
    else if (/\.(?:[cm]?[jt]sx?|json)$/.test(entry.name)) found.push(full);
  }
  return found;
}

/** The agent's source files and their text, keyed by absolute path. */
export async function sourceTexts(directory: string): Promise<Map<string, string>> {
  const files = await sourceFiles(directory);
  return new Map(
    await Promise.all(files.map(async (file) => [file, await readFile(file, "utf8")] as const)),
  );
}

/**
 * One browser visitor: its own cookies, and the CSRF token a page hands it.
 * Django, Rails, Laravel and Flask-WTF shops refuse a POST without the token;
 * the others ignore it.
 */
export class Visitor implements CheckoutClient {
  private readonly cookies = new Map<string, string>();
  /** The last CSRF token a page carried, in a meta tag or a form field. */
  private token: string | undefined;
  /**
   * Every OpenReceive API answer this visitor got, retried ones included, so
   * a 503 the retry hid still shows (buyerErrorChecks).
   */
  readonly answers: RecordedAnswer[] = [];

  constructor(
    private readonly base: string,
    private readonly retryDelayMs = 5_000,
    /** Longer than any honest request; the chaos phase's silent wallet needs it bounded. */
    private readonly requestTimeoutMs = 60_000,
  ) {}

  private remember(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const [pair = ""] = header.split(";");
      const at = pair.indexOf("=");
      if (at > 0) this.cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
    }
  }

  private cookieHeader(): Record<string, string> {
    if (this.cookies.size === 0) return {};
    return { cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ") };
  }

  /**
   * What a browser sends with every POST from the shop's own page. SvelteKit
   * refuses a form POST without a matching Origin (its CSRF check), and so may
   * any framework an agent configures; a buyer's browser always sends one.
   */
  private browserOrigin(pagePath: string): Record<string, string> {
    return { origin: new URL(this.base).origin, referer: `${this.base}${pagePath}` };
  }

  async page(pathname: string): Promise<string> {
    const response = await fetch(`${this.base}${pathname}`, { headers: this.cookieHeader() });
    this.remember(response);
    const html = await response.text();
    this.token = metaToken(html) ?? formToken(html)?.value ?? this.token;
    return html;
  }

  /**
   * The shop's own order form, plus the form's CSRF field when it has one.
   * Every fixture seeds the same catalog: product 1 is the $7 Facet, product 2
   * the $12 Bezel.
   */
  async placeOrder(productId = 1): Promise<string> {
    const home = await this.page("/");
    const form = new URLSearchParams({ product_id: String(productId) });
    const token = formToken(home);
    if (token !== undefined) form.set(token.name, token.value);
    const response = await fetch(`${this.base}/orders`, {
      method: "POST",
      headers: {
        ...this.cookieHeader(),
        ...this.browserOrigin("/"),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form,
      redirect: "manual",
    });
    this.remember(response);
    // The fixture redirects to /orders/<id>; an integration may send the buyer
    // straight to its checkout page instead. Either way the id ends the path:
    // a number, or a uuid on a Supabase shop.
    const location = response.headers.get("location") ?? "";
    const id = new URL(location, this.base).pathname.match(
      /\/(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i,
    )?.[1];
    if (id === undefined) {
      throw new Error(`POST /orders answered ${response.status} without an order to go to`);
    }
    return id;
  }

  /**
   * POST /openreceive/checkouts the way the order page's checkout would. A
   * 503 the API marks retryable (a relay that timed out) is tried again, as
   * the browser checkout does, so a network blip is not a directions result.
   */
  async createCheckout(reference: string, pagePath: string): Promise<Answer> {
    let result = await this.createCheckoutOnce(reference, pagePath);
    for (let retry = 0; retry < 2 && result.status === 503; retry += 1) {
      if (!/"retryable"\s*:\s*true/.test(result.body)) break;
      await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      result = await this.createCheckoutOnce(reference, pagePath);
    }
    return result;
  }

  /** One POST /openreceive/checkouts, with no retry: what the chaos phase measures. */
  createCheckoutOnce(reference: string, pagePath: string): Promise<Answer> {
    return this.post("/openreceive/checkouts", { reference }, pagePath);
  }

  /** POST /openreceive/checkouts/prepare: the amount and the swap methods the picker shows. */
  prepareCheckout(reference: string, pagePath: string): Promise<Answer> {
    return this.post("/openreceive/checkouts/prepare", { reference }, pagePath);
  }

  /** POST /openreceive/swaps: the payer picked a pay-in asset in the swap picker. */
  createSwap(reference: string, payInAsset: string, pagePath: string): Promise<Answer> {
    return this.post("/openreceive/swaps", { reference, pay_in_asset: payInAsset }, pagePath);
  }

  /** POST /openreceive/swaps/status, as the swap view polls the provider. */
  swapStatus(reference: string, paymentHash: string, pagePath: string): Promise<Answer> {
    return this.post(
      "/openreceive/swaps/status",
      { reference, payment_hash: paymentHash },
      pagePath,
    );
  }

  /** The order page as a reload fetches it. */
  reload(pagePath: string): Promise<string> {
    return this.page(pagePath);
  }

  /** POST /openreceive/payments/check, as the checkout polls while the payer pays. */
  checkPayment(reference: string, paymentHash: string, pagePath: string): Promise<Answer> {
    return this.post(
      "/openreceive/payments/check",
      { reference, payment_hash: paymentHash },
      pagePath,
    );
  }

  private async post(
    route: string,
    body: Record<string, string>,
    pagePath: string,
  ): Promise<Answer> {
    await this.page(pagePath);
    const headers: Record<string, string> = {
      ...this.cookieHeader(),
      ...this.browserOrigin(pagePath),
      "content-type": "application/json",
    };
    // Django and Flask-WTF read X-CSRFToken, Rails and Laravel X-CSRF-Token;
    // each accepts its page's token there. Django also accepts its cookie's value.
    const token = this.token ?? this.cookies.get("csrftoken");
    if (token !== undefined) {
      headers["x-csrftoken"] = token;
      headers["x-csrf-token"] = token;
    }
    const laravel = this.cookies.get("XSRF-TOKEN");
    if (laravel !== undefined) headers["x-xsrf-token"] = decodeURIComponent(laravel);
    const started = performance.now();
    const response = await fetch(`${this.base}${route}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    }).catch((error: unknown) => error);
    if (!(response instanceof Response)) {
      // A request that hung or broke is what a buyer sees as a spinner that
      // never ends: status 0, kept in the record like any other answer.
      const answer = {
        status: 0,
        body: String(response),
        ms: Math.round(performance.now() - started),
      };
      this.answers.push({ route, ...answer });
      return answer;
    }
    const text = await response.text();
    const answer = {
      status: response.status,
      body: text,
      ms: Math.round(performance.now() - started),
    };
    this.answers.push({ route, ...answer });
    return answer;
  }
}

/** One answer as a visitor recorded it: the route, and the answer. */
export interface RecordedAnswer extends Answer {
  readonly route: string;
}

/**
 * A buyer never sees a wallet outage on a healthy day. A 503 the visitor
 * retried past still fails `live_no_buyer_503`: the payer would have seen the
 * error and pressed Try again (the maintainer's rule, 2026-11-07). Any other
 * 5xx, or a request that never answered, fails `live_no_server_error`.
 */
export function buyerAnswerChecks(answers: readonly RecordedAnswer[]): Check[] {
  const unavailable = answers.filter((answer) => answer.status === 503);
  const broken = answers.filter(
    (answer) => answer.status === 0 || (answer.status >= 500 && answer.status !== 503),
  );
  const listed = (list: readonly RecordedAnswer[]) =>
    list
      .slice(0, 5)
      .map(
        (answer) =>
          `${answer.route} ${answer.status} in ${answer.ms} ms: ${answer.body.slice(0, 160)}`,
      )
      .join("\n");
  return [
    check(
      "live_no_buyer_503",
      unavailable.length === 0,
      "No buyer request answered 503: the wallet was reachable for every checkout call.",
      unavailable.length === 0
        ? `${answers.length} answers`
        : `${unavailable.length} of ${answers.length} answers were 503\n${listed(unavailable)}`,
    ),
    check(
      "live_no_server_error",
      broken.length === 0,
      "No buyer request failed with a server error or went unanswered.",
      broken.length === 0
        ? `${answers.length} answers`
        : `${broken.length} of ${answers.length} answers\n${listed(broken)}`,
    ),
  ];
}

/** buyerAnswerChecks over every answer the visitors got. */
export function buyerErrorChecks(
  visitors: readonly { readonly answers: readonly RecordedAnswer[] }[],
): Check[] {
  return buyerAnswerChecks(visitors.flatMap((visitor) => visitor.answers));
}

/** One OpenReceive API answer, and how long the POST took (the page fetch before it excluded). */
export interface Answer {
  readonly status: number;
  readonly body: string;
  readonly ms: number;
}

/**
 * A buyer's checkout calls, as the page's checkout makes them. `Visitor`
 * sends the page's cookies to the shop's own routes; bolt.ts sends a bearer
 * token to a server function on another site. `pagePath` is the page the
 * call comes from, for a buyer whose session rides on it.
 */
export interface CheckoutClient {
  createCheckout(reference: string, pagePath: string): Promise<Answer>;
  prepareCheckout(reference: string, pagePath: string): Promise<Answer>;
  createSwap(reference: string, payInAsset: string, pagePath: string): Promise<Answer>;
  swapStatus(reference: string, paymentHash: string, pagePath: string): Promise<Answer>;
  checkPayment(reference: string, paymentHash: string, pagePath: string): Promise<Answer>;
}

// Django, Laravel, Rails, and Flask-WTF's field, in that order.
const FORM_TOKEN =
  /<input[^>]*name="(csrfmiddlewaretoken|_token|authenticity_token|csrf_token)"[^>]*>/i;

export function formToken(html: string): { name: string; value: string } | undefined {
  const input = html.match(FORM_TOKEN);
  const value = input?.[0].match(/value="([^"]*)"/i)?.[1];
  return input?.[1] === undefined || value === undefined ? undefined : { name: input[1], value };
}

export function metaToken(html: string): string | undefined {
  const meta = html.match(/<meta[^>]*name="csrf-token"[^>]*>/i)?.[0];
  return meta?.match(/content="([^"]*)"/i)?.[1];
}

/**
 * The paid path, on a trial wallet that can settle an invoice: the wallet
 * marks it paid, the shop's checkout poll sees it settled, and the shop's own
 * order row leaves `awaiting_payment`, which only the host's `onPaid` does.
 */
export interface PaidPath {
  readonly settle: (paymentHash: string) => Promise<void>;
  readonly orderStatus: (orderId: string) => Promise<string>;
}

/**
 * The swap path, on the trial wallet's test provider: the provider completes
 * the order as if the deposit arrived, the wallet settles the swap's invoice,
 * and the shop's own order must read paid.
 */
export interface SwapPath extends PaidPath {
  readonly complete: (bolt11: string) => Promise<void>;
}

export interface LiveOptions {
  readonly retryDelayMs?: number;
  readonly paid?: PaidPath;
  /** Only where the merchant gave the test provider's swap code. */
  readonly swap?: SwapPath;
  /** How long the shop has to see the settlement. */
  readonly settleTimeoutMs?: number;
  /** The merchant asked for Bitcoin only: the checkout must offer no swap method. */
  readonly bitcoinOnly?: boolean;
}

export async function liveShopChecks(base: string, options: LiveOptions = {}): Promise<Check[]> {
  const retryDelayMs = options.retryDelayMs ?? 5_000;
  const checks: Check[] = [];
  const health = await fetch(`${base}/health`)
    .then((response) => response.status)
    .catch(() => 0);
  checks.push(check("live_health", health === 200, "The shop answers GET /health.", `${health}`));
  const visitors: Visitor[] = [];
  const visitor = (): Visitor => {
    const made = new Visitor(base, retryDelayMs);
    visitors.push(made);
    return made;
  };

  try {
    const buyer = visitor();
    const order = await buyer.placeOrder();
    const page = `/orders/${order}`;
    const own = await buyer.createCheckout(order, page);
    const bolt11 = own.body.match(/"bolt11"\s*:\s*"(ln[a-z0-9]+)"/i)?.[1];
    checks.push(
      check(
        "live_invoice",
        own.status === 201 && bolt11 !== undefined,
        "The shop issued a Lightning invoice for the buyer's own order.",
        bolt11 === undefined
          ? `${own.status} ${own.body.slice(0, 300)}`
          : `${own.status} ${bolt11.slice(0, 16)}… in ${own.ms} ms`,
      ),
    );
    // A second visitor with a session of their own, so a CSRF refusal cannot
    // pass for the host's authorize hook refusing them.
    const stranger = visitor();
    const theirs = await stranger.createCheckout(order, "/");
    checks.push(
      check(
        "live_refuses_stranger",
        [401, 403, 404].includes(theirs.status),
        "The shop refused a checkout for someone else's order.",
        `${theirs.status} ${theirs.body.slice(0, 200)}`,
      ),
    );
    if (options.bitcoinOnly === true) checks.push(await bitcoinOnlyCheck(buyer, order, page));
    const paymentHash = own.body.match(/"payment_hash"\s*:\s*"([0-9a-f]{64})"/)?.[1];
    if (paymentHash !== undefined) {
      checks.push(await backToBackCheck(buyer, order, page, paymentHash));
      checks.push(await reloadCheck(buyer, order, page, paymentHash));
    }
    if (options.paid !== undefined && paymentHash !== undefined) {
      checks.push(...(await paidChecks(buyer, order, page, paymentHash, options.paid, options)));
    }
  } catch (error) {
    checks.push(
      check("live_invoice", false, "The shop issued a Lightning invoice.", String(error)),
    );
  }
  if (options.swap !== undefined) {
    try {
      checks.push(...(await swapChecks(visitor(), options.swap, options)));
    } catch (error) {
      checks.push(
        check("live_swap_paid", false, "The buyer paid an order by swap.", String(error)),
      );
    }
  }
  checks.push(...buyerErrorChecks(visitors));
  return checks;
}

/** The pay-in assets a prepare answer marks available. */
export function availableMethods(body: string): string[] {
  try {
    const parsed = JSON.parse(body) as {
      payment_methods?: { pay_in_asset: string; available: boolean }[];
    };
    return (parsed.payment_methods ?? [])
      .filter((method) => method.available)
      .map((method) => method.pay_in_asset);
  } catch {
    return [];
  }
}

/** A merchant who said "Bitcoin only" gets a checkout that offers no swap. */
async function bitcoinOnlyCheck(buyer: Visitor, order: string, page: string): Promise<Check> {
  const prepared = await buyer.prepareCheckout(order, page);
  const offered = prepared.status === 200 ? availableMethods(prepared.body) : [];
  return check(
    "live_bitcoin_only",
    prepared.status === 200 && offered.length === 0,
    "The merchant asked for Bitcoin only, and the checkout offers no swap pay-in method.",
    prepared.status === 200
      ? `swap methods on offer: ${offered.join(", ") || "none"}`
      : `${prepared.status} ${prepared.body.slice(0, 200)}`,
  );
}

/**
 * Every `reference` a page hands its checkout: the custom element's attribute,
 * or a React prop in the page's serialized payload (escaped quotes included).
 */
export function pageReferences(html: string): string[] {
  const found = new Set<string>();
  for (const match of html.matchAll(/\breference\\?"?\s*[:=]\s*\\?"([^"\\<>]{1,200})\\?"/g)) {
    if (match[1] !== undefined) found.add(match[1]);
  }
  return [...found].sort();
}

/**
 * A reload resumes the checkout: the order page loads again, its checkout
 * asks for the invoice again, and gets the one it had. Where the page names
 * its checkout's reference, the reload names the same one, so a page that
 * makes a new order on every load fails here even though each order would
 * get an invoice of its own.
 */
async function reloadCheck(
  buyer: Visitor,
  order: string,
  page: string,
  paymentHash: string,
): Promise<Check> {
  const first = pageReferences(await buyer.reload(page));
  const second = pageReferences(await buyer.reload(page));
  const again = await buyer.createCheckout(order, page);
  const hash = again.body.match(/"payment_hash"\s*:\s*"([0-9a-f]{64})"/)?.[1];
  const sameReference = first.join(",") === second.join(",");
  const sameInvoice = again.status === 201 && hash === paymentHash;
  const references =
    first.length === 0 ? "the page names no reference" : `references ${first.join(", ")}`;
  return check(
    "live_reload",
    sameReference && sameInvoice,
    "A reload of the order page resumed the same checkout: the same reference and the same invoice.",
    !sameReference
      ? `the reference changed on reload: ${first.join(", ") || "(none)"} then ${second.join(", ") || "(none)"}`
      : sameInvoice
        ? `${references}; same payment hash`
        : `${again.status} ${hash === undefined ? again.body.slice(0, 200) : `a new payment hash ${hash.slice(0, 12)}…`}`,
  );
}

/**
 * A checkout's requests come one after another: a reload asks for the
 * checkout, its state and the payment, each as soon as the last answered.
 * Every request first runs the reconcile pass behind a gate, and after a pass
 * the gate must stay shut for the requests that follow it. When it did not,
 * every request paid a full wallet scan of its own: 3 s a click and 15 s a
 * reload on the 0.4.24 PHP checkout. A payments/check that ran the scan
 * answers with the wallet's `details`; one the gate turned away answers from
 * the shop's row, without them.
 *
 * The gate opens again after its interval, 3 s while the invoice is young
 * (OPENRECEIVE_MIN_RECONCILE_INTERVAL_SECONDS). A shop that answers in tens of
 * milliseconds sends all four checks inside it; a server function that boots
 * a stack per request takes about a second each, so its fourth may rightly
 * scan again. A scan passes when it starts a full interval after the last.
 */
const GATE_INTERVAL_MS = 3_000;

export async function backToBackCheck(
  buyer: CheckoutClient,
  order: string,
  page: string,
  paymentHash: string,
): Promise<Check> {
  const answers: (Answer & { readonly at: number })[] = [];
  const first = performance.now();
  for (let request = 0; request < 4; request += 1) {
    const at = Math.round(performance.now() - first);
    answers.push({ ...(await buyer.checkPayment(order, paymentHash, page)), at });
  }
  const scanned = (answer: Answer) => /"details"\s*:/.test(answer.body);
  const scans = answers.filter(scanned);
  const gateHeld = scans.every(
    (scan, index) => index === 0 || scan.at - (scans[index - 1]?.at ?? 0) >= GATE_INTERVAL_MS,
  );
  return check(
    "live_one_scan_back_to_back",
    answers.every((answer) => answer.status === 200) && gateHeld,
    "Back-to-back payment checks ran at most one wallet scan per gate interval: the gate stayed shut after a scan.",
    answers
      .map((answer) =>
        answer.status !== 200
          ? `${answer.status} ${answer.body.slice(0, 120)}`
          : `+${answer.at} ms: ${answer.ms} ms${scanned(answer) ? " (scan)" : ""}`,
      )
      .join(", "),
  );
}

/**
 * The swap the guide promises: USDT on Solana, on the $12 product, because the
 * test provider prices BTC at a fixed $100,000 and takes at least 10 USDT.
 */
const SWAP_ASSET = "USDT_SOL";
export const SWAP_PRODUCT = 2;

async function swapChecks(buyer: Visitor, swap: SwapPath, options: LiveOptions): Promise<Check[]> {
  const order = await buyer.placeOrder(SWAP_PRODUCT);
  return swapOrderChecks(buyer, order, `/orders/${order}`, swap, options);
}

/** The swap checks on an order the buyer already placed: the $12.50 product, by SWAP_PRODUCT. */
export async function swapOrderChecks(
  buyer: CheckoutClient,
  order: string,
  page: string,
  swap: SwapPath,
  options: LiveOptions,
): Promise<Check[]> {
  const prepared = await buyer.prepareCheckout(order, page);
  const available = (() => {
    try {
      const body = JSON.parse(prepared.body) as {
        payment_methods?: { pay_in_asset: string; available: boolean }[];
      };
      return (body.payment_methods ?? [])
        .filter((method) => method.available)
        .map((method) => method.pay_in_asset);
    } catch {
      return [];
    }
  })();
  const methods = check(
    "live_swap_methods",
    prepared.status === 200 && available.length > 0,
    "The checkout offers swap pay-in methods from the test swap provider.",
    prepared.status === 200
      ? `available: ${available.join(", ") || "none"}`
      : `${prepared.status} ${prepared.body.slice(0, 200)}`,
  );
  const paidSummary = `A ${SWAP_ASSET} swap the provider completed settled in the wallet, and the shop's own order left awaiting_payment.`;
  if (!available.includes(SWAP_ASSET)) {
    return [methods, check("live_swap_paid", false, paidSummary, `${SWAP_ASSET} is not on offer`)];
  }
  const created = await buyer.createSwap(order, SWAP_ASSET, page);
  const paymentHash = created.body.match(/"payment_hash"\s*:\s*"([0-9a-f]{64})"/)?.[1];
  const bolt11 = created.body.match(/"bolt11"\s*:\s*"(ln[a-z0-9]+)"/i)?.[1];
  if (created.status !== 201 || paymentHash === undefined || bolt11 === undefined) {
    return [
      methods,
      check(
        "live_swap_paid",
        false,
        paidSummary,
        `${created.status} ${created.body.slice(0, 300)}`,
      ),
    ];
  }
  await swap.complete(bolt11);
  await swap.settle(paymentHash);
  const deadline = Date.now() + (options.settleTimeoutMs ?? 60_000);
  let last: Answer = { status: 0, body: "", ms: 0 };
  let settled = false;
  while (!settled && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? 4_000));
    // The swap view polls both: the provider's state, and the payment.
    await buyer.swapStatus(order, paymentHash, page);
    last = await buyer.checkPayment(order, paymentHash, page);
    settled = last.status === 200 && /"status"\s*:\s*"settled"/.test(last.body);
  }
  const status = settled ? await swap.orderStatus(order) : "";
  return [
    methods,
    check(
      "live_swap_paid",
      settled && status.length > 0 && status !== "awaiting_payment",
      paidSummary,
      settled
        ? `order ${order} status: ${status || "(unread)"}`
        : `not settled: ${last.status} ${last.body.slice(0, 300)}`,
    ),
  ];
}

export async function paidChecks(
  buyer: CheckoutClient,
  order: string,
  page: string,
  paymentHash: string,
  paid: PaidPath,
  options: LiveOptions,
): Promise<Check[]> {
  await paid.settle(paymentHash);
  const deadline = Date.now() + (options.settleTimeoutMs ?? 60_000);
  let last: Answer = { status: 0, body: "", ms: 0 };
  let settled = false;
  while (!settled && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? 4_000));
    last = await buyer.checkPayment(order, paymentHash, page);
    settled = last.status === 200 && /"status"\s*:\s*"settled"/.test(last.body);
  }
  const status = settled ? await paid.orderStatus(order) : "";
  return [
    check(
      "live_settled",
      settled,
      "After the wallet settled the invoice, the shop's checkout reported it paid.",
      settled ? undefined : `${last.status} ${last.body.slice(0, 300)}`,
    ),
    check(
      "live_order_paid",
      settled && status.length > 0 && status !== "awaiting_payment",
      "The shop's own order left awaiting_payment: onPaid is wired to the order.",
      `order ${order} status: ${status || "(unread)"}`,
    ),
  ];
}
