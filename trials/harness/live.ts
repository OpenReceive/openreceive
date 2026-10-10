import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Check } from "./types.ts";

// The live checks every published shop gets, wherever it runs: it answers,
// a buyer's own order gets a real Lightning invoice, and a stranger asking for
// that order is refused. Nothing is paid.

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
 * Django, Rails and Laravel shops refuse a POST without the token; the others
 * ignore it.
 */
export class Visitor {
  private readonly cookies = new Map<string, string>();
  /** The last CSRF token a page carried, in a meta tag or a form field. */
  private token: string | undefined;

  constructor(
    private readonly base: string,
    private readonly retryDelayMs = 5_000,
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

  async page(pathname: string): Promise<string> {
    const response = await fetch(`${this.base}${pathname}`, { headers: this.cookieHeader() });
    this.remember(response);
    const html = await response.text();
    this.token = metaToken(html) ?? formToken(html)?.value ?? this.token;
    return html;
  }

  /** The shop's own order form: product 1, plus the form's CSRF field when it has one. */
  async placeOrder(): Promise<string> {
    const home = await this.page("/");
    const form = new URLSearchParams({ product_id: "1" });
    const token = formToken(home);
    if (token !== undefined) form.set(token.name, token.value);
    const response = await fetch(`${this.base}/orders`, {
      method: "POST",
      headers: { ...this.cookieHeader(), "content-type": "application/x-www-form-urlencoded" },
      body: form,
      redirect: "manual",
    });
    this.remember(response);
    // The fixture redirects to /orders/<id>; an integration may send the buyer
    // straight to its checkout page instead. Either way the id ends the path.
    const location = response.headers.get("location") ?? "";
    const id = new URL(location, this.base).pathname.match(/\/(\d+)\/?$/)?.[1];
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
  async createCheckout(
    reference: string,
    pagePath: string,
  ): Promise<{ status: number; body: string }> {
    let result = await this.post("/openreceive/checkouts", { reference }, pagePath);
    for (let retry = 0; retry < 2 && result.status === 503; retry += 1) {
      if (!/"retryable"\s*:\s*true/.test(result.body)) break;
      await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      result = await this.post("/openreceive/checkouts", { reference }, pagePath);
    }
    return result;
  }

  /** POST /openreceive/payments/check, as the checkout polls while the payer pays. */
  checkPayment(
    reference: string,
    paymentHash: string,
    pagePath: string,
  ): Promise<{ status: number; body: string }> {
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
  ): Promise<{ status: number; body: string }> {
    await this.page(pagePath);
    const headers: Record<string, string> = {
      ...this.cookieHeader(),
      "content-type": "application/json",
    };
    // Django reads X-CSRFToken, Rails and Laravel X-CSRF-Token; each accepts
    // its page's token there. Django also accepts its cookie's value.
    const token = this.token ?? this.cookies.get("csrftoken");
    if (token !== undefined) {
      headers["x-csrftoken"] = token;
      headers["x-csrf-token"] = token;
    }
    const laravel = this.cookies.get("XSRF-TOKEN");
    if (laravel !== undefined) headers["x-xsrf-token"] = decodeURIComponent(laravel);
    const response = await fetch(`${this.base}${route}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.text() };
  }
}

const FORM_TOKEN = /<input[^>]*name="(csrfmiddlewaretoken|_token|authenticity_token)"[^>]*>/i;

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

export interface LiveOptions {
  readonly retryDelayMs?: number;
  readonly paid?: PaidPath;
  /** How long the shop has to see the settlement. */
  readonly settleTimeoutMs?: number;
}

export async function liveShopChecks(base: string, options: LiveOptions = {}): Promise<Check[]> {
  const retryDelayMs = options.retryDelayMs ?? 5_000;
  const checks: Check[] = [];
  const health = await fetch(`${base}/health`)
    .then((response) => response.status)
    .catch(() => 0);
  checks.push(check("live_health", health === 200, "The shop answers GET /health.", `${health}`));

  try {
    const buyer = new Visitor(base, retryDelayMs);
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
          : `${own.status} ${bolt11.slice(0, 16)}…`,
      ),
    );
    // A second visitor with a session of their own, so a CSRF refusal cannot
    // pass for the host's authorize hook refusing them.
    const stranger = new Visitor(base, retryDelayMs);
    const theirs = await stranger.createCheckout(order, "/");
    checks.push(
      check(
        "live_refuses_stranger",
        [401, 403, 404].includes(theirs.status),
        "The shop refused a checkout for someone else's order.",
        `${theirs.status} ${theirs.body.slice(0, 200)}`,
      ),
    );
    const paymentHash = own.body.match(/"payment_hash"\s*:\s*"([0-9a-f]{64})"/)?.[1];
    if (options.paid !== undefined && paymentHash !== undefined) {
      checks.push(...(await paidChecks(buyer, order, page, paymentHash, options.paid, options)));
    }
  } catch (error) {
    checks.push(
      check("live_invoice", false, "The shop issued a Lightning invoice.", String(error)),
    );
  }
  return checks;
}

async function paidChecks(
  buyer: Visitor,
  order: string,
  page: string,
  paymentHash: string,
  paid: PaidPath,
  options: LiveOptions,
): Promise<Check[]> {
  await paid.settle(paymentHash);
  const deadline = Date.now() + (options.settleTimeoutMs ?? 60_000);
  let last = { status: 0, body: "" };
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
