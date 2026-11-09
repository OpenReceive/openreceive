import type { Page } from "@playwright/test";
import type { ChaosBuyer, MethodListing } from "./chaos.ts";
import type { PlacedOrder } from "./payer.ts";
import { compose } from "./docker.ts";
import {
  type Answer,
  backToBackCheck,
  buyerAnswerChecks,
  type CheckoutClient,
  check,
  type LiveOptions,
  metaToken,
  type PaidPath,
  paidChecks,
  type SwapPath,
  swapOrderChecks,
} from "./live.ts";
import type { Check } from "./types.ts";

// The live checks for a WordPress store, WooCommerce or Easy Digital
// Downloads, over plain HTTP. The buyer is a guest with a cookie jar: they add
// a seeded product to the cart, check out with the OpenReceive gateway and
// land on the order page that shows the checkout (WooCommerce's order-pay
// page, EDD's purchase confirmation page). From there they call the plugin's
// REST routes as that checkout does: the element's own `prefix`, the page's
// nonce in its `csrf-header`, and the cookies the page set. Every answer any
// guest got is kept, so a 503 a retry hid still fails `live_no_buyer_503`.

/** One answer a guest got: which request, and when it answered (Date.now()). */
export interface RecordedAnswer extends Answer {
  readonly route: string;
  readonly at: number;
}

/** A guest's cookies. A cookie WordPress expires or blanks is dropped, as a browser drops it. */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  store(setCookies: readonly string[], now = Date.now()): void {
    for (const header of setCookies) {
      const [pair = "", ...options] = header.split(";");
      const at = pair.indexOf("=");
      if (at <= 0) continue;
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      const expired = options.some((option) => {
        const equals = option.indexOf("=");
        const key = (equals === -1 ? option : option.slice(0, equals)).trim().toLowerCase();
        const setting = equals === -1 ? "" : option.slice(equals + 1).trim();
        if (key === "max-age") return Number(setting) <= 0;
        if (key === "expires") {
          const when = Date.parse(setting);
          return Number.isFinite(when) && when <= now;
        }
        return false;
      });
      if (expired || value === "" || value === "deleted") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  names(): string[] {
    return [...this.cookies.keys()];
  }

  /** Every cookie, as name and value. */
  entries(): [string, string][] {
    return [...this.cookies];
  }

  header(): Record<string, string> {
    if (this.cookies.size === 0) return {};
    return { cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ") };
  }
}

/** A request as the record names it: the method and path, with a plain-permalink REST route. */
export function routeOf(method: string, url: string): string {
  const parsed = new URL(url);
  const rest = parsed.searchParams.get("rest_route");
  return `${method} ${parsed.pathname}${rest === null ? "" : `?rest_route=${rest}`}`;
}

interface Reply {
  readonly status: number;
  readonly body: string;
  readonly url: string;
  readonly headers: Headers;
  readonly ms: number;
}

/** One guest's browser: its cookies, the Store API nonce, and every answer it got. */
class Guest {
  readonly jar = new CookieJar();
  readonly answers: RecordedAnswer[] = [];
  /** WooCommerce's Store API hands its nonce back in a `Nonce` header; the block checkout keeps the latest. */
  storeNonce: string | undefined;

  constructor(private readonly timeoutMs = 60_000) {}

  async send(
    url: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    } = {},
  ): Promise<Reply> {
    const method = init.method ?? "GET";
    const route = routeOf(method, url);
    const started = performance.now();
    let status = 0;
    let body = "";
    let headers = new Headers();
    try {
      const response = await fetch(url, {
        method,
        headers: { ...this.jar.header(), ...init.headers },
        body: init.body,
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      this.jar.store(response.headers.getSetCookie());
      const nonce = response.headers.get("nonce");
      if (nonce !== null && nonce !== "") this.storeNonce = nonce;
      headers = response.headers;
      body = await response.text();
      status = response.status;
    } catch (error) {
      // A request that hung or broke is a spinner that never ends to the buyer.
      status = 0;
      body = String(error);
    }
    const ms = Math.round(performance.now() - started);
    this.answers.push({ route, status, body: body.slice(0, 400), ms, at: Date.now() });
    return { status, body, url, headers, ms };
  }

  /** GET, following redirects as a browser does. */
  async open(url: string): Promise<Reply> {
    let reply = await this.send(url);
    for (let hop = 0; hop < 6 && reply.status >= 300 && reply.status < 400; hop += 1) {
      const location = reply.headers.get("location");
      if (location === null) break;
      reply = await this.send(new URL(location, reply.url).href);
    }
    return reply;
  }

  /** A form POST, then its redirect as a browser follows it. */
  async submit(url: string, fields: URLSearchParams): Promise<Reply> {
    const reply = await this.send(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: fields.toString(),
    });
    const location = reply.headers.get("location");
    if (reply.status >= 300 && reply.status < 400 && location !== null) {
      return this.open(new URL(location, url).href);
    }
    return reply;
  }
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  ndash: "\u2013",
  mdash: "\u2014",
};

/** HTML text as the browser reads it: `&#038;` in an esc_url() link is `&`. */
export function decodeHtml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, code: string) => {
    if (code.startsWith("#x") || code.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
    }
    if (code.startsWith("#")) return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** One tag's attributes, names lowercased and values decoded. A bare attribute is "". */
export function attributes(tag: string): Map<string, string> {
  const found = new Map<string, string>();
  const inside = tag.replace(/^<\s*[a-z0-9-]+/i, "").replace(/\/?>\s*$/, "");
  for (const match of inside.matchAll(
    /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g,
  )) {
    const name = match[1]?.toLowerCase();
    if (name === undefined || found.has(name)) continue;
    found.set(name, decodeHtml(match[2] ?? match[3] ?? match[4] ?? ""));
  }
  return found;
}

/** The checkout a WordPress order page shows, as the element reads its attributes. */
export interface CheckoutElement {
  readonly reference: string;
  /** The plugin's REST base, `…/wp-json/openreceive/v1` or `…/?rest_route=/openreceive/v1`. */
  readonly prefix: string;
  /** The header the page's nonce goes in: X-WP-Nonce. */
  readonly csrfHeader: string;
  readonly resumePaymentHash?: string;
  readonly resumePaymentRail?: string;
  readonly thankYou?: string;
}

export function checkoutElement(html: string): CheckoutElement | undefined {
  const tag = html.match(/<openreceive-checkout\b[^>]*>/i)?.[0];
  if (tag === undefined) return undefined;
  const found = attributes(tag);
  const reference = found.get("reference");
  if (reference === undefined || reference === "") return undefined;
  const hash = found.get("resume-payment-hash");
  const rail = found.get("resume-payment-rail");
  const thankYou = found.get("data-thank-you");
  return {
    reference,
    prefix: found.get("prefix") ?? "/openreceive",
    csrfHeader: found.get("csrf-header") ?? "X-CSRF-Token",
    ...(hash === undefined ? {} : { resumePaymentHash: hash }),
    ...(rail === undefined ? {} : { resumePaymentRail: rail }),
    ...(thankYou === undefined ? {} : { thankYou }),
  };
}

export interface Form {
  readonly action: string | undefined;
  readonly html: string;
  /** What the form sends without a click: no submit buttons, unchecked boxes or radios. */
  readonly fields: URLSearchParams;
}

/** The first form whose opening tag matches. */
export function findForm(html: string, opening: RegExp): Form | undefined {
  for (const match of html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)) {
    const tag = match[0].match(/^<form\b[^>]*>/i)?.[0] ?? "";
    if (!opening.test(tag)) continue;
    return { action: attributes(tag).get("action"), html: match[0], fields: formFields(match[0]) };
  }
  return undefined;
}

export function formFields(form: string): URLSearchParams {
  const fields = new URLSearchParams();
  for (const match of form.matchAll(/<input\b[^>]*>/gi)) {
    const input = attributes(match[0]);
    const name = input.get("name");
    if (name === undefined || name === "" || input.has("disabled")) continue;
    const type = (input.get("type") ?? "text").toLowerCase();
    if (["submit", "button", "image", "reset", "file"].includes(type)) continue;
    const box = type === "checkbox" || type === "radio";
    if (box && !input.has("checked")) continue;
    fields.append(name, input.get("value") ?? (box ? "on" : ""));
  }
  return fields;
}

/** The submit control named `name` that the buyer presses, and the value it sends. */
export function submitButton(
  form: string,
  name: string,
): { readonly name: string; readonly value: string } | undefined {
  for (const match of form.matchAll(/<(?:button|input)\b[^>]*>/gi)) {
    const control = attributes(match[0]);
    const type = (control.get("type") ?? "submit").toLowerCase();
    if (control.get("name") === name && type === "submit") {
      return { name, value: control.get("value") ?? "" };
    }
  }
  return undefined;
}

/** The first link whose opening tag matches. */
export function linkHref(html: string, opening: RegExp): string | undefined {
  for (const match of html.matchAll(/<a\b[^>]*>/gi)) {
    if (opening.test(match[0])) return attributes(match[0]).get("href");
  }
  return undefined;
}

/** WooCommerce Blocks' settings on a block page: `wcSettings = JSON.parse(decodeURIComponent('…'))`. */
export function wcSettings(html: string): Record<string, unknown> | undefined {
  const encoded = html.match(
    /wcSettings\s*=\s*JSON\.parse\(\s*decodeURIComponent\(\s*'([^']*)'\s*\)\s*\)/,
  )?.[1];
  if (encoded === undefined) return undefined;
  try {
    return JSON.parse(decodeURIComponent(encoded)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * The payment methods a WooCommerce checkout page shows: the classic form's
 * `payment_method` radios, or the block checkout's registered methods
 * (wcSettings.paymentMethodData), which only lists gateways that are available.
 */
export function wooCheckoutMethods(html: string): {
  readonly checkout: "classic" | "block" | "none";
  readonly methods: string[];
  readonly title?: string;
} {
  if (/name="woocommerce-process-checkout-nonce"/.test(html)) {
    const methods = [...html.matchAll(/<input\b[^>]*name="payment_method"[^>]*>/gi)]
      .map((match) => attributes(match[0]).get("value") ?? "")
      .filter((method) => method !== "");
    const label = html.match(
      /<label\b[^>]*for="payment_method_openreceive"[^>]*>([\s\S]*?)<\/label>/i,
    );
    const title = label?.[1] === undefined ? undefined : textOf(label[1]);
    return { checkout: "classic", methods, ...(title ? { title } : {}) };
  }
  const data = wcSettings(html)?.paymentMethodData;
  if (typeof data === "object" && data !== null) {
    const methods = Object.keys(data);
    const title = (data as Record<string, { title?: unknown }>).openreceive?.title;
    return { checkout: "block", methods, ...(typeof title === "string" ? { title } : {}) };
  }
  return { checkout: "none", methods: [] };
}

/** The checkout page a WooCommerce block page links to (the cart's Proceed to checkout). */
export function wooCheckoutUrl(html: string): string | undefined {
  const pages = wcSettings(html)?.storePages as { checkout?: { permalink?: unknown } } | undefined;
  const permalink = pages?.checkout?.permalink;
  if (typeof permalink === "string" && permalink !== "") return permalink;
  return linkHref(html, /\bclass="[^"]*\b(?:checkout-button|wc-block-cart__submit-button)\b/);
}

/** The Store API nonce a block page carries for its own requests. */
export function storeApiNonce(html: string): string | undefined {
  return html.match(/storeApiNonce["']?\s*:\s*["']([0-9a-f]+)["']/i)?.[1];
}

/**
 * The gateways an EDD checkout offers: its `payment-mode` radios when there are
 * several, and the purchase form's `edd-gateway`, the one selected (the only
 * one, when the store has one active gateway).
 */
export function eddGateways(html: string): {
  readonly selected: string | undefined;
  readonly offered: string[];
} {
  const radios = [...html.matchAll(/<input\b[^>]*name="payment-mode"[^>]*>/gi)]
    .map((match) => attributes(match[0]).get("value") ?? "")
    .filter((gateway) => gateway !== "");
  const selected = findForm(html, /id="edd_purchase_form"/)?.fields.get("edd-gateway") ?? undefined;
  const offered = [...new Set([...radios, ...(selected === undefined ? [] : [selected])])];
  return { selected, offered };
}

/** The EDD checkout a page links to: the Checkout button after an add, or EDD's own globals. */
export function eddCheckoutUrl(html: string): string | undefined {
  const link = linkHref(html, /\bclass="[^"]*\bedd_go_to_checkout\b/);
  if (link !== undefined) return link;
  const global = html.match(/"checkout_page"\s*:\s*"([^"]+)"/)?.[1];
  return global === undefined ? undefined : global.replaceAll("\\/", "/");
}

/** A page's visible text, for evidence: tags and scripts dropped, whitespace folded. */
export function textOf(html: string): string {
  return decodeHtml(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " "),
  ).trim();
}

/** The store's error notices on a page (EDD's edd_errors, WooCommerce's woocommerce-error). */
function noticesOf(html: string): string {
  const notices = [
    ...html.matchAll(
      /<(div|ul)\b[^>]*class="[^"]*\b(?:edd_errors|woocommerce-error|edd-alert-error)\b[^"]*"[^>]*>([\s\S]*?)<\/\1>/gi,
    ),
  ].map((match) => textOf(match[2] ?? ""));
  return notices.join(" | ");
}

/** The numeric order id in a reference: WooCommerce's `17`, EDD's `edd-17`. */
export function orderNumber(reference: string, prefix: string): number | undefined {
  if (!reference.startsWith(prefix)) return undefined;
  const id = reference.slice(prefix.length);
  return /^[1-9][0-9]*$/.test(id) ? Number(id) : undefined;
}

function parseJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** The 503 and 5xx checks, over every request a guest made (store pages and Store API too). */
export { buyerAnswerChecks };

/** An order the guest placed, and the page that shows its checkout. */
interface Placed {
  readonly reference: string;
  /** The order page's address, which a reload fetches again. */
  readonly page: string;
  readonly element: CheckoutElement;
  readonly token: string | undefined;
}

/** Whether checkout offered the gateway to this guest, and what showed it. */
interface Listing {
  readonly offered: boolean;
  readonly evidence: string;
}

/**
 * The checkout's calls, from the guest's browser: the element's prefix plus
 * the route, the page's nonce in the element's csrf-header, and the guest's
 * cookies (the WooCommerce session, and the signed `openreceive_pay_…` cookie
 * the order page set).
 */
class OrderPageClient implements CheckoutClient {
  private token: string | undefined;

  constructor(
    private readonly guest: Guest,
    private readonly placed: Placed,
    private readonly retryDelayMs: number,
  ) {
    this.token = placed.token;
  }

  /** A reloaded order page hands out a fresh nonce; the checkout on it uses that one. */
  adopt(html: string): void {
    this.token = metaToken(html) ?? this.token;
  }

  private async call(route: string, body: Record<string, string>): Promise<Answer> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (this.token !== undefined) headers[this.placed.element.csrfHeader] = this.token;
    const reply = await this.guest.send(`${this.placed.element.prefix}${route}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return { status: reply.status, body: reply.body, ms: reply.ms };
  }

  /** One POST to /checkouts, with no retry: what the chaos phase measures. */
  createCheckoutOnce(reference: string): Promise<Answer> {
    return this.call("/checkouts", { reference });
  }

  /** A 503 the API marks retryable is tried again, as the checkout's Try again does. */
  async createCheckout(reference: string): Promise<Answer> {
    let result = await this.call("/checkouts", { reference });
    for (let retry = 0; retry < 2 && result.status === 503; retry += 1) {
      if (!/"retryable"\s*:\s*true/.test(result.body)) break;
      await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      result = await this.call("/checkouts", { reference });
    }
    return result;
  }

  prepareCheckout(reference: string): Promise<Answer> {
    return this.call("/checkouts/prepare", { reference });
  }

  createSwap(reference: string, payInAsset: string): Promise<Answer> {
    return this.call("/swaps", { reference, pay_in_asset: payInAsset });
  }

  swapStatus(reference: string, paymentHash: string): Promise<Answer> {
    return this.call("/swaps/status", { reference, payment_hash: paymentHash });
  }

  checkPayment(reference: string, paymentHash: string): Promise<Answer> {
    return this.call("/payments/check", { reference, payment_hash: paymentHash });
  }
}

/** The order page the checkout sent the guest to, and the checkout on it. */
function orderPage(page: Reply): Placed {
  const element = checkoutElement(page.body);
  if (element === undefined) {
    const notices = noticesOf(page.body);
    throw new Error(
      `${page.status} ${new URL(page.url).pathname} shows no OpenReceive checkout${notices ? `: ${notices}` : ""}`,
    );
  }
  return {
    reference: element.reference,
    page: page.url,
    element: { ...element, prefix: new URL(element.prefix, page.url).href },
    token: metaToken(page.body),
  };
}

/** A REST route that works with or without pretty permalinks. */
function rest(base: string, route: string, query: Record<string, string> = {}): string {
  return `${base}/?${new URLSearchParams({ rest_route: route, ...query })}`;
}

/** A guest address of its own each time, so no store asks this guest to sign in. */
function guestEmail(): string {
  return `guest-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@example.test`;
}

/** How a store sells to a guest, and how WP-CLI reads one of its orders. */
interface Store {
  readonly name: string;
  /** The Lightning order's product, then the swap order's: at least 10 USDT at $100,000 a BTC. */
  readonly products: readonly [string, string];
  readonly order: (
    guest: Guest,
    base: string,
    product: string,
    listed: (found: Listing) => void,
  ) => Promise<Placed>;
  /** The order's status once paid, else awaiting_payment; "" when there is no such order. */
  readonly status: (directory: string, reference: string) => Promise<string>;
}

/** A PHP expression's value, read with the shop's own WP-CLI. */
export async function wpEval(directory: string, php: string): Promise<string> {
  const result = await compose(
    directory,
    ["run", "--rm", "-T", "--no-deps", "cli", "wp", "eval", php],
    120_000,
  );
  return result.stdout.match(/^status=(.*)$/m)?.[1]?.trim() ?? "";
}

const WOOCOMMERCE: Store = {
  name: "WooCommerce",
  products: ["Facet", "Bezel"],
  async order(guest, base, product, listed) {
    const search = await guest.open(rest(base, "/wc/store/v1/products", { search: product }));
    const item = parseJson<{ id?: number; name?: string; permalink?: string }[]>(search.body)?.find(
      (candidate) => decodeHtml(candidate.name ?? "") === product,
    );
    if (item?.permalink === undefined || item.id === undefined) {
      throw new Error(`the Store API lists no product ${product}: ${search.status}`);
    }
    // The product page's Add to cart form, as a click submits it.
    const page = await guest.open(item.permalink);
    const form = findForm(page.body, /\bclass="[^"]*\bcart\b/i);
    const button = form === undefined ? undefined : submitButton(form.html, "add-to-cart");
    let added: Reply;
    if (form !== undefined && button !== undefined) {
      const fields = new URLSearchParams(form.fields);
      fields.set(button.name, button.value);
      added = await guest.submit(new URL(form.action ?? page.url, page.url).href, fields);
    } else {
      // A theme whose button adds through the Store API, as block themes' do.
      await guest.open(rest(base, "/wc/store/v1/cart"));
      added = await guest.send(rest(base, "/wc/store/v1/cart/add-item"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(guest.storeNonce === undefined ? {} : { nonce: guest.storeNonce }),
        },
        body: JSON.stringify({ id: item.id, quantity: 1 }),
      });
    }
    // View cart, then the cart's Proceed to checkout.
    const cartLink = linkHref(added.body, /\bclass="[^"]*\bwc-forward\b/);
    const cartPage = cartLink === undefined ? undefined : await guest.open(cartLink);
    const checkoutUrl =
      wooCheckoutUrl(cartPage?.body ?? "") ?? wooCheckoutUrl(added.body) ?? `${base}/checkout/`;
    const checkoutPage = await guest.open(checkoutUrl);
    const shown = wooCheckoutMethods(checkoutPage.body);
    // The cart as the block checkout reads it: the gateways WooCommerce makes available to it.
    const cart = await guest.open(rest(base, "/wc/store/v1/cart"));
    const state = parseJson<{ payment_methods?: string[]; items?: unknown[] }>(cart.body);
    const available = state?.payment_methods ?? [];
    listed({
      offered: shown.methods.includes("openreceive") && available.includes("openreceive"),
      evidence: `${shown.checkout} checkout page shows ${shown.methods.join(", ") || "no methods"}${shown.title ? ` ("${shown.title}")` : ""}; the cart (${state?.items?.length ?? 0} items) offers ${available.join(", ") || "no methods"}`,
    });
    const nonce = guest.storeNonce ?? storeApiNonce(checkoutPage.body);
    const address = {
      first_name: "Guest",
      last_name: "Buyer",
      company: "",
      address_1: "1 Demo Street",
      address_2: "",
      city: "Los Angeles",
      state: "CA",
      postcode: "90001",
      country: "US",
      phone: "",
    };
    // Place order, as the block checkout posts it.
    const placed = await guest.send(rest(base, "/wc/store/v1/checkout"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(nonce === undefined ? {} : { nonce }),
      },
      body: JSON.stringify({
        billing_address: { ...address, email: guestEmail() },
        shipping_address: address,
        customer_note: "",
        create_account: false,
        payment_method: "openreceive",
        payment_data: [],
        extensions: {},
      }),
    });
    const result = parseJson<{
      order_id?: number;
      payment_result?: { redirect_url?: string };
    }>(placed.body);
    const redirect = result?.payment_result?.redirect_url;
    if (placed.status !== 200 || redirect === undefined || redirect === "") {
      throw new Error(`Place order answered ${placed.status}: ${placed.body.slice(0, 300)}`);
    }
    return orderPage(await guest.open(new URL(redirect, base).href));
  },
  async status(directory, reference) {
    const id = orderNumber(reference, "");
    if (id === undefined) return "";
    return wpEval(
      directory,
      `$o = wc_get_order(${id}); echo "status=", $o ? ($o->is_paid() ? $o->get_status() : "awaiting_payment") : "", "\\n";`,
    );
  },
};

const EDD: Store = {
  name: "Easy Digital Downloads",
  products: ["Widget Pack Nano", "Widget Pack Micro"],
  async order(guest, base, product, listed) {
    const search = await guest.open(
      rest(base, "/wp/v2/search", { search: product, type: "post", subtype: "download" }),
    );
    const item = parseJson<{ title?: string; url?: string }[]>(search.body)?.find(
      (candidate) => decodeHtml(candidate.title ?? "") === product,
    );
    if (item?.url === undefined) {
      throw new Error(`WordPress finds no download ${product}: ${search.status}`);
    }
    // The download page's purchase form, as a click without scripts submits it.
    const page = await guest.open(item.url);
    const form = findForm(page.body, /\bedd_download_purchase_form\b/);
    if (form === undefined) throw new Error(`${item.url} shows no purchase form`);
    const added = await guest.submit(new URL(form.action ?? page.url, page.url).href, form.fields);
    const checkoutUrl = eddCheckoutUrl(added.body) ?? `${base}/checkout/`;
    let checkout = await guest.open(checkoutUrl);
    const gateways = eddGateways(checkout.body);
    listed({
      offered: gateways.offered.includes("openreceive"),
      evidence: `the checkout offers ${gateways.offered.join(", ") || "no gateway"}${gateways.selected ? `, ${gateways.selected} selected` : ""}`,
    });
    if (gateways.selected !== "openreceive") {
      // Picking the gateway reloads the purchase form for it.
      const picked = new URL(checkoutUrl);
      picked.searchParams.set("payment-mode", "openreceive");
      checkout = await guest.open(picked.href);
    }
    const purchase = findForm(checkout.body, /id="edd_purchase_form"/);
    if (purchase === undefined) {
      throw new Error(`${checkout.status} ${checkoutUrl} shows no purchase form`);
    }
    const fields = new URLSearchParams(purchase.fields);
    fields.set("edd_email", guestEmail());
    fields.set("edd_first", "Guest");
    fields.set("edd_last", "Buyer");
    const button = submitButton(purchase.html, "edd-purchase");
    if (button !== undefined) fields.set(button.name, button.value);
    // EDD records the pending order and sends the guest to its purchase confirmation page.
    return orderPage(
      await guest.submit(new URL(purchase.action ?? checkout.url, checkout.url).href, fields),
    );
  },
  async status(directory, reference) {
    const id = orderNumber(reference, "edd-");
    if (id === undefined) return "";
    return wpEval(
      directory,
      `$o = edd_get_order(${id}); echo "status=", $o ? (in_array($o->status, ["complete", "completed", "publish"], true) ? $o->status : "awaiting_payment") : "", "\\n";`,
    );
  },
};

/** paidChecks' own wording, for a settlement step that threw before it could report. */
const SETTLED_SUMMARY =
  "After the wallet settled the invoice, the shop's checkout reported it paid.";
const FLOW_SUMMARY = "The guest's checkout flow ran to the end.";

/** The swap pay-in assets a prepare answer marks available. */
export function swapMethods(body: string): string[] {
  const methods =
    parseJson<{
      payment_methods?: { pay_in_asset?: string; available?: boolean }[];
    }>(body)?.payment_methods ?? [];
  return methods
    .filter((method) => method.available === true && typeof method.pay_in_asset === "string")
    .map((method) => method.pay_in_asset ?? "");
}

const hashOf = (body: string) => body.match(/"payment_hash"\s*:\s*"([0-9a-f]{64})"/)?.[1];
const bolt11Of = (body: string) => body.match(/"bolt11"\s*:\s*"(ln[a-z0-9]+)"/i)?.[1];

/**
 * A reload resumes the checkout: the order page loads twice, names the same
 * order both times and the invoice it already has (`resume-payment-hash`),
 * and its checkout asking again gets that same invoice.
 */
async function reloadCheck(
  guest: Guest,
  client: OrderPageClient,
  placed: Placed,
  paymentHash: string,
): Promise<Check> {
  const loads = [await guest.open(placed.page), await guest.open(placed.page)];
  const elements = loads.map((load) => checkoutElement(load.body));
  client.adopt(loads[1]?.body ?? "");
  const again = await client.createCheckout(placed.reference);
  const sameOrder = elements.every((element) => element?.reference === placed.reference);
  const resumed = elements.every((element) => element?.resumePaymentHash === paymentHash);
  const sameInvoice = again.status === 201 && hashOf(again.body) === paymentHash;
  const named = elements.map((element) =>
    element === undefined
      ? "no checkout"
      : `${element.reference}${element.resumePaymentHash ? ` resuming ${element.resumePaymentHash.slice(0, 12)}… (${element.resumePaymentRail ?? "?"})` : " resuming nothing"}`,
  );
  return check(
    "live_reload",
    sameOrder && resumed && sameInvoice,
    "A reload of the order page resumed the same checkout: the same order, its invoice on the page, and the same invoice again.",
    `${loads.map((load) => load.status).join(", ")}: ${named.join("; then ")}; again ${again.status} ${
      sameInvoice
        ? "same payment hash"
        : hashOf(again.body) === undefined
          ? again.body.slice(0, 200)
          : `a new payment hash ${hashOf(again.body)?.slice(0, 12)}…`
    }`,
  );
}

async function liveWordpressChecks(
  store: Store,
  directory: string,
  base: string,
  options: LiveOptions,
): Promise<Check[]> {
  const retryDelayMs = options.retryDelayMs ?? 5_000;
  const checks: Check[] = [];
  const health = await fetch(`${base}/`, { signal: AbortSignal.timeout(60_000) })
    .then((response) => response.status)
    .catch(() => 0);
  checks.push(check("live_health", health === 200, `${store.name} answers GET /.`, `${health}`));
  const guests: Guest[] = [];
  const guest = (): Guest => {
    const made = new Guest();
    guests.push(made);
    return made;
  };
  const listedSummary = `${store.name}'s checkout offered OpenReceive to a guest with a product in the cart.`;
  const invoiceSummary =
    "The guest checked out with OpenReceive, landed on the order page with its checkout, and that checkout got a Lightning invoice.";
  const strangerSummary =
    "The plugin refused a checkout for someone else's order, asked from a guest session with its own order, nonce and cookie.";

  let listing: Listing | undefined;
  try {
    const buyer = guest();
    const placed = await store.order(buyer, base, store.products[0], (found) => {
      listing = found;
      checks.push(check("live_gateway_listed", found.offered, listedSummary, found.evidence));
    });
    const client = new OrderPageClient(buyer, placed, retryDelayMs);
    // On load the checkout prepares (the amount and the methods); Bitcoin mints the invoice.
    const prepared = await client.prepareCheckout(placed.reference);
    const own = await client.createCheckout(placed.reference);
    const bolt11 = bolt11Of(own.body);
    const paymentHash = hashOf(own.body);
    const where = new URL(placed.page).pathname;
    checks.push(
      check(
        "live_invoice",
        own.status === 201 && bolt11 !== undefined && paymentHash !== undefined,
        invoiceSummary,
        bolt11 === undefined
          ? `${placed.reference} at ${where}: ${own.status} ${own.body.slice(0, 300)}`
          : `${placed.reference} at ${where}: ${own.status} ${bolt11.slice(0, 16)}… in ${own.ms} ms`,
      ),
    );
    if (options.bitcoinOnly === true) {
      // The merchant said "Bitcoin only": the page's checkout offers no swap.
      const offered = prepared.status === 200 ? swapMethods(prepared.body) : [];
      checks.push(
        check(
          "live_bitcoin_only",
          prepared.status === 200 && offered.length === 0,
          "The merchant asked for Bitcoin only, and the checkout offers no swap pay-in method.",
          prepared.status === 200
            ? `swap methods on offer: ${offered.join(", ") || "none"}`
            : `${prepared.status} ${prepared.body.slice(0, 200)}`,
        ),
      );
    }

    // Another guest, with an order, a session, a nonce and a signed cookie of
    // their own, asks for this order's checkout.
    const stranger = guest();
    const theirs = await store.order(stranger, base, store.products[0], () => undefined);
    const refused = await new OrderPageClient(stranger, theirs, retryDelayMs).createCheckout(
      placed.reference,
    );
    checks.push(
      check(
        "live_refuses_stranger",
        [401, 403, 404].includes(refused.status),
        strangerSummary,
        `${refused.status} ${refused.body.slice(0, 200)}`,
      ),
    );

    if (paymentHash !== undefined) {
      checks.push(await backToBackCheck(client, placed.reference, placed.page, paymentHash));
      checks.push(await reloadCheck(buyer, client, placed, paymentHash));
    }
    if (options.paid !== undefined && paymentHash !== undefined) {
      const wallet = options.paid;
      let paidAt = 0;
      // WP-CLI reads the store's own order; the loop's probe is for app shops.
      const paid: PaidPath = {
        settle: async (hash) => {
          await wallet.settle(hash);
          paidAt = Date.now();
        },
        orderStatus: (reference) => store.status(directory, reference),
      };
      const results = await paidChecks(
        client,
        placed.reference,
        placed.page,
        paymentHash,
        paid,
        options,
      );
      // How long after the wallet paid the checkout's poll first saw it.
      const seen = buyer.answers.find(
        (answer) =>
          answer.at >= paidAt &&
          answer.route.endsWith("/payments/check") &&
          /"status"\s*:\s*"settled"/.test(answer.body),
      );
      checks.push(
        ...results.map((result) =>
          result.id === "live_settled" && result.pass && seen !== undefined
            ? {
                ...result,
                evidence: `seen ${seen.at - paidAt} ms after the wallet paid, polling every ${options.retryDelayMs ?? 4_000} ms`,
              }
            : result,
        ),
      );
    }
  } catch (error) {
    // The step that threw fails. An order that never reached its page fails
    // the listing too when checkout never got that far.
    const steps: [string, string][] = [
      ["live_gateway_listed", listedSummary],
      ["live_invoice", invoiceSummary],
      ["live_refuses_stranger", strangerSummary],
      ...(options.paid === undefined
        ? []
        : [["live_settled", SETTLED_SUMMARY] as [string, string]]),
    ];
    const missing = steps.filter(([id]) => !checks.some((item) => item.id === id));
    const failed = listing === undefined ? missing.slice(0, 2) : missing.slice(0, 1);
    for (const [id, summary] of failed.length > 0 ? failed : [["live_guest_flow", FLOW_SUMMARY]]) {
      checks.push(check(id, false, summary, String(error)));
    }
  }

  if (options.swap !== undefined) {
    try {
      // A new guest's order of the dearer product: its first payment is the swap.
      const swapper = guest();
      const placed = await store.order(swapper, base, store.products[1], () => undefined);
      const swap: SwapPath = {
        ...options.swap,
        orderStatus: (reference) => store.status(directory, reference),
      };
      checks.push(
        ...(await swapOrderChecks(
          new OrderPageClient(swapper, placed, retryDelayMs),
          placed.reference,
          placed.page,
          swap,
          options,
        )),
      );
    } catch (error) {
      checks.push(
        check("live_swap_paid", false, "The guest paid an order by swap.", String(error)),
      );
    }
  }
  checks.push(...buyerAnswerChecks(guests.flatMap((made) => made.answers)));
  return checks;
}

/**
 * A WooCommerce store's live checks. The guest adds Facet ($7) on its product
 * page, checks out through the Store API as the block checkout does, and pays
 * on the order-pay page; a second guest pays Bezel ($12) by a USDT_SOL swap.
 * `directory` is the shop's Compose project, whose `cli` service reads the
 * orders (the loop's `paid.orderStatus` probe is not used).
 */
export function liveWoocommerceChecks(
  directory: string,
  baseUrl: string,
  options: LiveOptions = {},
): Promise<Check[]> {
  return liveWordpressChecks(WOOCOMMERCE, directory, baseUrl, options);
}

/**
 * An Easy Digital Downloads store's live checks. The guest adds Widget Pack
 * Nano ($7) from its download page, buys it on EDD's checkout with the
 * OpenReceive gateway, and pays on the purchase confirmation page; a second
 * guest pays Widget Pack Micro ($12.50) by a USDT_SOL swap.
 */
export function liveEddChecks(
  directory: string,
  baseUrl: string,
  options: LiveOptions = {},
): Promise<Check[]> {
  return liveWordpressChecks(EDD, directory, baseUrl, options);
}

/**
 * A fresh guest's order for the chaos phase (chaos.ts): placed through the
 * store's own checkout, then the order page's checkout calls, one at a time.
 */
export function wordpressChaosBuyers(
  slug: "woocommerce" | "edd",
  directory: string,
  base: string,
): () => Promise<ChaosBuyer> {
  const store = slug === "edd" ? EDD : WOOCOMMERCE;
  return async () => {
    const guest = new Guest(75_000);
    const placed = await store.order(guest, base, store.products[0], () => {});
    const client = new OrderPageClient(guest, placed, 3_000);
    await client.prepareCheckout(placed.reference);
    return {
      order: placed.reference,
      createOnce: () => client.createCheckoutOnce(placed.reference),
      checkPayment: (hash: string) => client.checkPayment(placed.reference, hash),
      status: () => store.status(directory, placed.reference),
    };
  };
}

/** Whether a new guest is offered the method, for the chaos phase's outage step. */
export function wordpressMethodListing(
  slug: "woocommerce" | "edd",
  directory: string,
  base: string,
): MethodListing {
  const store = slug === "edd" ? EDD : WOOCOMMERCE;
  return {
    async listed() {
      let found: Listing | undefined;
      // Placing the order is not this step's business, and needs the method.
      const failure = await store
        .order(new Guest(75_000), base, store.products[0], (listing) => {
          found = listing;
        })
        .then(
          () => undefined,
          (error: unknown) => String(error),
        );
      return (
        found ?? {
          offered: false,
          evidence: failure ?? "the store listed no methods",
        }
      );
    },
    async forgetCaches() {
      await compose(
        directory,
        ["run", "--rm", "-T", "--no-deps", "cli", "wp", "transient", "delete", "--all"],
        120_000,
      );
    },
  };
}

/** The WordPress store a platform is, or undefined for every other platform. */
export function wordpressKind(platform: {
  readonly slug: string;
  readonly directions_slug?: string;
}): "woocommerce" | "edd" | undefined {
  const stack = platform.directions_slug ?? platform.slug;
  return stack === "woocommerce" || stack === "edd" ? stack : undefined;
}

/**
 * The seeded catalog's prices, in cents: WooCommerce's Facet and Bezel, EDD's
 * Widget Pack Nano and Micro (trials/platforms/<slug>/seed). The payer walk
 * checks the checkout shows the store's own amount.
 */
const SEEDED_PRICES: Readonly<Record<"woocommerce" | "edd", readonly [number, number]>> = {
  woocommerce: [700, 1200],
  edd: [700, 1250],
};

/**
 * The payer walk's way to a WordPress checkout: a guest buys product 1 or 2
 * through the store's own checkout (as the live checks do), and the browser
 * opens the order page with that guest's cookies.
 */
export function wordpressPayerOrders(
  slug: "woocommerce" | "edd",
  base: string,
): (page: Page, productId: number) => Promise<PlacedOrder> {
  const store = slug === "edd" ? EDD : WOOCOMMERCE;
  return async (page, productId) => {
    const index = productId === 1 ? 0 : 1;
    const product = store.products[index];
    const guest = new Guest(75_000);
    const placed = await store.order(guest, base, product, () => {});
    const url = new URL(placed.page);
    await page.context().addCookies(
      guest.jar.entries().map(([name, value]) => ({
        name,
        value,
        domain: url.hostname,
        path: "/",
      })),
    );
    await page.goto(placed.page, { waitUntil: "domcontentloaded", timeout: 60_000 });
    return {
      price: SEEDED_PRICES[slug][index],
      listing: `${product}, as seeded`,
      url: placed.page,
    };
  };
}
