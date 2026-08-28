/**
 * The button shop with NO FRAMEWORK.
 *
 * This is a SECOND implementation of the same UI, and that is the entire point
 * of the static-html-small-api demo: the persistence pattern, the trust
 * boundary and the checkout are not React-specific, and a shop can prove it
 * without a build-time component model.
 *
 * WHAT IS NOT DUPLICATED. It renders the same `or-` class names against the
 * same stylesheet (`../shop.css`), reads the same wire types and formatters
 * (`../shop-types.ts`), and fetches through the same helpers (`../http.ts`).
 * So this file is the DOM and the state machine — roughly 400 lines — and not
 * a second design, a second set of money formatting, or a second opinion about
 * the feed's cache.
 *
 * WHAT IT MUST NEVER IMPORT: anything under `../client/`. That is React, and
 * an accidental import is meant to be visible in the diff rather than
 * discovered at build time — which is also why `@mantine/*` and `mobx*` are
 * absent from this workspace's package.json, where such an import would fail
 * to resolve.
 *
 * The payment step is the packaged `<openreceive-checkout>` custom element,
 * which is why this is the smallest of the four UIs: there is no wizard to
 * build.
 */

import {
  OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES as CHECKOUT_ATTRIBUTES,
  OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS as CHECKOUT_EVENTS,
  OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME as CHECKOUT_TAG,
  defineElements,
} from "@openreceive/elements";
import { loadShopBootstrap } from "../bootstrap.ts";
import {
  buttonsCheckoutResume,
  checkoutUrlFor,
  normalizeOrderReference,
  referenceInLocation,
} from "../checkout-resume.ts";
import { getJson, postJson } from "../http.ts";
import {
  formatUsdCents,
  pluralize,
  relativeTime,
  SHOP_FEED_PATH,
  SHOP_ORDERS_PATH,
  type ShopBootstrap,
  type ShopFeed,
  type ShopOrderPayload,
  shopOrderPath,
  summarizeItems,
} from "../shop-types.ts";

type Stage = "catalog" | "checkout" | "receipt";
type Tab = "shop" | "orders";

const FEED_REFRESH_MS = 30_000;
const THUMB_LIMIT = 3;
const HANDLE_LENGTH = 8;
const PAID = "paid";

/**
 * The whole store, as one object.
 *
 * The React client keeps this in mobx-keystone models. Here it is a plain
 * record plus a `render()` that redraws the body — which is the honest
 * no-framework answer, and small enough at this size that a reconciler would
 * be the more complicated choice rather than the simpler one.
 */
const state = {
  stage: "catalog" as Stage,
  tab: "shop" as Tab,
  maxPerSku: 10,
  prefix: "/openreceive",
  catalog: [] as ShopBootstrap["catalog"],
  visitorRef: "",
  // sku -> quantity. The cart is a CLAIM; the price attached to it on the
  // server comes from the shop_products table and never from here.
  quantities: {} as Record<string, number>,
  order: null as ShopOrderPayload | null,
  placingOrder: false,
  settling: false,
  errorMessage: "",
  feed: null as ShopFeed | null,
  feedLoading: false,
  feedLoaded: false,
  // The "open an order id" box on the catalog: collapsed until asked for, and
  // its own error, because a dead uuid is a fact about a link and not about
  // the cart on screen.
  resumeOpen: false,
  resuming: false,
  resumeError: "",
};

let feedTimer: number | undefined;
let body: HTMLElement;

// ---------------------------------------------------------------- the cart

const quantityOf = (sku: string): number => state.quantities[sku] ?? 0;

const lines = () =>
  state.catalog
    .map((entry) => ({ entry, quantity: quantityOf(entry.sku) }))
    .filter((line) => line.quantity > 0);

const itemCount = (): number => lines().reduce((total, line) => total + line.quantity, 0);

const totalCents = (): number =>
  lines().reduce((total, line) => total + line.entry.price_cents * line.quantity, 0);

const setQuantity = (sku: string, quantity: number): void => {
  const clamped = Math.max(0, Math.min(Math.trunc(quantity), state.maxPerSku));
  if (clamped === 0) delete state.quantities[sku];
  else state.quantities[sku] = clamped;
  state.errorMessage = "";
  render();
};

const imageFor = (sku: string): string =>
  state.catalog.find((entry) => entry.sku === sku)?.image_url ?? "";

// --------------------------------------------------------------- the order

/**
 * One cart becomes one order becomes one reference, minted once and held for
 * the life of this checkout. Never re-minted on a retry: a fresh id per
 * attempt would leave the same cart payable twice.
 */
const placeOrder = async (): Promise<void> => {
  if (itemCount() === 0 || state.placingOrder) return;
  state.placingOrder = true;
  render();
  try {
    const order = await postJson<ShopOrderPayload>(SHOP_ORDERS_PATH, {
      // Only the sku and the quantity. A price never goes on the wire.
      items: lines().map((line) => ({ sku: line.entry.sku, quantity: line.quantity })),
    });
    state.order = order;
    buttonsCheckoutResume.rememberOrder(order);
    // The uuid goes in the address bar the moment it exists. A payer with a
    // deposit in flight has no account and no email from us; this URL is the
    // only thing that brings them back to their payment screen.
    buttonsCheckoutResume.enterCheckout(order.reference);
    state.stage = "checkout";
    state.errorMessage = "";
  } catch (error) {
    state.errorMessage = error instanceof Error ? error.message : String(error);
  } finally {
    state.placingOrder = false;
    render();
  }
};

/** Settlement is the server's word. Re-read the row `onPaid` wrote. */
const refreshOrder = async (): Promise<boolean> => {
  const reference = state.order?.reference;
  if (reference === undefined) return false;
  try {
    const order = await getJson<ShopOrderPayload>(shopOrderPath(reference));
    state.order = order;
    buttonsCheckoutResume.rememberOrder(order);
    return order.state === PAID;
  } catch {
    return false;
  }
};

/**
 * The checkout says the payment landed; the order row says the download
 * exists. They are written by the same transaction but reach the browser over
 * two different routes, so this waits for ours.
 *
 * Single-flight and idempotent: the browser never learns from a message that
 * it was fulfilled, it learns from the row.
 */
const confirmSettlement = async (): Promise<void> => {
  if (state.settling || state.stage === "receipt" || state.order === null) return;
  state.settling = true;
  try {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await refreshOrder()) {
        state.stage = "receipt";
        render();
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1_500));
    }
  } finally {
    state.settling = false;
  }
};

/**
 * Back to the shop, and the one exit that also DROPS the link: the payer said
 * they were done with this order, so the stored summary and the
 * `/checkout/:reference` URL both go. The back button routes through
 * `leaveOrder` instead, which says something weaker and keeps them.
 */
const startOver = (): void => {
  const reference = state.order?.reference;
  leaveOrder();
  if (reference !== undefined) buttonsCheckoutResume.forgetOrder(reference);
  buttonsCheckoutResume.leaveCheckout();
  render();
};

const leaveOrder = (): void => {
  state.order = null;
  state.quantities = {};
  state.stage = "catalog";
  state.errorMessage = "";
  state.resumeError = "";
};

/**
 * Open an order by its uuid — from `/checkout/:reference` on a cold load, or
 * from a uuid a payer pasted into the catalog.
 *
 * The summary comes from sessionStorage first and from the host's own
 * `GET /shop/orders/:reference` when that misses, which is what makes a
 * bookmark work in a new tab. That route is authorized by the visitor cookie,
 * so an id pasted into a browser that did not place the order is a miss and
 * never somebody else's receipt.
 */
const resumeOrder = async (input: string): Promise<void> => {
  const reference = normalizeOrderReference(input);
  if (!reference) {
    state.resumeError = "That does not look like an order id.";
    render();
    return;
  }
  if (reference === state.order?.reference && state.stage !== "catalog") return;

  state.resuming = true;
  render();
  try {
    const order = await buttonsCheckoutResume.loadOrderForResume(reference);
    if (order === undefined) {
      state.resumeError = "We could not find that order in this browser.";
      return;
    }
    state.order = order;
    state.resumeError = "";
    state.resumeOpen = false;
    buttonsCheckoutResume.enterCheckout(reference);
    // A paid order resumes to its receipt — the downloads are why that payer
    // kept the link — and anything else resumes to the payment screen.
    state.stage = order.state === PAID ? "receipt" : "checkout";
  } finally {
    state.resuming = false;
    render();
  }
};

/** The URL, applied. Runs on load and on every back/forward. */
const applyLocation = (): void => {
  const reference = referenceInLocation();
  if (reference) {
    void resumeOrder(reference);
    return;
  }
  if (state.stage !== "catalog") {
    leaveOrder();
    render();
  }
};

// ---------------------------------------------------------------- the feed

const loadFeed = async (fresh: boolean): Promise<void> => {
  if (state.feedLoading) return;
  state.feedLoading = true;
  render();
  try {
    state.feed = await getJson<ShopFeed>(SHOP_FEED_PATH, { fresh });
    state.feedLoaded = true;
  } catch {
    // A failed poll leaves the last good feed on screen; the next tick retries.
  } finally {
    state.feedLoading = false;
    render();
  }
};

/**
 * Once immediately, then on an interval. The immediate read REVALIDATES: the
 * common way to arrive here is straight off your own receipt, well inside the
 * response's ten-second cache.
 */
const startFeed = (): void => {
  stopFeed();
  void loadFeed(true);
  feedTimer = window.setInterval(() => void loadFeed(false), FEED_REFRESH_MS);
};

const stopFeed = (): void => {
  window.clearInterval(feedTimer);
  feedTimer = undefined;
};

const setTab = (tab: Tab): void => {
  state.tab = tab;
  if (tab === "orders") startFeed();
  else stopFeed();
  render();
};

// ------------------------------------------------------------------- render

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const button = (label: string, className: string, onClick: () => void): HTMLButtonElement => {
  const node = el("button", className, label);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
};

/**
 * A labelled value with a copy button — the same `or-shop-copyrow` markup the
 * React client renders, against the same stylesheet.
 *
 * Every value a payer has to REPRODUCE gets one of these. A badge or a
 * sentence is not a copy affordance.
 */
const copyRow = (label: string, value: string): HTMLElement => {
  const row = el("div", "or-shop-copyrow");
  const code = el("code", "or-shop-copyrow-value", value);
  code.dataset.truncate = "true";
  const copy = button("Copy", "or-vanilla-button or-vanilla-button-subtle", () => {
    void navigator.clipboard.writeText(value).then(() => {
      copy.textContent = "Copied";
      window.setTimeout(() => {
        copy.textContent = "Copy";
      }, 1_600);
    });
  });
  copy.setAttribute("aria-label", `Copy ${label.toLowerCase()}`);

  const line = el("div", "or-vanilla-copyrow-line");
  line.append(code, copy);
  row.append(el("span", "or-shop-copyrow-label", label), line);
  return row;
};

/**
 * The way back into an order, for a payer who has only the uuid.
 *
 * Discreet and collapsed until it is asked for: on the catalog it is a
 * footnote, and the payer who needs it is the one the refund screen told to
 * keep an order id. It accepts the whole checkout URL as readily as the bare
 * uuid, because both are things people paste.
 */
const renderResumeRow = (): HTMLElement => {
  const wrapper = el("div", "or-shop-resume");

  if (!state.resumeOpen) {
    wrapper.append(
      button("Already have an order id? Open it", "or-vanilla-link", () => {
        state.resumeOpen = true;
        render();
      }),
    );
    return wrapper;
  }

  const form = el("form", "or-vanilla-resume-form");
  const input = el("input", "or-vanilla-resume-input");
  input.type = "text";
  input.placeholder = "Paste your order id or checkout link";
  input.setAttribute("aria-label", "Order id");
  input.autofocus = true;

  const open = el(
    "button",
    "or-vanilla-button or-vanilla-button-light",
    state.resuming ? "…" : "Open",
  );
  open.type = "submit";
  open.disabled = state.resuming;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void resumeOrder(input.value);
  });
  form.append(input, open);
  wrapper.append(form);

  if (state.resumeError) wrapper.append(el("p", "or-vanilla-alert", state.resumeError));
  wrapper.append(el("p", "or-shop-resume-hint", "Orders open in the browser that placed them."));
  return wrapper;
};

const render = (): void => {
  body.replaceChildren(
    state.tab === "orders"
      ? renderFeed()
      : state.stage === "checkout"
        ? renderCheckout()
        : state.stage === "receipt"
          ? renderReceipt()
          : renderCatalog(),
  );
  renderTabs();
};

const renderTabs = (): void => {
  for (const node of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
    const selected = node.dataset.tab === state.tab;
    node.setAttribute("aria-selected", String(selected));
    node.classList.toggle("or-tab-active", selected);
  }
};

const renderCatalog = (): DocumentFragment => {
  const fragment = document.createDocumentFragment();
  const stage = el("div", "or-shop-stage");
  const grid = el("div", "or-shop-grid");

  for (const entry of state.catalog) {
    const quantity = quantityOf(entry.sku);
    const card = el("div", "or-shop-card");
    // The attribute must be ABSENT rather than "false": `[data-in-cart]`
    // matches any value, so a rendered `data-in-cart="false"` makes every card
    // look selected.
    if (quantity > 0) card.dataset.inCart = "true";

    const image = el("img", "or-shop-card-image");
    image.src = entry.image_url;
    image.alt = `${entry.name} OpenReceive button`;
    image.loading = "lazy";

    card.append(
      image,
      el("div", "or-shop-card-name", entry.name),
      el("div", "or-shop-card-price", formatUsdCents(entry.price_cents)),
    );

    if (quantity > 0) {
      const group = el("div", "or-vanilla-qty");
      const minus = button("−", "or-vanilla-step", () => setQuantity(entry.sku, quantity - 1));
      minus.setAttribute("aria-label", `Remove one ${entry.name}`);
      const plus = button("+", "or-vanilla-step", () => setQuantity(entry.sku, quantity + 1));
      plus.setAttribute("aria-label", `Add one ${entry.name}`);
      plus.disabled = quantity >= state.maxPerSku;
      group.append(minus, el("span", "or-shop-card-qty", String(quantity)), plus);
      card.append(group);
    } else {
      card.append(
        button("Add", "or-vanilla-button or-vanilla-button-light", () => setQuantity(entry.sku, 1)),
      );
    }
    grid.append(card);
  }

  // A footnote, not a feature: the payer who needs it was told to keep an order
  // id on the refund screen.
  stage.append(grid, renderResumeRow());
  fragment.append(stage);

  if (state.errorMessage) fragment.append(el("p", "or-vanilla-alert", state.errorMessage));

  const footer = el("div", "or-shop-footer");
  footer.append(
    el(
      "span",
      "",
      itemCount() === 0
        ? "Your cart is empty"
        : `${pluralize(itemCount(), "button")} · ${formatUsdCents(totalCents())}`,
    ),
  );
  const checkout = button(
    state.placingOrder ? "Working…" : "Checkout",
    "or-vanilla-button or-vanilla-button-primary",
    () => void placeOrder(),
  );
  checkout.disabled = itemCount() === 0 || state.placingOrder;
  footer.append(checkout);
  fragment.append(footer);

  return fragment;
};

/**
 * The payment step: the packaged custom element, pointed at the reference the
 * shop already minted.
 *
 * `prefix` is the element's ONLY url input — create, prepare, payment-check
 * and the four swap routes are all derived from it — and it comes from the
 * bootstrap payload, so the mount path lives on the server rather than in a
 * second copy here.
 */
const renderCheckout = (): DocumentFragment => {
  const fragment = document.createDocumentFragment();
  const order = state.order;
  if (order === null) return fragment;

  const stage = el("div", "or-shop-stage");

  const strip = el("div", "or-shop-order-strip");
  const thumbs = el("div", "or-shop-order-thumbs");
  for (const item of order.items) {
    const image = el("img");
    image.src = imageFor(item.sku);
    image.alt = item.name;
    thumbs.append(image);
  }
  const copy = el("div");
  copy.append(
    el("div", "or-shop-order-title", order.description),
    el("div", "or-shop-order-total", formatUsdCents(order.total_cents)),
  );
  strip.append(thumbs, copy);

  const checkout = document.createElement(CHECKOUT_TAG);
  checkout.setAttribute(CHECKOUT_ATTRIBUTES.reference, order.reference);
  checkout.setAttribute(CHECKOUT_ATTRIBUTES.prefix, state.prefix);
  // The shop has no dark mode — ../shop.css hard-codes #fff in several places
  // and says so at the top — so the checkout is pinned to light, exactly as
  // every other stack pins it.
  checkout.setAttribute(CHECKOUT_ATTRIBUTES.theme, "light");
  // NOT `sync-url`: the HOST owns the address bar, because it also has to
  // restore the order behind `/checkout/:reference` on a cold load. This says
  // the order HAS such a URL, which is the one thing that decides whether the
  // element's refund screen tells the payer to bookmark it.
  checkout.setAttribute(CHECKOUT_ATTRIBUTES.resumable, "true");
  // The browser does not learn from this event that it was fulfilled. It
  // re-reads the order row, which is the only thing that can say so.
  checkout.addEventListener(CHECKOUT_EVENTS.settled, () => void confirmSettlement());
  checkout.addEventListener(CHECKOUT_EVENTS.startOver, startOver);

  // The order id and its URL, on the payment screen. A payer with no account
  // has nothing else that comes back to this page.
  const keep = el("div", "or-shop-keeplink");
  keep.append(
    el("div", "or-shop-section-title", "Keep this order id"),
    el(
      "p",
      "or-shop-resume-hint",
      "It is the way back to this payment. The link is already in your address bar.",
    ),
    copyRow("Order id", order.reference),
    copyRow("Checkout link", checkoutUrlFor(order.reference)),
  );

  stage.append(strip, checkout, keep);
  fragment.append(stage);

  const footer = el("div", "or-shop-footer");
  footer.append(
    button("Start over", "or-vanilla-button or-vanilla-button-subtle", startOver),
    el("span", "", formatUsdCents(order.total_cents)),
  );
  fragment.append(footer);

  return fragment;
};

const renderReceipt = (): DocumentFragment => {
  const fragment = document.createDocumentFragment();
  const order = state.order;
  if (order === null) return fragment;

  const stage = el("div", "or-shop-stage");
  const head = el("div", "or-vanilla-receipt-head");
  head.append(
    el("div", "or-shop-status-title", "Payment received"),
    el(
      "div",
      "or-shop-status-detail",
      `${order.description} · ${formatUsdCents(order.total_cents)}`,
    ),
  );
  stage.append(head);

  for (const item of order.items) {
    const line = el("div", "or-shop-receipt-line");
    const image = el("img");
    image.src = imageFor(item.sku);
    image.alt = item.name;
    image.width = 44;
    image.height = 44;

    const copy = el("div", "or-shop-receipt-copy");
    copy.append(
      el("div", "", `${item.name}${item.quantity > 1 ? ` ×${item.quantity}` : ""}`),
      el("div", "or-shop-status-detail", formatUsdCents(item.unit_price_cents * item.quantity)),
    );

    // The download exists because the order row says `paid`, and that row was
    // written inside OpenReceive's settlement transaction. The browser never
    // decides this.
    const download = el("a", "or-vanilla-button or-vanilla-button-light", "Download");
    if (item.download_path !== null) download.href = item.download_path;
    else download.setAttribute("aria-disabled", "true");

    line.append(image, copy, download);
    stage.append(line);
  }

  stage.append(button("See it in recent orders", "or-vanilla-link", () => setTab("orders")));
  fragment.append(stage);

  const footer = el("div", "or-shop-footer");
  footer.append(
    el("span", "", `Order ${order.reference.slice(0, HANDLE_LENGTH)}`),
    button("Buy more buttons", "or-vanilla-button", startOver),
  );
  fragment.append(footer);

  return fragment;
};

/**
 * Every paid order on the site, to every visitor.
 *
 * The response is public, identical for everyone and cached for ten seconds —
 * there is no `you: true` field in it. The "You" badge is drawn HERE, by
 * comparing each row's `buyer` against this visitor's own public uuid from the
 * bootstrap payload.
 */
const renderFeed = (): DocumentFragment => {
  const fragment = document.createDocumentFragment();
  const stage = el("div", "or-shop-stage");
  const orders = state.feed?.orders ?? [];

  if (!state.feedLoaded) {
    const list = el("div", "or-shop-feed");
    for (let index = 0; index < 3; index += 1) list.append(el("div", "or-shop-feed-skeleton"));
    stage.append(list);
  } else if (orders.length === 0) {
    const empty = el("div", "or-shop-feed-empty");
    empty.append(
      el("p", "", "No buttons sold yet."),
      el("p", "", "Every paid order shows up here."),
    );
    stage.append(empty);
  } else {
    const list = el("div", "or-shop-feed");
    for (const order of orders) {
      const mine = Boolean(state.visitorRef) && order.buyer === state.visitorRef;
      const row = el("div", "or-shop-feed-row");
      if (mine) row.dataset.you = "true";

      const thumbs = el("div", "or-shop-feed-thumbs");
      for (const item of order.items.slice(0, THUMB_LIMIT)) {
        if (item.image_url === null) continue;
        const image = el("img");
        image.src = item.image_url;
        image.alt = "";
        image.loading = "lazy";
        thumbs.append(image);
      }

      const main = el("div", "or-shop-feed-main");
      const meta = el("div", "or-shop-feed-meta");
      // Truncated for DISPLAY only — 36 characters do not fit a three-column
      // row at 360px — with the full value in `title`.
      const buyer = el(
        "span",
        "or-shop-feed-buyer",
        order.buyer ? `${order.buyer.slice(0, HANDLE_LENGTH)}…` : "anonymous",
      );
      buyer.title = order.buyer ?? "";
      meta.append(buyer, el("span", "", "·"), el("span", "", relativeTime(order.paid_at)));
      if (mine) meta.append(el("span", "or-shop-feed-you", "You"));
      main.append(el("div", "or-shop-feed-title", summarizeItems(order.items)), meta);

      row.append(thumbs, main, el("div", "or-shop-feed-amount", formatUsdCents(order.total_cents)));
      list.append(row);
    }
    stage.append(list);
  }
  fragment.append(stage);

  const totals = state.feed?.totals ?? { paid_orders: 0, buttons_sold: 0 };
  const footer = el("div", "or-shop-footer");
  footer.append(
    el(
      "span",
      "or-shop-feed-totals",
      `${pluralize(totals.paid_orders, "order")} · ${pluralize(totals.buttons_sold, "button")} sold`,
    ),
    button(
      state.feedLoading ? "Refreshing…" : "Refresh",
      "or-vanilla-button or-vanilla-button-subtle",
      () => void loadFeed(true),
    ),
  );
  fragment.append(footer);

  return fragment;
};

// ---------------------------------------------------------------- bootstrap

const start = async (): Promise<void> => {
  const root = document.getElementById("or-shop-body");
  if (root === null) return;
  body = root;

  // Registers <openreceive-checkout> so the tag this file creates upgrades
  // into the live checkout UI.
  defineElements();

  for (const node of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
    node.addEventListener("click", () => setTab(node.dataset.tab as Tab));
  }

  try {
    const bootstrap = await loadShopBootstrap();
    if (bootstrap === null) throw new Error("The bootstrap payload was empty.");
    state.catalog = bootstrap.catalog;
    state.maxPerSku = bootstrap.max_per_sku;
    state.visitorRef = bootstrap.visitor?.public_ref ?? "";
    state.prefix = bootstrap.openreceive_prefix || "/openreceive";
  } catch (error) {
    body.replaceChildren(
      el(
        "p",
        "or-vanilla-alert",
        `The shop could not load: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    return;
  }

  // The URL is the way back to a payment. `/checkout/:reference` is read on
  // load and on every back/forward, so a bookmark, a pasted link and the back
  // button all land where they say they will.
  window.addEventListener("popstate", applyLocation);
  applyLocation();

  render();
};

void start();
