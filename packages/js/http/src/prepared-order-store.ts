/**
 * Prepared-order amount-authority persistence for the shipped HTTP handler.
 *
 * POST /prepare persists `{ amount, summary?, metadata? }` under `host_order:<orderId>`.
 * POST /checkouts and GET /orders/{id}/summary read that row back.
 */

export const PREPARED_ORDER_META_PREFIX = "host_order:" as const;

export interface PreparedOrderMetaRow {
  readonly value: string;
  readonly rev: number;
}

export interface PreparedOrderMetaStore {
  getMeta(key: string): PreparedOrderMetaRow | undefined | Promise<PreparedOrderMetaRow | undefined>;
  casMeta(
    key: string,
    value: string,
    expectedRev: number | null,
  ):
    | { status: "ok" | "conflict"; row: PreparedOrderMetaRow }
    | Promise<{ status: "ok" | "conflict"; row: PreparedOrderMetaRow }>;
}

export type PreparedOrderAmount =
  | { readonly sats: number | string; readonly currency?: never; readonly value?: never }
  | {
      readonly currency: string;
      readonly value: string;
      readonly sats?: never;
    };

export interface StoredPreparedOrder {
  readonly amount: PreparedOrderAmount;
  readonly summary?: unknown;
  readonly metadata?: Record<string, unknown>;
}

export interface PreparedOrderStore {
  persist(orderId: string, stored: StoredPreparedOrder): Promise<void>;
  read(orderId: string): Promise<StoredPreparedOrder | null>;
}

export function createPreparedOrderStore(
  store: PreparedOrderMetaStore,
  prefix: string = PREPARED_ORDER_META_PREFIX,
): PreparedOrderStore {
  if (prefix.length === 0) {
    throw new Error("createPreparedOrderStore: prefix must be non-empty");
  }

  function metaKey(orderId: string): string {
    if (typeof orderId !== "string" || orderId.length === 0) {
      throw new TypeError("createPreparedOrderStore: orderId must be a non-empty string");
    }
    return `${prefix}${orderId}`;
  }

  return {
    async persist(orderId, stored) {
      const key = metaKey(orderId);
      const payload = JSON.stringify(stored);
      const current = await store.getMeta(key);
      const first = await store.casMeta(key, payload, current === undefined ? null : current.rev);
      if (first.status === "ok") return;
      const again = await store.getMeta(key);
      const second = await store.casMeta(key, payload, again === undefined ? null : again.rev);
      if (second.status !== "ok") {
        throw new Error("createPreparedOrderStore: failed to persist prepared order");
      }
    },
    async read(orderId) {
      const row = await store.getMeta(metaKey(orderId));
      if (row === undefined) return null;
      try {
        const parsed = JSON.parse(row.value) as unknown;
        if (!isStoredPreparedOrder(parsed)) return null;
        return parsed;
      } catch {
        return null;
      }
    },
  };
}

function isStoredPreparedOrder(value: unknown): value is StoredPreparedOrder {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.amount !== "object" || record.amount === null) return false;
  const amount = record.amount as Record<string, unknown>;
  if (typeof amount.sats === "string" || typeof amount.sats === "number") return true;
  return typeof amount.currency === "string" && typeof amount.value === "string";
}
