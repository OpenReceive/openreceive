/**
 * Per-order capability-token store for the OpenReceive browser client.
 *
 * The mounted create route (`@openreceive/express` et al.) mints a one-time
 * `order_access_token` — a bearer capability scoped to a single order — and returns it
 * alongside the checkout. This module remembers that token keyed by `order_id` so every
 * later status poll and swap action for the same order can attach
 * `Authorization: Bearer <token>` automatically. The developer never handles the token:
 * `requestCheckout(...)` stores it and the status/swap request paths attach it.
 *
 * The token is a secret and must never be logged. The browser log redaction already
 * strips `authorization`/`token` keys, and this module only ever surfaces the token as an
 * `Authorization` header value (a redacted key) — it is never placed in a log field.
 *
 * Storage is an in-memory `Map`, mirrored to `sessionStorage` when it is available so a
 * full page reload keeps the same order authorized. All `sessionStorage` access is guarded
 * for SSR/Node (no `sessionStorage` global) and wrapped in try/catch (private-mode quota,
 * storage disabled). Dependency-free and framework-agnostic.
 */

const STORAGE_KEY_PREFIX = "openreceive.order_token." as const;

const orderAccessTokens = new Map<string, string>();

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Return `sessionStorage` when it is usable, otherwise `undefined`. Accessing the global
 * can throw in some sandboxed contexts, so the read itself is guarded.
 */
function sessionStore(): Storage | undefined {
  try {
    if (typeof sessionStorage === "undefined") return undefined;
    return sessionStorage;
  } catch {
    return undefined;
  }
}

function storageKey(orderId: string): string {
  return `${STORAGE_KEY_PREFIX}${orderId}`;
}

/**
 * Remember the capability token for an order. Empty `orderId`/`token` values are ignored so
 * callers can pass through optional server fields without pre-checking them.
 */
export function rememberOrderAccessToken(orderId: string, token: string): void {
  if (!nonEmptyString(orderId) || !nonEmptyString(token)) return;
  orderAccessTokens.set(orderId, token);
  const store = sessionStore();
  if (store === undefined) return;
  try {
    store.setItem(storageKey(orderId), token);
  } catch {
    // Persistence is best-effort; the in-memory map still authorizes this session.
  }
}

/** Return the stored capability token for an order, or `undefined` when none is known. */
export function getOrderAccessToken(orderId: string): string | undefined {
  if (!nonEmptyString(orderId)) return undefined;
  const cached = orderAccessTokens.get(orderId);
  if (cached !== undefined) return cached;
  const store = sessionStore();
  if (store === undefined) return undefined;
  try {
    const stored = store.getItem(storageKey(orderId));
    if (nonEmptyString(stored)) {
      orderAccessTokens.set(orderId, stored);
      return stored;
    }
  } catch {
    // A failed read simply means no token is available.
  }
  return undefined;
}

/**
 * Build the `Authorization` header for an order's capability token, or `undefined` when no
 * token is known (or `orderId` is missing). Returning `undefined` lets callers spread the
 * result unconditionally — `{ ...orderAccessTokenHeaders(id) }` adds nothing when absent.
 */
export function orderAccessTokenHeaders(
  orderId: string | undefined,
): Record<string, string> | undefined {
  if (!nonEmptyString(orderId)) return undefined;
  const token = getOrderAccessToken(orderId);
  if (token === undefined) return undefined;
  return { Authorization: `Bearer ${token}` };
}

/** Forget the capability token for a single order (test/cleanup helper). */
export function forgetOrderAccessToken(orderId: string): void {
  if (!nonEmptyString(orderId)) return;
  orderAccessTokens.delete(orderId);
  const store = sessionStore();
  if (store === undefined) return;
  try {
    store.removeItem(storageKey(orderId));
  } catch {
    // Removal is best-effort.
  }
}

/** Forget every stored capability token (test/cleanup helper). */
export function clearOrderAccessTokens(): void {
  orderAccessTokens.clear();
  const store = sessionStore();
  if (store === undefined) return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key?.startsWith(STORAGE_KEY_PREFIX)) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  } catch {
    // Removal is best-effort.
  }
}
