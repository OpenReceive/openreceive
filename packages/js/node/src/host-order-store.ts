/**
 * Host order amount-authority persistence backed by the OpenReceive store meta KV.
 *
 * Pattern (shipped-router model):
 * - Host `/prepare_order` validates the cart, computes the price, and persists
 *   `{ amount, … }` under `host_order:<orderId>` via `casMeta(..., null)`.
 * - Mounted create-checkout calls `getCheckoutAmount`, which reads that row back.
 * - The create body never carries a client price.
 *
 * Hosts keep cart validation / catalog / display order shapes in app code; this
 * module owns only the durable persist-and-read-back plumbing.
 */

import type { CheckoutAmountSource, GetCheckoutAmount } from "./get-checkout-amount.ts";
import type { CreateCheckoutAmount } from "./service/types.ts";

export const HOST_ORDER_META_PREFIX = "host_order:" as const;

export interface HostOrderMetaRow {
  readonly value: string;
  readonly rev: number;
}

/** Minimal structural view of the meta KV surface (every OpenReceive store satisfies this). */
export interface HostOrderMetaStore {
  getMeta(key: string): HostOrderMetaRow | undefined | Promise<HostOrderMetaRow | undefined>;
  casMeta(
    key: string,
    value: string,
    expectedRev: number | null,
  ):
    | { status: "ok" | "conflict"; row: HostOrderMetaRow }
    | Promise<{ status: "ok" | "conflict"; row: HostOrderMetaRow }>;
}

/**
 * Durable record written by the host prepare step. `amount` is the authority for
 * `getCheckoutAmount`. Optional `order` holds a host display summary for guest resume.
 */
export interface StoredHostOrder<TOrder = unknown> {
  readonly amount: CreateCheckoutAmount;
  readonly order?: TOrder;
  readonly metadata?: Record<string, unknown>;
}

export interface HostOrderStoreOptions {
  /** Meta key prefix. Default {@link HOST_ORDER_META_PREFIX}. */
  readonly prefix?: string;
}

export interface HostOrderStore<TOrder = unknown> {
  readonly prefix: string;
  metaKey(orderId: string): string;
  persist(orderId: string, stored: StoredHostOrder<TOrder>): Promise<void>;
  read(orderId: string): Promise<StoredHostOrder<TOrder> | null>;
  getCheckoutAmount(orderId: string): Promise<CheckoutAmountSource | null>;
  /** Bound hook for `createOpenReceiveHttpHandler({ getCheckoutAmount })`. */
  createGetCheckoutAmount(): GetCheckoutAmount;
}

/**
 * Create a host order store over `service.store` (or any getMeta/casMeta surface).
 *
 * @example
 * ```ts
 * const orders = createHostOrderStore(service.store);
 * await orders.persist(orderId, { amount: { currency: "USD", value: "9.99" }, order });
 * app.use(openReceiveExpress({
 *   service,
 *   getCheckoutAmount: orders.createGetCheckoutAmount(),
 * }));
 * ```
 */
export function createHostOrderStore<TOrder = unknown>(
  store: HostOrderMetaStore,
  options: HostOrderStoreOptions = {},
): HostOrderStore<TOrder> {
  const prefix = options.prefix ?? HOST_ORDER_META_PREFIX;
  if (prefix.length === 0) {
    throw new Error("createHostOrderStore: prefix must be non-empty");
  }

  function metaKey(orderId: string): string {
    if (typeof orderId !== "string" || orderId.length === 0) {
      throw new TypeError("createHostOrderStore: orderId must be a non-empty string");
    }
    return `${prefix}${orderId}`;
  }

  async function persist(orderId: string, stored: StoredHostOrder<TOrder>): Promise<void> {
    await store.casMeta(metaKey(orderId), JSON.stringify(stored), null);
  }

  async function read(orderId: string): Promise<StoredHostOrder<TOrder> | null> {
    const row = await store.getMeta(metaKey(orderId));
    if (row === undefined) return null;
    try {
      const parsed = JSON.parse(row.value) as unknown;
      if (!isStoredHostOrder(parsed)) return null;
      return parsed as StoredHostOrder<TOrder>;
    } catch {
      return null;
    }
  }

  async function getCheckoutAmount(orderId: string): Promise<CheckoutAmountSource | null> {
    const stored = await read(orderId);
    return stored === null ? null : { amount: stored.amount };
  }

  function createGetCheckoutAmount(): GetCheckoutAmount {
    return ({ orderId }) => getCheckoutAmount(orderId);
  }

  return {
    prefix,
    metaKey,
    persist,
    read,
    getCheckoutAmount,
    createGetCheckoutAmount,
  };
}

function isStoredHostOrder(value: unknown): value is StoredHostOrder {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.amount !== "object" || record.amount === null) return false;
  const amount = record.amount as Record<string, unknown>;
  if (typeof amount.sats === "string") return true;
  return typeof amount.currency === "string" && typeof amount.value === "string";
}
