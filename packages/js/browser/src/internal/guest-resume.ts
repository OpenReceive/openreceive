/**
 * Guest checkout resume helpers for no-account content sites.
 *
 * Pattern:
 * - Put the public `order_id` in the URL (`/checkout/:orderId`) so refresh/share works.
 * - Let the host authorize access to the order using its normal session or guest-order policy.
 * - Mirror an optional host order summary in sessionStorage for instant same-tab restore;
 *   fall back to `GET {prefix}/orders/{orderId}/summary` (or a host `fetchOrder`) when
 *   storage is empty (new tab with the same link).
 *
 * Prefer baking summary restore into `<Checkout orderId>` / `<openreceive-checkout order-id>`
 * (always on in create mode). Opt into History API URL sync with `syncUrl` / `sync-url` when
 * the host wants `/checkout/:orderId` in the address bar. Keep this module for hosts that
 * need custom storage keys or URL shapes.
 *
 */

export interface GuestCheckoutResumeOptions<TOrder> {
  /**
   * URL path prefix before the order id. Default `"/checkout"` → `/checkout/:orderId`.
   * Leading/trailing slashes are normalized.
   */
  readonly pathPrefix?: string;
  /** sessionStorage key prefix for host order summaries (required so hosts do not collide). */
  readonly storageKeyPrefix: string;
  /** Extract the public order id used as the storage/URL key. */
  readonly orderIdOf: (order: TOrder) => string;
  /** Validate a value from storage or a fetch body as a host order. */
  readonly parseOrder: (value: unknown) => TOrder | undefined;
  /**
   * Load an order when sessionStorage misses (new tab / shared link).
   * Return `undefined` for missing or unauthorized orders.
   */
  readonly fetchOrder?: (orderId: string) => Promise<TOrder | undefined>;
  /** Path to push when leaving a checkout URL. Default `"/"`. */
  readonly homePath?: string;
}

export interface GuestCheckoutResumeController<TOrder> {
  /** Normalized path prefix including a leading slash, e.g. `"/checkout"`. */
  readonly pathPrefix: string;
  checkoutPath(orderId: string): string;
  /** Parse `/checkout/:orderId` from a pathname. Returns undefined when not a resume URL. */
  parseOrderId(pathname: string): string | undefined;
  rememberOrder(order: TOrder): void;
  readRememberedOrder(orderId: string): TOrder | undefined;
  /** Forget one order, or every order under this storage prefix when `orderId` is omitted. */
  forgetOrder(orderId?: string): void;
  /** Push the checkout path when not already there (History API / SPAs). */
  enterCheckout(orderId: string): void;
  /** Return to `homePath` when the current location is a checkout resume URL. */
  leaveCheckout(): void;
  /** sessionStorage first, then optional `fetchOrder`. */
  loadOrderForResume(orderId: string): Promise<TOrder | undefined>;
}

/**
 * Create a host-owned guest resume controller. OpenReceive does not invent a host session —
 * this is the reusable URL + sessionStorage glue so demos (and apps) do not copy-paste it.
 */
export function createGuestCheckoutResume<TOrder>(
  options: GuestCheckoutResumeOptions<TOrder>,
): GuestCheckoutResumeController<TOrder> {
  const pathPrefix = normalizePathPrefix(options.pathPrefix ?? "/checkout");
  const pathSegment = pathPrefix.slice(1);
  const storageKeyPrefix = options.storageKeyPrefix;
  if (storageKeyPrefix.length === 0) {
    throw new Error("createGuestCheckoutResume: storageKeyPrefix must be non-empty");
  }
  const homePath = options.homePath ?? "/";

  function checkoutPath(orderId: string): string {
    return `${pathPrefix}/${encodeURIComponent(orderId)}`;
  }

  function parseOrderId(pathname: string): string | undefined {
    const segments = pathname.split("/").filter((segment) => segment.length > 0);
    if (segments.length !== 2 || segments[0] !== pathSegment) return undefined;
    const raw = segments[1];
    if (raw === undefined || raw.length === 0) return undefined;
    let orderId: string;
    try {
      orderId = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
    if (orderId.length === 0 || orderId.includes("/") || orderId.includes("..")) return undefined;
    return orderId;
  }

  function orderStorageKey(orderId: string): string {
    return `${storageKeyPrefix}${orderId}`;
  }

  function rememberOrder(order: TOrder): void {
    const orderId = options.orderIdOf(order);
    if (orderId.length === 0) return;
    const store = sessionStore();
    if (store === undefined) return;
    try {
      store.setItem(orderStorageKey(orderId), JSON.stringify(order));
    } catch {
      // Best-effort; fetchOrder can still restore display.
    }
  }

  function readRememberedOrder(orderId: string): TOrder | undefined {
    const store = sessionStore();
    if (store === undefined) return undefined;
    try {
      const raw = store.getItem(orderStorageKey(orderId));
      if (raw === null || raw.length === 0) return undefined;
      return options.parseOrder(JSON.parse(raw) as unknown);
    } catch {
      return undefined;
    }
  }

  function forgetOrder(orderId?: string): void {
    const store = sessionStore();
    if (store === undefined) return;
    try {
      if (orderId !== undefined) {
        store.removeItem(orderStorageKey(orderId));
        return;
      }
      const keys: string[] = [];
      for (let index = 0; index < store.length; index += 1) {
        const key = store.key(index);
        if (key?.startsWith(storageKeyPrefix)) keys.push(key);
      }
      for (const key of keys) store.removeItem(key);
    } catch {
      // Ignore storage failures on reset.
    }
  }

  function enterCheckout(orderId: string): void {
    enterCheckoutResumePath(orderId, { pathPrefix });
  }

  function leaveCheckout(): void {
    if (typeof globalThis.location === "undefined") return;
    if (parseOrderId(globalThis.location.pathname) === undefined) return;
    globalThis.history.pushState({}, "", homePath);
  }

  async function loadOrderForResume(orderId: string): Promise<TOrder | undefined> {
    const remembered = readRememberedOrder(orderId);
    if (remembered !== undefined) return remembered;
    if (options.fetchOrder === undefined) return undefined;
    try {
      const fetched = await options.fetchOrder(orderId);
      if (fetched === undefined) return undefined;
      rememberOrder(fetched);
      return fetched;
    } catch {
      return undefined;
    }
  }

  return {
    pathPrefix,
    checkoutPath,
    parseOrderId,
    rememberOrder,
    readRememberedOrder,
    forgetOrder,
    enterCheckout,
    leaveCheckout,
    loadOrderForResume,
  };
}

/**
 * Push `/checkout/:orderId` (or a custom path prefix) via the History API when not already
 * there. Used by `<Checkout syncUrl>` and hosts that sync the URL after prepare.
 * No-ops when `routeOrderId` is provided (app router already owns the URL).
 */
export function enterCheckoutResumePath(
  orderId: string,
  options: {
    readonly pathPrefix?: string;
    /** When set, skip History API sync (Next.js / file-based routes own the URL). */
    readonly routeOrderId?: string;
  } = {},
): void {
  if (options.routeOrderId !== undefined) return;
  if (orderId.length === 0) return;
  const pathPrefix = normalizePathPrefix(options.pathPrefix ?? "/checkout");
  const path = `${pathPrefix}/${encodeURIComponent(orderId)}`;
  if (typeof globalThis.location === "undefined") return;
  if (globalThis.location.pathname === path) return;
  globalThis.history.pushState({ openreceiveCheckout: orderId }, "", path);
}

/**
 * Guest resume fetch for a host-owned order endpoint. OpenReceive ships no order-read route.
 * Pass the result as `fetchOrder` to {@link createGuestCheckoutResume}.
 */
export function createGuestOrderFetcher<TOrder>(options: {
  readonly parseOrder: (value: unknown) => TOrder | undefined;
  /**
   * Build the host application's order URL.
   */
  readonly orderUrl: (orderId: string) => string;
  readonly fetch?: typeof globalThis.fetch;
}): (orderId: string) => Promise<TOrder | undefined> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const orderUrl = options.orderUrl;
  return async (orderId: string): Promise<TOrder | undefined> => {
    const response = await fetchFn(orderUrl(orderId));
    if (response.status === 404 || !response.ok) return undefined;
    const body = (await response.json()) as unknown;
    if (typeof body !== "object" || body === null) return undefined;
    const record = body as Record<string, unknown>;
    if ("summary" in record) return options.parseOrder(record.summary);
    if ("order" in record) return options.parseOrder(record.order);
    return undefined;
  };
}

function normalizePathPrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+|\/+$/g, "");
  if (trimmed.length === 0) {
    throw new Error("createGuestCheckoutResume: pathPrefix must be non-empty");
  }
  if (trimmed.includes("/") || trimmed.includes("..")) {
    throw new Error("createGuestCheckoutResume: pathPrefix must be a single path segment");
  }
  return `/${trimmed}`;
}

function sessionStore(): Storage | undefined {
  try {
    if (typeof sessionStorage === "undefined") return undefined;
    return sessionStorage;
  } catch {
    return undefined;
  }
}
