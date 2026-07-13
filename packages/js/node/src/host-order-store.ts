/**
 * Prepared-order amount-authority persistence backed by the OpenReceive store meta KV.
 *
 * Pattern (shipped-router model):
 * - POST /prepare calls the host `prepareCheckout` hook, then persists
 *   `{ amount, summary?, metadata? }` under `host_order:<orderId>` via `casMeta(..., null)`.
 * - POST /checkouts reads that row back for the authoritative price.
 * - GET /orders/{id}/summary returns the persisted `summary`.
 * - The create body never carries a client price.
 */

import type { CheckoutAmountSource } from "./get-checkout-amount.ts";
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
 * Durable record written by POST /prepare. `amount` is the authority for create-checkout.
 * Optional `summary` is returned by the order-summary route for guest resume UI.
 */
export interface StoredHostOrder<TSummary = unknown> {
  readonly amount: CreateCheckoutAmount;
  readonly summary?: TSummary;
  readonly metadata?: Record<string, unknown>;
}

export interface HostOrderStoreOptions {
  /** Meta key prefix. Default {@link HOST_ORDER_META_PREFIX}. */
  readonly prefix?: string;
}

export interface HostOrderStore<TSummary = unknown> {
  readonly prefix: string;
  metaKey(orderId: string): string;
  persist(orderId: string, stored: StoredHostOrder<TSummary>): Promise<void>;
  read(orderId: string): Promise<StoredHostOrder<TSummary> | null>;
  getAmount(orderId: string): Promise<CheckoutAmountSource | null>;
}

/**
 * Create a prepared-order store over `service.store` (or any getMeta/casMeta surface).
 * Used internally by the HTTP handler; hosts normally only implement `prepareCheckout`.
 */
export function createHostOrderStore<TSummary = unknown>(
  store: HostOrderMetaStore,
  options: HostOrderStoreOptions = {},
): HostOrderStore<TSummary> {
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

  async function persist(orderId: string, stored: StoredHostOrder<TSummary>): Promise<void> {
    const key = metaKey(orderId);
    const payload = JSON.stringify(stored);
    const current = await store.getMeta(key);
    const first = await store.casMeta(key, payload, current === undefined ? null : current.rev);
    if (first.status === "ok") return;
    const again = await store.getMeta(key);
    const second = await store.casMeta(key, payload, again === undefined ? null : again.rev);
    if (second.status !== "ok") {
      throw new Error("createHostOrderStore: failed to persist prepared order");
    }
  }

  async function read(orderId: string): Promise<StoredHostOrder<TSummary> | null> {
    const row = await store.getMeta(metaKey(orderId));
    if (row === undefined) return null;
    try {
      const parsed = JSON.parse(row.value) as unknown;
      if (!isStoredHostOrder(parsed)) return null;
      return parsed as StoredHostOrder<TSummary>;
    } catch {
      return null;
    }
  }

  async function getAmount(orderId: string): Promise<CheckoutAmountSource | null> {
    const stored = await read(orderId);
    return stored === null ? null : { amount: stored.amount };
  }

  return {
    prefix,
    metaKey,
    persist,
    read,
    getAmount,
  };
}

function isStoredHostOrder(value: unknown): value is StoredHostOrder {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.amount !== "object" || record.amount === null) return false;
  const amount = record.amount as Record<string, unknown>;
  if (typeof amount.sats === "string" || typeof amount.sats === "number") return true;
  return typeof amount.currency === "string" && typeof amount.value === "string";
}
