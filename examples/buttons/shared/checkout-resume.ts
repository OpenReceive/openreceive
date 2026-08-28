/**
 * The order id in the URL, and the way back to a checkout.
 *
 * A payer who is halfway through a swap deposit has money in flight and no
 * account: the ONLY thing that can return them to their payment screen is the
 * order's own uuid. So the checkout lives at `/checkout/:reference` on every
 * stack, and this module is the one place that knows it.
 *
 * `createGuestCheckoutResume` is the packaged glue — URL parse/push,
 * sessionStorage mirror, fetch-on-miss — so this file is the shop's three
 * answers to it (where the order lives, what a valid one looks like, how to
 * fetch it) and nothing else.
 *
 * FRAMEWORK-FREE, and it must stay that way: it sits beside shop-types.ts
 * rather than inside client/ because BOTH clients need it — the React one and
 * the no-framework one in client-vanilla/, which may never import React.
 */

import { createGuestCheckoutResume } from "@openreceive/browser";
import { getJson } from "./http.ts";
import { type ShopOrderPayload, shopOrderPath } from "./shop-types.ts";

/** `/checkout/:reference`. One segment, matched by four servers' routes. */
const CHECKOUT_PATH_PREFIX = "/checkout";

const ORDER_STORAGE_KEY_PREFIX = "buttons.order.";

/**
 * A uuid, and nothing else. The value reaches us from a text box a payer
 * pasted into, so it is checked before it becomes a URL or a request path —
 * see the same constraint on the Rails routes.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const parseOrder = (value: unknown): ShopOrderPayload | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const order = value as Partial<ShopOrderPayload>;
  if (typeof order.reference !== "string" || !UUID.test(order.reference)) return undefined;
  if (typeof order.state !== "string" || !Array.isArray(order.items)) return undefined;
  return order as ShopOrderPayload;
};

export const buttonsCheckoutResume = createGuestCheckoutResume<ShopOrderPayload>({
  pathPrefix: CHECKOUT_PATH_PREFIX,
  storageKeyPrefix: ORDER_STORAGE_KEY_PREFIX,
  referenceOf: (order) => order.reference,
  parseOrder,
  // NOT `createGuestOrderFetcher`: that helper unwraps a `{ summary }` or
  // `{ order }` envelope, and this shop's `GET /shop/orders/:reference`
  // answers with the order itself. The route is the host's own — OpenReceive
  // ships no order-read endpoint — and it is authorized by the visitor cookie,
  // so an id pasted into a browser that did not place the order is a 404.
  fetchOrder: async (reference) => {
    if (!UUID.test(reference)) return undefined;
    try {
      return parseOrder(await getJson<ShopOrderPayload>(shopOrderPath(reference)));
    } catch {
      return undefined;
    }
  },
});

/**
 * THE SWAP ATTEMPT THIS ORDER HAS IN FLIGHT, remembered by payment hash.
 *
 * The order summary alone is not enough to come back to a deposit.
 * `POST /checkouts/prepare` answers with the amount and the pay-in catalog and
 * NO attempts, so a checkout rebuilt from the reference alone opens on the
 * method grid — and a payer who was told to bookmark their refund screen finds
 * a shop.
 *
 * THE PAYMENT HASH IS THE DURABLE HANDLE, AND THE CHOSEN COIN IS NOT.
 * Re-selecting the coin (`POST /swaps`) re-serves this order's committed
 * attempt only while it is still live and comfortably before expiry; the
 * shadow invoice behind a swap is minted for about half an hour, and past that
 * the same click MINTS A SECOND ATTEMPT with a new deposit address. A refund is
 * claimed hours later by a payer who went to fetch an address from another
 * wallet, which is exactly the case that outlives the window.
 *
 * `POST /swaps/status` takes `{ reference, payment_hash }` and addresses one
 * attempt directly, with no reuse test, so the hash still reaches a refund
 * screen a day later. It is a public value, the payer's own evidence that they
 * paid, and the server remains the authority on what the attempt is.
 *
 * localStorage, not session: sessionStorage dies with the tab, which is the
 * case this exists for. The lifetime is right because it matches the only
 * browser that can resume at all — `GET /shop/orders/:reference` is authorized
 * by the visitor cookie, so an id pasted into a different browser is a 404
 * whatever we remembered.
 */
const SWAP_ATTEMPT_KEY_PREFIX = "buttons.swap.";

const localStore = (): Storage | undefined => {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
};

export const rememberSwapAttempt = (reference: string, paymentHash: string): void => {
  if (!reference || !paymentHash) return;
  try {
    localStore()?.setItem(`${SWAP_ATTEMPT_KEY_PREFIX}${reference}`, paymentHash);
  } catch {
    // Best-effort. Without it the payer lands on the method grid, which is a
    // worse resume and not a broken one.
  }
};

export const readSwapAttempt = (reference: string): string => {
  if (!reference) return "";
  try {
    return localStore()?.getItem(`${SWAP_ATTEMPT_KEY_PREFIX}${reference}`) ?? "";
  } catch {
    return "";
  }
};

export const forgetSwapAttempt = (reference: string): void => {
  if (!reference) return;
  try {
    localStore()?.removeItem(`${SWAP_ATTEMPT_KEY_PREFIX}${reference}`);
  } catch {
    // Ignore storage failures on reset.
  }
};

/**
 * What a payer pasted, as a reference — or "" when it is not one.
 *
 * Accepts the bare uuid and the whole URL, because both are things people
 * actually copy: the id off the checkout screen, or the address bar itself.
 */
export const normalizeOrderReference = (input: string): string => {
  const trimmed = input.trim();
  if (UUID.test(trimmed)) return trimmed.toLowerCase();
  const fromPath = trimmed.split(/[?#]/)[0]?.split("/").filter(Boolean).at(-1) ?? "";
  return UUID.test(fromPath) ? fromPath.toLowerCase() : "";
};

/** The absolute URL of a checkout — the thing a payer bookmarks or pastes. */
export const checkoutUrlFor = (reference: string): string => {
  const path = buttonsCheckoutResume.checkoutPath(reference);
  if (typeof globalThis.location === "undefined") return path;
  return new URL(path, globalThis.location.origin).toString();
};

/** The reference the current URL names, or "" on the shop. */
export const referenceInLocation = (): string => {
  if (typeof globalThis.location === "undefined") return "";
  return buttonsCheckoutResume.parseReference(globalThis.location.pathname) ?? "";
};
