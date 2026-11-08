import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { request } from "node:https";
import path from "node:path";
import type { Browser, Locator, Page } from "@playwright/test";
import { SWAP_PRODUCT } from "./live.ts";
import type { Check, Platform, Severity } from "./types.ts";
import type { TrialWallet } from "./wallet.ts";

// The payer's eye: a real browser walks the shop the way a buyer does, and
// the checks read what the checkout put on the screen, not the JSON behind
// it. The live checks (live.ts) prove the routes answer; they never saw the
// 0.4.32 video bugs: "Configured NWC relays are unavailable." as bare text
// with no way forward, a React checkout that showed nothing on a failed
// invoice, a paid screen that said "Backend settlement verified", and a swap
// breakdown whose first row read "Cart total" and once showed $48.99 on a
// $49.00 order.
//
// The walk fits the library-stack fixture: `/` lists the products, each with
// a form posting `product_id` to `/orders`, and the shop sends the buyer to a
// page where the agent mounted the checkout (`<openreceive-checkout>` or
// `@openreceive/react`). Every screen it reaches is saved under
// `<reportDir>/payer/` as a full-page screenshot and the checkout's visible
// text.

/** What the walk needs about the shop under trial. */
export interface PayerTarget {
  readonly baseUrl: string;
  /** The shop's copy, for the record; the walk reads nothing from it. */
  readonly directory: string;
  readonly platform: Platform;
  readonly wallet: TrialWallet;
  /**
   * The interceptor's client prefix for this shop: its Compose project name
   * plus "-", lowercased (`ortrial-django-25e3fc37-uektgl-`). Never "*":
   * other shops share the interceptor.
   */
  readonly client: string;
  readonly reportDir: string;
  /** False when the merchant gave no swap code: the swap steps are left out. True when omitted. */
  readonly swaps?: boolean;
  /**
   * How a buyer reaches the checkout for product 1 or 2 (SWAP_PRODUCT). The
   * framework fixtures' home-page form when omitted; a WordPress store places
   * the order through its own checkout and opens the order page
   * (wordpressPayerOrders in wordpress.ts).
   */
  readonly placeOrder?: (page: Page, productId: number) => Promise<PlacedOrder>;
}

/** Product 1 is the cheapest in every fixture; product 2 clears the test provider's minimum. */
const PRODUCT = 1;
/** The swap the guide promises, as live.ts makes it: USDT on Solana. */
const SWAP_COIN = "USDT";
const SWAP_NETWORK = "Solana";
/** fake-lsc's control port on 127.0.0.1, behind the trial CA (wallet.ts's FAKE_LSC). */
const FAKE_LSC = "https://127.0.0.1:17888";
/** The relay the trial wallet's code names, when the code cannot be read. */
const RELAY = "relay-nwc.rizful.com";
/** A Compose project prefix: lowercase, ending in "-", never a wildcard. */
const CLIENT_PREFIX = /^[a-z0-9][a-z0-9_.-]*-$/;

const PAGE_TIMEOUT_MS = 30_000;
const INVOICE_TIMEOUT_MS = 45_000;
const PAID_TIMEOUT_MS = 90_000;
/**
 * The checkout polls every 3 s (OPENRECEIVE_DEFAULT_POLL_INTERVAL_MS) and a
 * wallet scan waits for the reconcile gate's 3 s, so a healthy shop shows the
 * paid screen in well under 10 s.
 */
const PAID_POLISH_MS = 10_000;
const FAILURE_TIMEOUT_MS = 45_000;
const RECOVERY_TIMEOUT_MS = 30_000;
const SWAP_TIMEOUT_MS = 45_000;

// ---------------------------------------------------------------- pure helpers

/**
 * Words a payer must never read: the engine's own vocabulary, a server's
 * crash, text written for the developer, and a value JavaScript failed to
 * format. "swap service" is fine on
 * the page (the wallet list names Boltz and FixedFloat that way); only the
 * videos avoid it.
 */
const BANNED: readonly (readonly [string, RegExp])[] = [
  ["NWC", /\bNWC\b/i],
  ["nostr", /nostr/i],
  ["relay", /\brelay/i],
  ["backend", /\bback-?end\b/i],
  ["settlement verified", /settlement\s+verified/i],
  // The engine's own words for a paid invoice (2026-11-08 reviews).
  ["settled", /\bsettled\b/i],
  ["settlement", /\bsettlement\b/i],
  ["Internal server error", /internal\s+server\s+error/i],
  ["exception", /exceptions?\b/i],
  ["traceback", /\btraceback\b/i],
  // A crash's class name: TypeError, RuntimeError, Nip47NetworkError.
  ["error class", /\b(?:[A-Z][a-z0-9]+)+Error\b/],
  ["undefined", /\bundefined\b/i],
  ["NaN", /\bNaN\b/],
  ["[object Object]", /\[object Object\]/],
  ["null", /\bnull\b/i],
  // Text the server wrote for the shop's developer (2026-11-08 trials: a
  // PrestaShop payer read the handler's 403, "The application's authorize hook
  // denied it; … check that the payer's session reaches the checkout routes").
  // Phrases, not the words: "hook", "session" and "route" are ordinary on a
  // shop page.
  ["authorize hook", /\bauthori[sz]e\s+hook\b/i],
  ["hook denied", /\bhook\s+denied\b/i],
  ["payer's session", /\bpayer['’]?s\s+session\b/i],
  ["checkout routes", /\bcheckout\s+routes?\b/i],
  ["payer instructions", /\bpayer\s+instructions\b/i],
  ["docs link", /openreceive\.org\/guides/i],
  // A wire field name: "payment_hash is required.", "pay_in_asset".
  ["field name", /\b(?:payment_hash|pay_in_asset|amount_msats|swap_data|bolt11)\b/],
  // A bare error code. Capitals only, and only the codes that are no English
  // word in capitals a heading could show: INTERNAL, TIMEOUT, OTHER and
  // RESTRICTED are left out, since CSS can capitalize an ordinary "Other" or
  // "Restricted content".
  [
    "error code",
    /\b(?:FORBIDDEN|UNAUTHORIZED|CONFLICT|NOT_FOUND|INVALID_REQUEST|RATE_LIMITED|QUOTA_EXCEEDED|WALLET_UNAVAILABLE|INVOICE_EXPIRED|UNSUPPORTED_METHOD|UNSUPPORTED_ENCRYPTION|NOT_IMPLEMENTED)\b/,
  ],
];

/** The banned terms `text` contains, in the list's order. */
export function bannedPayerWords(text: string): string[] {
  return BANNED.filter(([, pattern]) => pattern.test(text)).map(([term]) => term);
}

/** Each banned term with the words around it, for evidence. */
export function bannedPayerWordsInContext(text: string): string[] {
  const flat = text.replace(/\s+/g, " ");
  return BANNED.flatMap(([term, pattern]) => {
    const at = flat.search(pattern);
    if (at < 0) return [];
    const start = Math.max(0, at - 40);
    const snippet = flat.slice(start, at + 60).trim();
    return [`${term}: "${start > 0 ? "…" : ""}${snippet}${at + 60 < flat.length ? "…" : ""}"`];
  });
}

const AMOUNT = String.raw`(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?!\.?\d)`;
const MONEY = [
  new RegExp(String.raw`(?:US)?\$\s?${AMOUNT}`),
  new RegExp(String.raw`\bUSD\s?${AMOUNT}`),
  new RegExp(String.raw`(?<![\d.,])${AMOUNT}\s?USD\b`),
];

/**
 * The first US-dollar amount in `text`, in whole cents: "$7.00", "$1,234.5",
 * "US$7", "USD 7" and "7.00 USD" all read. Integer math only.
 */
export function parsePriceCents(text: string): number | undefined {
  let best: RegExpExecArray | undefined;
  for (const pattern of MONEY) {
    const match = pattern.exec(text);
    if (match !== null && (best === undefined || match.index < best.index)) best = match;
  }
  if (best?.[1] === undefined) return undefined;
  const whole = Number.parseInt(best[1].replaceAll(",", ""), 10);
  const cents = best[2] === undefined ? 0 : Number.parseInt(best[2].padEnd(2, "0"), 10);
  return whole * 100 + cents;
}

/**
 * The fiat amount a checkout screen shows. The invoice screen pairs it with
 * the sats ("9,244 sats / $7.00 USD"); that pair wins over any other amount.
 */
export function checkoutFiatCents(text: string): number | undefined {
  const pair = /\bsats?\s*\/\s*/i.exec(text);
  if (pair !== null) {
    const after = parsePriceCents(text.slice(pair.index + pair[0].length, pair.index + 80));
    if (after !== undefined) return after;
  }
  return parsePriceCents(text);
}

export function formatCents(cents: number): string {
  const whole = Math.trunc(cents / 100).toLocaleString("en-US");
  return `$${whole}.${String(Math.abs(cents % 100)).padStart(2, "0")}`;
}

/** What a paid screen says, in a payer's words. */
const PAID = /payment received|\bpaid\b|payment (?:is )?confirmed|thank you/i;

/** True when `text` says the payment went through. */
export function saysPaid(text: string): boolean {
  return PAID.test(text);
}

/** The lines that say paid, and the line after each, for evidence. */
function paidLines(text: string): string {
  const lines = text.split("\n");
  const picked = new Set<number>();
  lines.forEach((line, index) => {
    if (PAID.test(line)) {
      picked.add(index);
      if (index + 1 < lines.length) picked.add(index + 1);
    }
  });
  return [...picked]
    .sort((a, b) => a - b)
    .map((index) => lines[index])
    .join(" / ");
}

/** A sentence has at least three words and a letter. */
export function isPayerSentence(text: string): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length >= 3 && /[a-z]/i.test(text);
}

/**
 * The relay host names in an NWC code (its `relay` parameters), without the
 * rest of the code: it never reaches evidence.
 */
export function relayHostsOf(nwc: string): string[] {
  try {
    return new URL(nwc).searchParams
      .getAll("relay")
      .map((relay) => new URL(relay).hostname.toLowerCase())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// --------------------------------------------------------- in-page scripts
// Strings, not functions: tsx keeps function names with a `__name` helper
// that does not exist in the page.

const PAGE_HELPERS = String.raw`
  const visible = (el) =>
    typeof el.checkVisibility !== "function" ||
    el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const everyElement = (root) => {
    const found = [];
    const visit = (node) => {
      for (const el of node.querySelectorAll("*")) {
        found.push(el);
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    if (root.shadowRoot) visit(root.shadowRoot);
    visit(root);
    return found;
  };
  const checkoutRoots = () => {
    const all = everyElement(document);
    const elements = all.filter((el) => el.localName === "openreceive-checkout");
    if (elements.length > 0) return elements;
    const marked = all.filter(
      (el) => el.hasAttribute("data-openreceive-root") || el.hasAttribute("data-openreceive-checkout"),
    );
    return marked.filter((el) => !marked.some((other) => other !== el && other.contains(el)));
  };
  const INLINE = new Set(["inline", "inline-block", "inline-flex", "inline-grid", "contents"]);
  const rendered = (text) => {
    const range = document.createRange();
    range.selectNodeContents(text);
    return range.getClientRects().length > 0;
  };
  const textOf = (root) => {
    const parts = [];
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.data.trim() !== "" && rendered(node)) parts.push(node.data);
        return;
      }
      if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
        for (const child of node.childNodes) walk(child);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (["STYLE", "SCRIPT", "TEMPLATE", "NOSCRIPT"].includes(node.tagName)) return;
      if (node.localName === "slot") {
        const assigned = node.assignedNodes({ flatten: true });
        for (const child of assigned.length > 0 ? assigned : node.childNodes) walk(child);
        return;
      }
      const display = getComputedStyle(node).display;
      if (display === "none") return;
      if (display !== "contents" && !visible(node)) return;
      const block = !INLINE.has(display);
      if (block) parts.push("\n");
      for (const child of (node.shadowRoot ?? node).childNodes) walk(child);
      if (block) parts.push("\n");
    };
    walk(root);
    return parts
      .join("")
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("\n");
  };
`;

/** The checkout's own visible text (not the host page's), and the page's for the paid fallback. */
const READ_CHECKOUT = String.raw`(() => {
  ${PAGE_HELPERS}
  const roots = checkoutRoots();
  return {
    present: roots.length > 0,
    text: roots.map(textOf).join("\n"),
    page: document.body ? document.body.innerText : "",
  };
})()`;

/** Every visible label/value row of the checkout's definition lists (the swap breakdown). */
const DETAIL_ROWS = String.raw`(() => {
  ${PAGE_HELPERS}
  const rows = [];
  for (const root of checkoutRoots()) {
    for (const dt of everyElement(root)) {
      if (dt.localName !== "dt" || !visible(dt)) continue;
      const dd = dt.nextElementSibling;
      rows.push([
        dt.textContent.replace(/\s+/g, " ").trim(),
        dd && dd.localName === "dd" ? dd.textContent.replace(/\s+/g, " ").trim() : "",
      ]);
    }
  }
  return rows;
})()`;

/**
 * The text around one product's order form on the listing: the closest
 * ancestor that holds this form alone and some money. Null when none does.
 */
function listingScript(productId: number): string {
  return String.raw`(() => {
    const input = [...document.querySelectorAll('input[name="product_id"]')].find(
      (el) => el.value === ${JSON.stringify(String(productId))},
    );
    if (!input) return null;
    let node = input.form ?? input.parentElement;
    while (node && node !== document.documentElement) {
      if (node.querySelectorAll('input[name="product_id"]').length > 1) break;
      const text = node.innerText ?? "";
      if (/\d/.test(text) && /\$|USD/.test(text)) return text;
      node = node.parentElement;
    }
    return null;
  })()`;
}

interface CheckoutView {
  readonly present: boolean;
  readonly text: string;
  readonly page: string;
}

function readCheckout(page: Page): Promise<CheckoutView> {
  return page.evaluate<CheckoutView>(READ_CHECKOUT);
}

// ------------------------------------------------------------- the record

interface State {
  readonly name: string;
  readonly text: string;
}

/** The screens the walk reached, saved in order under `<reportDir>/payer/`. */
class Walk {
  readonly states: State[] = [];
  private count = 0;
  constructor(readonly dir: string) {}

  async capture(page: Page, name: string): Promise<CheckoutView> {
    const view = await readCheckout(page);
    this.count += 1;
    const file = `${String(this.count).padStart(2, "0")}-${name}`;
    await writeFile(
      path.join(this.dir, `${file}.txt`),
      `${page.url()}\n\n${view.present ? view.text : "(no checkout on the page)"}\n`,
    );
    await page
      .screenshot({ path: path.join(this.dir, `${file}.png`), fullPage: true, timeout: 15_000 })
      .catch(() => undefined);
    if (view.present) this.states.push({ name, text: view.text });
    return view;
  }

  /** A screen the walk stopped on, saved like any other; the payer saw it too. */
  async stuck(page: Page, name: string): Promise<string> {
    const view = await this.capture(page, name).catch(() => undefined);
    return view === undefined
      ? ""
      : `; the checkout showed: ${view.present ? oneLine(view.text, 300) : "nothing"}`;
  }
}

/** The checks one step owes, failed with a reason until the step sets them. */
class Outcome {
  private readonly set = new Map<string, Check>();
  constructor(
    private readonly specs: readonly { id: string; summary: string; severity?: Severity }[],
  ) {}

  record(id: string, pass: boolean, evidence: string): void {
    const spec = this.specs.find((item) => item.id === id);
    if (spec === undefined) throw new Error(`no check ${id}`);
    this.set.set(id, {
      id,
      severity: spec.severity ?? "blocker",
      pass,
      summary: spec.summary,
      evidence,
    });
  }

  /** Every check: the ones the step did not reach fail with `reason`. */
  finish(reason: string): Check[] {
    return this.specs.map(
      (spec) =>
        this.set.get(spec.id) ?? {
          id: spec.id,
          severity: spec.severity ?? "blocker",
          pass: false,
          summary: spec.summary,
          evidence: reason,
        },
    );
  }
}

function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Playwright colours its call log; evidence is plain text. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function message(error: unknown): string {
  return oneLine((error instanceof Error ? error.message : String(error)).replace(ANSI, ""), 400);
}

async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
  intervalMs = 250,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await probe().catch(() => undefined);
    if (found !== undefined) return found;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// --------------------------------------------------------------- the browser

interface ApiCall {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  /** performance.now() when the answer arrived. */
  readonly at: number;
  body?: string;
}

interface Visit {
  readonly page: Page;
  /** Every answer from a checkout, swap or payment route, in order. */
  readonly api: ApiCall[];
  readonly errors: string[];
}

/** A fresh buyer: cookies of their own, a desktop window, the page's API answers recorded. */
async function visit<T>(browser: Browser, run: (visit: Visit) => Promise<T>): Promise<T> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(message(error)));
    const api: ApiCall[] = [];
    page.on("response", (response) => {
      const pathname = new URL(response.url()).pathname;
      if (!/\/(?:checkouts|swaps|payments)(?:\/|$)/.test(pathname)) return;
      const call: ApiCall = {
        method: response.request().method(),
        path: pathname,
        status: response.status(),
        at: performance.now(),
      };
      api.push(call);
      response.text().then(
        (text) => {
          call.body = text;
        },
        () => {
          call.body = "";
        },
      );
    });
    return await run({ page, api, errors });
  } finally {
    await context.close().catch(() => undefined);
  }
}

const CREATE_CHECKOUT = /\/checkouts\/?$/;
const CREATE_SWAP = /\/swaps\/?$/;

/** The checkout's payments/check answers since `started`: when each arrived, and which said settled. */
function pollsSince(api: readonly ApiCall[], started: number): string {
  const polls = api.filter((call) => call.at >= started && /\/payments\/check\/?$/.test(call.path));
  if (polls.length === 0) return "none";
  return polls
    .map((call) => {
      const settled = /"status"\s*:\s*"settled"/.test(call.body ?? "");
      return `+${Math.round(call.at - started)} ms ${call.status}${settled ? " settled" : ""}`;
    })
    .join(", ");
}

function lastCall(api: readonly ApiCall[], route: RegExp, from = 0): ApiCall | undefined {
  return api
    .slice(from)
    .reverse()
    .find((call) => call.method === "POST" && route.test(call.path));
}

function describeCall(call: ApiCall | undefined): string {
  return call === undefined
    ? "the page sent no create request"
    : `${call.method} ${call.path} answered ${call.status} ${oneLine(call.body ?? "", 200)}`;
}

const bitcoinTile = (page: Page): Locator =>
  page.getByRole("button", { name: /^Bitcoin/ }).filter({ visible: true });
const invoiceQr = (page: Page): Locator =>
  page.locator("[data-openreceive-qr]").filter({ visible: true });
const tryAgain = (page: Page): Locator =>
  page.getByRole("button", { name: /try again|retry/i }).filter({ visible: true });

export interface PlacedOrder {
  /** The product's price on the shop's listing, in cents. */
  readonly price: number | undefined;
  /** The listing text the price came from. */
  readonly listing: string;
  readonly url: string;
}

/** Order one product through the shop's own listing, as a buyer clicks Buy. */
/** The buyer's way to the checkout: the target's own, or the fixture's home-page form. */
function order(target: PayerTarget, page: Page, productId: number): Promise<PlacedOrder> {
  return target.placeOrder?.(page, productId) ?? placeOrder(page, target.baseUrl, productId);
}

async function placeOrder(page: Page, baseUrl: string, productId: number): Promise<PlacedOrder> {
  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
  const near = await page.evaluate<string | null>(listingScript(productId));
  const form = page.locator(`form:has(input[name="product_id"][value="${productId}"])`).first();
  if ((await form.count()) === 0) {
    throw new Error(`the home page has no order form for product ${productId}`);
  }
  await form.getByRole("button").first().click();
  await page.waitForURL((url) => url.pathname !== "/", { timeout: PAGE_TIMEOUT_MS });
  return {
    price: near === null ? undefined : parsePriceCents(near),
    listing: near === null ? "" : oneLine(near, 120),
    url: page.url(),
  };
}

/** The checkout drew its first screen: the method picker, an invoice, or an error with Try again. */
async function checkoutRendered(page: Page): Promise<"picker" | "invoice" | "error"> {
  await bitcoinTile(page)
    .or(invoiceQr(page))
    .or(tryAgain(page))
    .first()
    .waitFor({ state: "visible", timeout: PAGE_TIMEOUT_MS });
  if ((await invoiceQr(page).count()) > 0) return "invoice";
  if ((await bitcoinTile(page).count()) > 0) return "picker";
  return "error";
}

const hashOf = (body: string | undefined): string | undefined =>
  body?.match(/"payment_hash"\s*:\s*"([0-9a-f]{64})"/)?.[1];

/** Pick Bitcoin (unless the invoice is already up) and wait for the invoice and its create answer. */
async function lightningInvoice(visitState: Visit): Promise<{ hash: string; call: ApiCall }> {
  const { page, api } = visitState;
  if ((await invoiceQr(page).count()) === 0) await bitcoinTile(page).first().click();
  const shown = await waitFor(
    async () => ((await invoiceQr(page).count()) > 0 ? true : undefined),
    INVOICE_TIMEOUT_MS,
  );
  if (shown === undefined) {
    throw new Error(
      `no invoice on screen after ${INVOICE_TIMEOUT_MS / 1000} s: ${describeCall(lastCall(api, CREATE_CHECKOUT))}`,
    );
  }
  const created = await waitFor(async () => {
    const call = lastCall(api, CREATE_CHECKOUT);
    return call?.body !== undefined && hashOf(call.body) !== undefined ? call : undefined;
  }, 10_000);
  const hash = hashOf(created?.body);
  if (created === undefined || hash === undefined) {
    throw new Error(
      `the invoice is on screen, but no create answer carried its payment hash: ${describeCall(lastCall(api, CREATE_CHECKOUT))}`,
    );
  }
  return { hash, call: created };
}

/** The error sentence the checkout shows: its alert, or the line before Try again. */
async function errorSentence(page: Page, text: string): Promise<string> {
  const alerts = await page
    .getByRole("alert")
    .filter({ visible: true })
    .allInnerTexts()
    .catch(() => []);
  const fromAlert = alerts
    .join("\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !/^(?:try again|retry)$/i.test(line))
    .join(" ");
  if (fromAlert !== "") return fromAlert;
  const lines = text.split("\n");
  const at = lines.findIndex((line) => /^(?:try again|retry)$/i.test(line.trim()));
  return at > 0 ? (lines[at - 1] ?? "") : "";
}

// ------------------------------------------------------------- the services

async function interceptorPost(
  target: PayerTarget,
  route: "/rules" | "/drop" | "/reset",
  body: Record<string, unknown>,
): Promise<string> {
  if (body.client !== target.client || !CLIENT_PREFIX.test(target.client)) {
    throw new Error(
      `refusing an interceptor rule that is not one shop's prefix: ${JSON.stringify(body.client)}`,
    );
  }
  const response = await fetch(`${target.wallet.interceptor.control}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`interceptor ${route} answered ${response.status}: ${oneLine(text)}`);
  }
  return text;
}

/** The relay hosts this shop reaches through the interceptor. */
function interceptedRelays(wallet: TrialWallet): string[] {
  const intercepted = new Set(wallet.interceptor.hosts.map((host) => host.toLowerCase()));
  const named = relayHostsOf(wallet.nwc).filter((host) => intercepted.has(host));
  if (named.length > 0) return [...new Set(named)];
  if (intercepted.has(RELAY)) return [RELAY];
  throw new Error("the interceptor does not stand in for the wallet's relay");
}

/** The relay goes quiet for this shop alone: TLS finishes, then nothing answers. */
async function silenceRelay(target: PayerTarget, relays: readonly string[]): Promise<void> {
  for (const host of relays) {
    await interceptorPost(target, "/rules", { client: target.client, host, mode: "silent" });
    await interceptorPost(target, "/drop", { client: target.client, host });
  }
}

/** This shop's rules gone, and its quiet connections cut, so it reconnects straight through. */
async function restoreRelay(target: PayerTarget, relays: readonly string[]): Promise<void> {
  await interceptorPost(target, "/reset", { client: target.client });
  for (const host of relays) {
    await interceptorPost(target, "/drop", { client: target.client, host });
  }
}

async function silencedCount(target: PayerTarget): Promise<number | undefined> {
  try {
    const response = await fetch(
      `${target.wallet.interceptor.control}/stats?client=${encodeURIComponent(target.client)}`,
      { signal: AbortSignal.timeout(5_000) },
    );
    const body = (await response.json()) as { stats?: Record<string, { silenced?: number }> };
    return Object.values(body.stats ?? {}).reduce((sum, row) => sum + (row.silenced ?? 0), 0);
  } catch {
    return undefined;
  }
}

function fakeLsc(
  pathname: string,
  ca: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const call = request(
      `${FAKE_LSC}${pathname}`,
      {
        ca,
        timeout: 5_000,
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: text }));
      },
    );
    call.on("timeout", () => call.destroy(new Error("timed out")));
    call.on("error", (error) => reject(new Error(`fake-lsc ${pathname}: ${error.message}`)));
    call.end(body);
  });
}

/**
 * The test provider's next `/create` from this shop answers an error. The
 * provider names its caller by Docker's DNS, so the error waits for this
 * shop's containers (`client`) and never meets another trial's swap.
 */
async function forceCreateError(ca: string, text: string, client: string): Promise<void> {
  const answer = await fakeLsc(
    "/__testkit/force-create-error",
    ca,
    JSON.stringify({ message: text, client }),
  );
  if (answer.status !== 200) {
    throw new Error(`force-create-error answered ${answer.status}: ${oneLine(answer.body)}`);
  }
}

/**
 * Drop a forced create error the shop never met. True when it was still
 * waiting, so the shop's create never reached the provider.
 */
async function drainCreateError(ca: string, client: string): Promise<boolean> {
  const answer = await fakeLsc("/__testkit/clear-create-error", ca, JSON.stringify({ client }));
  if (answer.status !== 200) {
    throw new Error(`clear-create-error answered ${answer.status}: ${oneLine(answer.body)}`);
  }
  return /"waiting"\s*:\s*true/.test(answer.body);
}

// ------------------------------------------------------------------ the steps

const IDS = {
  paid: "payer_paid_on_screen",
  latency: "payer_paid_latency",
  paidWording: "payer_paid_wording",
  amount: "payer_amount_matches",
  words: "payer_words",
  failure: "payer_invoice_failure_has_way_forward",
  recovers: "payer_recovers_after_try_again",
  swapTotal: "payer_swap_total_matches",
  swapFailure: "payer_swap_failure_has_way_forward",
} as const;

/** a + c: a buyer orders product 1, pays by Lightning, and watches the paid screen arrive. */
async function happyPath(browser: Browser, target: PayerTarget, walk: Walk): Promise<Check[]> {
  const outcome = new Outcome([
    {
      id: IDS.paid,
      summary:
        "After the wallet settled the buyer's invoice, the checkout on the order page showed the paid screen without a reload.",
    },
    {
      id: IDS.latency,
      severity: "polish",
      summary: `The paid screen appeared within ${PAID_POLISH_MS / 1000} s of the wallet's settlement.`,
    },
    {
      id: IDS.paidWording,
      summary:
        "The paid screen speaks to the payer (Payment received, Thank you) and names no engine part.",
    },
    {
      id: IDS.amount,
      summary: "The invoice screen shows the shop's own price for the product, to the cent.",
    },
  ]);
  let stage = "the home page";
  let reason = "";
  await visit(browser, async (state) => {
    const { page } = state;
    try {
      const placed = await order(target, page, PRODUCT);
      stage = `the checkout on ${new URL(placed.url).pathname}`;
      const first = await checkoutRendered(page);
      if (first === "error") throw new Error("the checkout opened on an error");
      if (first === "picker") await walk.capture(page, "happy-picker");
      stage = "the Lightning invoice";
      const { hash } = await lightningInvoice(state);
      const invoice = await walk.capture(page, "happy-invoice");
      const shown = checkoutFiatCents(invoice.text);
      outcome.record(
        IDS.amount,
        placed.price !== undefined && shown === placed.price,
        placed.price === undefined
          ? `no price beside product ${PRODUCT}'s form on the home page`
          : shown === undefined
            ? `the invoice screen shows no dollar amount; the shop's price is ${formatCents(placed.price)}`
            : `checkout ${formatCents(shown)}, shop ${formatCents(placed.price)} ("${placed.listing}")`,
      );

      stage = "the paid screen";
      const started = performance.now();
      await target.wallet.settle(hash);
      const paid = await waitFor(
        async () => {
          const view = await readCheckout(page);
          if (view.present && saysPaid(view.text)) return { surface: "checkout", text: view.text };
          if (!view.present && saysPaid(view.page)) return { surface: "page", text: view.page };
          return undefined;
        },
        PAID_TIMEOUT_MS,
        200,
      );
      const ms = Math.round(performance.now() - started);
      if (paid === undefined) {
        reason = `nothing on screen said paid ${PAID_TIMEOUT_MS / 1000} s after the wallet settled ${hash.slice(0, 12)}…${await walk.stuck(page, "happy-not-paid")}`;
        return;
      }
      await walk.capture(page, "happy-paid");
      outcome.record(
        IDS.paid,
        true,
        `${ms} ms from settle to the paid screen (${paid.surface === "checkout" ? "the checkout" : "the host page, the checkout gone"})`,
      );
      outcome.record(
        IDS.latency,
        ms <= PAID_POLISH_MS,
        `${ms} ms; the checkout's payment checks after settle: ${pollsSince(state.api, started)}`,
      );
      const banned = bannedPayerWordsInContext(paid.text);
      outcome.record(
        IDS.paidWording,
        banned.length === 0,
        banned.length === 0 ? `"${paidLines(paid.text)}"` : banned.join("; "),
      );
    } catch (error) {
      reason = `stopped at ${stage}: ${message(error)}${await walk.stuck(page, "happy-stuck")}`;
    }
    if (state.errors.length > 0) reason = `${reason}; page errors: ${state.errors.join(" | ")}`;
  }).catch((error: unknown) => {
    reason = `the browser failed at ${stage}: ${message(error)}`;
  });
  return outcome.finish(reason || `stopped at ${stage}`);
}

/** d: the relay goes quiet while the buyer asks for an invoice, then comes back for Try again. */
async function invoiceFailure(browser: Browser, target: PayerTarget, walk: Walk): Promise<Check[]> {
  const outcome = new Outcome([
    {
      id: IDS.failure,
      summary:
        "With the wallet's relay silent, the checkout told the payer what happened in a sentence and offered Try again.",
    },
    {
      id: IDS.recovers,
      summary:
        "With the relay back, Try again got the payer an invoice within 30 s, without a reload.",
    },
  ]);
  let stage = "the relay";
  let reason = "";
  let relays: string[];
  try {
    relays = interceptedRelays(target.wallet);
  } catch (error) {
    return outcome.finish(`cannot make the relay silent: ${message(error)}`);
  }
  await visit(browser, async (state) => {
    const { page, api } = state;
    let ruled = false;
    try {
      stage = "the home page";
      await order(target, page, PRODUCT);
      stage = "the checkout's first screen";
      const first = await checkoutRendered(page);
      let from = api.length;
      if (first === "invoice") {
        // A checkout that makes its invoice on load: the relay goes quiet
        // before the order page instead, on a second order.
        stage = "a second order, the relay silent before the page";
        ruled = true;
        await silenceRelay(target, relays);
        from = api.length;
        await order(target, page, PRODUCT);
        await checkoutRendered(page).catch(() => undefined);
      } else {
        if (first === "error") throw new Error("the checkout opened on an error before any rule");
        ruled = true;
        await silenceRelay(target, relays);
        from = api.length;
      }
      stage = "the invoice with the relay silent";
      if ((await bitcoinTile(page).count()) > 0 && (await tryAgain(page).count()) === 0) {
        await bitcoinTile(page).first().click();
      }
      const ended = await waitFor(
        async () => {
          if ((await tryAgain(page).count()) > 0) return "error";
          if ((await invoiceQr(page).count()) > 0) return "invoice";
          return undefined;
        },
        FAILURE_TIMEOUT_MS,
        500,
      );
      const silenced = await silencedCount(target);
      const quiet = `${silenced ?? "?"} relay connection(s) held silent`;
      const call = describeCall(lastCall(api, CREATE_CHECKOUT, from));
      if (ended === undefined) {
        reason = `no error and no invoice ${FAILURE_TIMEOUT_MS / 1000} s after picking Bitcoin with the relay silent (${quiet}; ${call})${await walk.stuck(page, "failure-nothing")}`;
        return;
      }
      if (ended === "invoice") {
        reason = `an invoice appeared although the relay was silent (${quiet}; ${call})${await walk.stuck(page, "failure-invoice-anyway")}`;
        return;
      }
      const view = await walk.capture(page, "failure-error");
      const sentence = await errorSentence(page, view.text);
      const banned = bannedPayerWordsInContext(view.text);
      outcome.record(
        IDS.failure,
        isPayerSentence(sentence) && banned.length === 0,
        [
          sentence === "" ? "no sentence beside Try again" : `"${sentence}" with Try again`,
          ...banned,
          quiet,
          call,
        ].join("; "),
      );

      stage = "Try again with the relay back";
      await restoreRelay(target, relays);
      ruled = false;
      const retryFrom = api.length;
      const started = performance.now();
      await tryAgain(page).first().click();
      const back = await waitFor(
        async () => ((await invoiceQr(page).count()) > 0 ? true : undefined),
        RECOVERY_TIMEOUT_MS,
        250,
      );
      const ms = Math.round(performance.now() - started);
      const retried = describeCall(lastCall(api, CREATE_CHECKOUT, retryFrom));
      if (back === undefined) {
        outcome.record(
          IDS.recovers,
          false,
          `no invoice ${RECOVERY_TIMEOUT_MS / 1000} s after Try again (${retried})${await walk.stuck(page, "failure-no-recovery")}`,
        );
        return;
      }
      await walk.capture(page, "failure-recovered");
      outcome.record(IDS.recovers, true, `invoice on screen ${ms} ms after Try again`);
    } catch (error) {
      reason = `stopped at ${stage}: ${message(error)}${await walk.stuck(page, "failure-stuck")}`;
    } finally {
      if (ruled) {
        await restoreRelay(target, relays).catch((error: unknown) => {
          reason = `${reason}; the interceptor reset failed: ${message(error)}`;
        });
      }
    }
    if (state.errors.length > 0) reason = `${reason}; page errors: ${state.errors.join(" | ")}`;
  }).catch((error: unknown) => {
    reason = `the browser failed at ${stage}: ${message(error)}`;
  });
  return outcome.finish(reason || `stopped at ${stage}`);
}

/** Open the coin's network step and pick the network; Continue is left to the caller. */
async function chooseSwap(page: Page): Promise<void> {
  const coin = page.getByRole("button", { name: new RegExp(`^${SWAP_COIN}`) }).filter({
    visible: true,
  });
  if ((await coin.count()) === 0) throw new Error(`the checkout offers no ${SWAP_COIN} tile`);
  if (!(await coin.first().isEnabled())) {
    throw new Error(
      `the ${SWAP_COIN} tile is disabled: ${oneLine((await coin.first().textContent()) ?? "")}`,
    );
  }
  await coin.first().click();
  const group = page
    .getByRole("group", { name: new RegExp(`Choose ${SWAP_COIN} network`, "i") })
    .filter({ visible: true })
    .first();
  await group
    .getByRole("button", { name: new RegExp(`^${SWAP_NETWORK}`) })
    .first()
    .click({ timeout: PAGE_TIMEOUT_MS });
}

const continueButton = (page: Page): Locator =>
  page.getByRole("button", { name: /^Continue$/ }).filter({ visible: true });

/** e: a USDT-on-Solana swap on product 2; the breakdown's total is the shop's price. */
async function swapTotal(browser: Browser, target: PayerTarget, walk: Walk): Promise<Check> {
  const outcome = new Outcome([
    {
      id: IDS.swapTotal,
      summary: `The ${SWAP_COIN} on ${SWAP_NETWORK} breakdown's first row reads Total and shows the shop's own price, to the cent.`,
    },
  ]);
  let stage = "the home page";
  let reason = "";
  await visit(browser, async (state) => {
    const { page, api } = state;
    try {
      const placed = await order(target, page, SWAP_PRODUCT);
      stage = "the checkout's first screen";
      if ((await checkoutRendered(page)) !== "picker") {
        throw new Error("the checkout did not open on its method picker");
      }
      await walk.capture(page, "swap-picker");
      stage = `the ${SWAP_COIN} network step`;
      await chooseSwap(page);
      const from = api.length;
      await continueButton(page).first().click();
      stage = "the swap's deposit screen";
      const rows = await waitFor(async () => {
        const found = await page.evaluate<[string, string][]>(DETAIL_ROWS);
        return found.some(([label]) => /total/i.test(label)) ? found : undefined;
      }, SWAP_TIMEOUT_MS);
      if (rows === undefined) {
        reason = `no breakdown ${SWAP_TIMEOUT_MS / 1000} s after Continue (${describeCall(lastCall(api, CREATE_SWAP, from))})${await walk.stuck(page, "swap-no-breakdown")}`;
        return;
      }
      await walk.capture(page, "swap-deposit");
      const [label, value] = rows.find(([name]) => /total/i.test(name)) ?? ["", ""];
      const shown = parsePriceCents(value);
      const wordingOk = !/cart/i.test(label);
      outcome.record(
        IDS.swapTotal,
        placed.price !== undefined && shown === placed.price && wordingOk,
        [
          `"${label}: ${value}"`,
          placed.price === undefined
            ? `no price beside product ${SWAP_PRODUCT}'s form on the home page`
            : `shop ${formatCents(placed.price)} ("${placed.listing}")`,
          ...(wordingOk ? [] : ["the row names a cart, which a donation or an invoice has not"]),
          `rows: ${rows
            .filter(([, text]) => text !== "")
            .map(([name, text]) => `${name} ${text}`)
            .join(", ")}`,
        ].join("; "),
      );
    } catch (error) {
      reason = `stopped at ${stage}: ${message(error)}${await walk.stuck(page, "swap-stuck")}`;
    }
    if (state.errors.length > 0) reason = `${reason}; page errors: ${state.errors.join(" | ")}`;
  }).catch((error: unknown) => {
    reason = `the browser failed at ${stage}: ${message(error)}`;
  });
  const [only] = outcome.finish(reason || `stopped at ${stage}`);
  return only as Check;
}

/** e: the test provider refuses this shop's swap; the payer gets a sentence and Try again. */
async function swapFailure(browser: Browser, target: PayerTarget, walk: Walk): Promise<Check> {
  const outcome = new Outcome([
    {
      id: IDS.swapFailure,
      summary:
        "When the swap provider refused to create the swap, the checkout said so in a sentence and offered Try again.",
    },
  ]);
  let stage = "the trial CA";
  let reason = "";
  const nonce = randomBytes(4).toString("hex");
  let ca: string;
  try {
    ca = await readFile(target.wallet.caFile, "utf8");
  } catch (error) {
    return outcome.finish(`cannot read the trial CA: ${message(error)}`)[0] as Check;
  }
  await visit(browser, async (state) => {
    const { page, api } = state;
    let forced = false;
    try {
      stage = "the home page";
      await order(target, page, SWAP_PRODUCT);
      stage = "the checkout's first screen";
      if ((await checkoutRendered(page)) !== "picker") {
        throw new Error("the checkout did not open on its method picker");
      }
      stage = `the ${SWAP_COIN} network step`;
      await chooseSwap(page);
      const from = api.length;
      stage = "the forced create error";
      forced = true;
      await forceCreateError(
        ca,
        `Order could not be created (payer walk ${nonce}).`,
        target.client,
      );
      await continueButton(page).first().click();
      stage = "the swap error";
      const ended = await waitFor(
        async () => {
          if ((await tryAgain(page).count()) > 0) return "error";
          const created = lastCall(api, CREATE_SWAP, from);
          if (created !== undefined && created.status >= 200 && created.status < 300) {
            return "created";
          }
          return undefined;
        },
        SWAP_TIMEOUT_MS,
        250,
      );
      // Spend the error now if the shop never did, before another shop's swap meets it.
      const unspent = await drainCreateError(ca, target.client);
      forced = false;
      const call = describeCall(lastCall(api, CREATE_SWAP, from));
      const spent = unspent
        ? "the forced error was still waiting: this shop's create never reached the provider"
        : "the shop's create met the forced error";
      if (ended !== "error") {
        reason = `${ended === "created" ? "the swap was created anyway" : `no error ${SWAP_TIMEOUT_MS / 1000} s after Continue`} (${spent}; ${call})${await walk.stuck(page, "swap-failure-none")}`;
        return;
      }
      const view = await walk.capture(page, "swap-failure");
      const sentence = await errorSentence(page, view.text);
      const banned = bannedPayerWordsInContext(view.text);
      outcome.record(
        IDS.swapFailure,
        isPayerSentence(sentence) && banned.length === 0,
        [
          sentence === "" ? "no sentence beside Try again" : `"${sentence}" with Try again`,
          ...banned,
          spent,
          call,
        ].join("; "),
      );
    } catch (error) {
      reason = `stopped at ${stage}: ${message(error)}${await walk.stuck(page, "swap-failure-stuck")}`;
    } finally {
      if (forced) {
        await drainCreateError(ca, target.client).catch((error: unknown) => {
          reason = `${reason}; draining the forced create error failed: ${message(error)}`;
        });
      }
    }
    if (state.errors.length > 0) reason = `${reason}; page errors: ${state.errors.join(" | ")}`;
  }).catch((error: unknown) => {
    reason = `the browser failed at ${stage}: ${message(error)}`;
  });
  return outcome.finish(reason || `stopped at ${stage}`)[0] as Check;
}

/** b: no captured screen says an engine word, a crash, or an unformatted value. */
function wordsCheck(states: readonly State[]): Check {
  const hits = states.flatMap((state) =>
    bannedPayerWordsInContext(state.text).map((hit) => `${state.name}: ${hit}`),
  );
  return {
    id: IDS.words,
    severity: "blocker",
    pass: states.length > 0 && hits.length === 0,
    summary:
      "No checkout screen the payer saw names NWC, nostr, a relay or the backend, shows a server error, an exception or a traceback, shows text written for the developer (the authorize hook, the payer's session, a field name, an error code), or prints undefined, NaN, null or [object Object].",
    evidence:
      states.length === 0
        ? "the walk reached no checkout screen"
        : hits.length > 0
          ? hits.join("\n")
          : `${states.length} screens clean: ${states.map((state) => state.name).join(", ")}`,
  };
}

// --------------------------------------------------------------------- entry

/**
 * Walk the shop as a payer in Chromium: a Lightning payment to the paid
 * screen, the price on the invoice, a silent relay and Try again, and (with
 * swaps) a USDT swap's breakdown and a refused swap. Each step's failure
 * leaves the others to run; a step that cannot run fails its checks with the
 * reason. Decoding the invoice QR is left out: no QR decoder ships in this
 * repo's dependencies.
 */
export async function payerWalkChecks(target: PayerTarget): Promise<Check[]> {
  const walk = new Walk(path.join(target.reportDir, "payer"));
  await mkdir(walk.dir, { recursive: true });
  let browser: Browser;
  try {
    const { chromium } = await import("@playwright/test");
    browser = await chromium.launch();
  } catch (error) {
    const reason = `Chromium did not start: ${message(error)}`;
    return Object.values(IDS)
      .filter((id) => target.swaps !== false || !id.startsWith("payer_swap"))
      .map((id) => ({
        id,
        severity: id === IDS.latency ? "polish" : "blocker",
        pass: false,
        summary: "The payer walk ran in Chromium.",
        evidence: reason,
      }));
  }
  const checks: Check[] = [];
  try {
    checks.push(...(await happyPath(browser, target, walk)));
    checks.push(...(await invoiceFailure(browser, target, walk)));
    if (target.swaps !== false) {
      checks.push(await swapTotal(browser, target, walk));
      checks.push(await swapFailure(browser, target, walk));
    }
    checks.push(wordsCheck(walk.states));
  } finally {
    await browser.close().catch(() => undefined);
  }
  return checks;
}

// ------------------------------------------------------------- donations

/**
 * The donation scenario (scenarios.ts): the merchant asked for a page at
 * /donate with $5, $20 and $50 buttons and an Other field. Video 12's agent
 * built one, and the directions now carry a donations rule: the amount enters
 * through the host's own route and is saved on a row before checkout, with a
 * floor, a cap and two decimals, refused rather than rounded, and never taken
 * from the checkout's own request.
 */
const DONATION = {
  page: "donation_page",
  preset: "donation_preset_amount",
  tamper: "donation_ignores_payer_amount",
  paid: "donation_paid",
  other: "donation_other_amount",
  refuses: "donation_refuses_bad_amounts",
} as const;

const DONATION_SPECS = [
  {
    id: DONATION.page,
    summary: "GET /donate shows a donation page with $5, $20 and $50 choices and an Other amount.",
  },
  {
    id: DONATION.preset,
    summary: "Choosing $20 opens a checkout for $20.00.",
  },
  {
    id: DONATION.tamper,
    summary:
      "An amount the browser adds to the checkout's own request is ignored or refused: no invoice is minted for it.",
  },
  { id: DONATION.paid, summary: "The $20 donation, once paid, shows the paid screen." },
  { id: DONATION.other, summary: "An Other amount of 7.50 opens a checkout for $7.50." },
  {
    id: DONATION.refuses,
    summary:
      "An Other amount of 0.001 or of 1000000000 is refused before any invoice: no checkout mints one.",
  },
] as const;

const dollarName = (dollars: number): RegExp => new RegExp(`\\$\\s?${dollars}(?:\\.00)?\\b`);

/** A preset that is a button or a link. */
const presetButton = (page: Page, dollars: number): Locator =>
  page
    .getByRole("button", { name: dollarName(dollars) })
    .or(page.getByRole("link", { name: dollarName(dollars) }))
    .filter({ visible: true });

/**
 * A preset in any form a page offers it: a button or link, a radio (2026-11-08:
 * every donation page the agents built was a radio group with a Donate
 * button), or an option of a select.
 */
const presetChoice = (page: Page, dollars: number): Locator =>
  presetButton(page, dollars)
    .or(page.getByRole("radio", { name: dollarName(dollars) }))
    .or(page.locator("select option").filter({ hasText: dollarName(dollars) }));

/** The Other field: the page's visible amount input, never a radio or checkbox. */
const otherField = (page: Page): Locator =>
  page
    .locator(
      ["number", "decimal", "amount", "other"]
        .map((kind) =>
          kind === "number"
            ? 'input[type="number"]'
            : kind === "decimal"
              ? 'input[inputmode="decimal"]'
              : `input[name*="${kind}" i]:not([type="radio"]):not([type="checkbox"]):not([type="hidden"]), input[id*="${kind}" i]:not([type="radio"]):not([type="checkbox"]):not([type="hidden"])`,
        )
        .join(", "),
    )
    .filter({ visible: true });

/** Whether the checkout drew anything within the wait. */
async function checkoutStarted(page: Page, timeout: number): Promise<boolean> {
  return bitcoinTile(page)
    .or(invoiceQr(page))
    .or(tryAgain(page))
    .first()
    .waitFor({ state: "visible", timeout })
    .then(() => true)
    .catch(() => false);
}

/** Send the donation form `near` belongs to: its button that is not a preset, or Enter. */
async function submitDonation(page: Page, near: Locator): Promise<void> {
  const form = page.locator("form").filter({ has: near });
  const scope = (await form.count()) > 0 ? form.first() : page;
  const buttons = scope
    .getByRole("button")
    .filter({ visible: true })
    .filter({ hasNotText: /\$\s?\d/ });
  const named = buttons.filter({ hasText: /donate|give|pay|continue|checkout|next|submit/i });
  const send = (await named.count()) > 0 ? named : buttons;
  if ((await send.count()) > 0) await send.last().click();
  else await near.press("Enter");
}

/** Choose a preset the way the page offers it, and send it. */
async function choosePreset(page: Page, dollars: number): Promise<void> {
  const radio = page.getByRole("radio", { name: dollarName(dollars) });
  if ((await radio.count()) > 0) {
    // A styled radio may be visually hidden behind its label.
    await radio.first().check({ force: true });
    await submitDonation(page, radio.first());
    return;
  }
  const option = page.locator("select option").filter({ hasText: dollarName(dollars) });
  if ((await option.count()) > 0) {
    const select = page.locator("select").filter({ has: option });
    await select
      .first()
      .selectOption({ label: ((await option.first().textContent()) ?? "").trim() });
    await submitDonation(page, select.first());
    return;
  }
  const button = presetButton(page, dollars).first();
  await button.click();
  // A preset button that only selects: the page's own Donate button sends it.
  if (!(await checkoutStarted(page, 5_000))) await submitDonation(page, button);
}

async function openDonate(page: Page, baseUrl: string): Promise<number> {
  const response = await page.goto(`${baseUrl}/donate`, {
    waitUntil: "domcontentloaded",
    timeout: PAGE_TIMEOUT_MS,
  });
  return response?.status() ?? 0;
}

/** Type an Other amount and send it the way the page's own form does. */
async function giveOther(page: Page, amount: string): Promise<void> {
  // A radio group's Other choice comes first, where the page has one.
  const other = page.getByRole("radio", { name: /other/i });
  if ((await other.count()) > 0) await other.first().check({ force: true });
  const field = otherField(page).first();
  await field.fill(amount);
  await submitDonation(page, field);
}

export async function donationWalkChecks(target: PayerTarget): Promise<Check[]> {
  const walk = new Walk(path.join(target.reportDir, "payer"));
  await mkdir(walk.dir, { recursive: true });
  const outcome = new Outcome(DONATION_SPECS);
  let browser: Browser;
  try {
    const { chromium } = await import("@playwright/test");
    browser = await chromium.launch();
  } catch (error) {
    return outcome.finish(`Chromium did not start: ${message(error)}`);
  }
  let reason = "";
  let stage = "/donate";
  try {
    // The page and a $20 preset, with an amount slipped into the checkout's request.
    await visit(browser, async (state) => {
      const { page } = state;
      try {
        const status = await openDonate(page, target.baseUrl);
        const presets = await Promise.all(
          [5, 20, 50].map((dollars) => presetChoice(page, dollars).count()),
        );
        const fields = await otherField(page).count();
        outcome.record(
          DONATION.page,
          status === 200 && presets.every((count) => count > 0) && fields > 0,
          `GET /donate ${status}; $5 ${presets[0]}, $20 ${presets[1]}, $50 ${presets[2]} choice(s); ${fields} amount field(s)`,
        );
        await page
          .screenshot({ path: path.join(walk.dir, "00-donate.png"), fullPage: true })
          .catch(() => undefined);
        stage = "the $20 choice";
        await choosePreset(page, 20);
        const first = await checkoutRendered(page);
        if (first === "error") throw new Error("the checkout opened on an error");
        stage = "the $20 invoice";
        const { hash } = await lightningInvoice(state);
        const invoice = await walk.capture(page, "donation-20");
        const shown = checkoutFiatCents(invoice.text);
        outcome.record(
          DONATION.preset,
          shown === 2000,
          shown === undefined
            ? "the invoice screen shows no dollar amount"
            : `checkout ${formatCents(shown)}`,
        );
        stage = "the paid screen";
        await target.wallet.settle(hash);
        const paid = await waitFor(
          async () => {
            const view = await readCheckout(page);
            return (view.present && saysPaid(view.text)) || (!view.present && saysPaid(view.page))
              ? true
              : undefined;
          },
          PAID_TIMEOUT_MS,
          250,
        );
        if (paid) await walk.capture(page, "donation-paid");
        outcome.record(
          DONATION.paid,
          paid === true,
          paid
            ? "the paid screen showed"
            : `nothing said paid ${PAID_TIMEOUT_MS / 1000} s after settle`,
        );
      } catch (error) {
        reason = `stopped at ${stage}: ${message(error)}${await walk.stuck(page, "donation-stuck")}`;
      }
    });

    // The browser is the payer's: it adds an amount to the checkout's own
    // request. The host must ignore it (its $20 stands) or refuse the request;
    // either way no invoice is minted for the payer's amount. A visit of its
    // own: a refusal (the engines answer 400) would otherwise stop the $20 walk.
    stage = "the payer's amount";
    await visit(browser, async (state) => {
      const { page } = state;
      try {
        await openDonate(page, target.baseUrl);
        await page.route(/\/checkouts\/?$/, async (route) => {
          const request = route.request();
          if (request.method() !== "POST") return route.continue();
          let body: Record<string, unknown> = {};
          try {
            body = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>;
          } catch {
            return route.continue();
          }
          return route.continue({
            postData: JSON.stringify({
              ...body,
              amount: "0.01",
              amount_msats: 1000,
              fiat: { currency: "USD", value: "0.01" },
            }),
          });
        });
        await choosePreset(page, 20);
        await checkoutStarted(page, PAGE_TIMEOUT_MS);
        await bitcoinTile(page)
          .first()
          .click({ timeout: 8_000 })
          .catch(() => undefined);
        const created = await waitFor(
          async () =>
            state.api.find(
              (call) =>
                call.method === "POST" &&
                /\/checkouts\/?$/.test(call.path) &&
                call.body !== undefined,
            ),
          INVOICE_TIMEOUT_MS,
        );
        if (created === undefined) throw new Error("the checkout never asked for an invoice");
        const refused = created.status >= 400 && created.status < 500;
        const msats = Number(
          created.body?.match(/"amount_msats"\s*:\s*"?(\d+)/)?.[1] ?? Number.NaN,
        );
        const view = await walk.capture(page, "donation-payer-amount");
        const shown = checkoutFiatCents(view.text);
        outcome.record(
          DONATION.tamper,
          refused || (created.status === 201 && msats !== 1000 && shown === 2000),
          refused
            ? `the request carried amount 0.01 and amount_msats 1000; the shop refused it (${created.status})`
            : `the request carried amount 0.01 and amount_msats 1000; answered ${created.status}, the checkout shows ${shown === undefined ? "no amount" : formatCents(shown)}, the invoice is ${Number.isFinite(msats) ? `${msats} msat` : "of unknown size"}`,
        );
      } catch (error) {
        reason = `${reason}${reason ? "; " : ""}stopped at ${stage}: ${message(error)}${await walk.stuck(page, "donation-payer-amount-stuck")}`;
      }
    });

    // Other: 7.50.
    stage = "the Other amount";
    await visit(browser, async (state) => {
      const { page } = state;
      try {
        await openDonate(page, target.baseUrl);
        await giveOther(page, "7.50");
        const first = await checkoutRendered(page);
        if (first === "error") throw new Error("the checkout opened on an error");
        await lightningInvoice(state);
        const view = await walk.capture(page, "donation-other");
        const shown = checkoutFiatCents(view.text);
        outcome.record(
          DONATION.other,
          shown === 750,
          shown === undefined
            ? "the invoice screen shows no dollar amount"
            : `checkout ${formatCents(shown)}`,
        );
      } catch (error) {
        reason = `${reason}${reason ? "; " : ""}stopped at ${stage}: ${message(error)}${await walk.stuck(page, "donation-other-stuck")}`;
      }
    });

    // Refusals: no invoice for 0.001 or for a billion.
    stage = "the refused amounts";
    const minted: string[] = [];
    for (const amount of ["0.001", "1000000000"]) {
      await visit(browser, async (state) => {
        const { page } = state;
        try {
          await openDonate(page, target.baseUrl);
          await giveOther(page, amount);
          // Give the page time to reach a checkout and pick Bitcoin if it can.
          await bitcoinTile(page)
            .first()
            .click({ timeout: 8_000 })
            .catch(() => undefined);
          await new Promise((resolve) => setTimeout(resolve, 5_000));
          const created = state.api.find(
            (call) =>
              call.method === "POST" &&
              CREATE_CHECKOUT.test(call.path) &&
              call.status >= 200 &&
              call.status < 300,
          );
          if (created !== undefined) minted.push(`${amount}: ${describeCall(created)}`);
          await walk
            .capture(page, `donation-refused-${amount === "0.001" ? "tiny" : "huge"}`)
            .catch(() => undefined);
        } catch (error) {
          minted.push(`${amount}: the walk failed: ${message(error)}`);
        }
      });
    }
    outcome.record(
      DONATION.refuses,
      minted.length === 0,
      minted.length === 0 ? "no invoice for either amount" : minted.join("; "),
    );
  } finally {
    await browser.close().catch(() => undefined);
  }
  return [...outcome.finish(reason || `stopped at ${stage}`), wordsCheck(walk.states)];
}
