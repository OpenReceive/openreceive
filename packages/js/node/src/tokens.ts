import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// Capability tokens (PART 2 of the route-shipping spec).
//
// On checkout creation the route mints a high-entropy, URL-safe per-order token and
// returns it once as `order_access_token`. Only its sha256 hash is stored. Tier-2 reads
// present the raw token (Authorization: Bearer / X-OpenReceive-Order-Token) and the route
// verifies it by hashing and comparing to the stored hash for that order.
//
// The hash is persisted in the store's meta KV under `order_access_token:<orderId>`. Every
// OpenReceive store (Postgres, SQLite, in-memory, Ruby ActiveRecord) already implements
// getMeta/casMeta, so this needs no schema migration and stays identical across backends.
// `casMeta(key, hash, null)` is insert-if-absent, which gives write-once minting for free:
// the first checkout under an order mints; later checkouts replay the same order token.

export const ORDER_ACCESS_TOKEN_META_PREFIX = "order_access_token:";

/** Minimum entropy for a capability token (bits). We use 256 (32 random bytes). */
export const ORDER_ACCESS_TOKEN_BYTES = 32;

export interface OrderAccessTokenMetaRow {
  readonly value: string;
  readonly rev: number;
}

/**
 * Minimal structural view of the meta KV surface a token manager needs. Every OpenReceive
 * store satisfies this; typing it structurally keeps the token layer decoupled from the
 * concrete store implementation so it can wrap `service.store` directly.
 */
export interface OrderAccessTokenMetaStore {
  getMeta(
    key: string,
  ): OrderAccessTokenMetaRow | undefined | Promise<OrderAccessTokenMetaRow | undefined>;
  casMeta(
    key: string,
    value: string,
    expectedRev: number | null,
  ):
    | { status: "ok" | "conflict"; row: OrderAccessTokenMetaRow }
    | Promise<{ status: "ok" | "conflict"; row: OrderAccessTokenMetaRow }>;
}

export interface OrderAccessTokenMintResult {
  /** The raw token — present ONLY when this call minted it (first checkout for the order). */
  readonly token?: string;
  /** The stored sha256 hash (`sha256:<64hex>`). Always present. */
  readonly token_hash: string;
  /** True when this call minted a new token; false when an existing order token was replayed. */
  readonly created: boolean;
}

export interface OrderAccessTokenManager {
  mint(orderId: string): Promise<OrderAccessTokenMintResult>;
  verify(orderId: string, token: string | null | undefined): Promise<boolean>;
  metaKey(orderId: string): string;
}

export interface OrderAccessTokenManagerOptions {
  /** Optional namespace prefix so multiple tenants in one meta table never collide. */
  readonly namespace?: string;
  /** Injectable token generator (tests). Must return ≥128 bits of URL-safe entropy. */
  readonly generateToken?: () => string;
}

/** Hash a raw capability token into the stored form (`sha256:<64hex>`). */
export function hashOrderAccessToken(token: string): string {
  return `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

/** Generate a fresh URL-safe capability token with ≥128 bits of entropy (default 256). */
export function generateOrderAccessToken(): string {
  return randomBytes(ORDER_ACCESS_TOKEN_BYTES).toString("base64url");
}

/** Build the meta key for an order's stored token hash. */
export function orderAccessTokenMetaKey(orderId: string, namespace?: string): string {
  const scope = namespace && namespace !== "default" ? `${namespace}:` : "";
  return `${ORDER_ACCESS_TOKEN_META_PREFIX}${scope}${orderId}`;
}

function assertOrderId(orderId: string): void {
  if (typeof orderId !== "string" || orderId.length === 0) {
    throw new TypeError("order access token orderId must be a non-empty string");
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) {
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

/**
 * Create a per-order capability-token manager backed by the store's meta KV.
 * `store` only needs getMeta/casMeta (present on every OpenReceive store).
 */
export function createOrderAccessTokenManager(
  store: OrderAccessTokenMetaStore,
  options: OrderAccessTokenManagerOptions = {},
): OrderAccessTokenManager {
  const generate = options.generateToken ?? generateOrderAccessToken;
  const metaKey = (orderId: string): string => {
    assertOrderId(orderId);
    return orderAccessTokenMetaKey(orderId, options.namespace);
  };

  return {
    metaKey,
    async mint(orderId: string): Promise<OrderAccessTokenMintResult> {
      const key = metaKey(orderId);
      const existing = await store.getMeta(key);
      if (existing) {
        return { token_hash: existing.value, created: false };
      }
      const token = generate();
      const tokenHash = hashOrderAccessToken(token);
      const result = await store.casMeta(key, tokenHash, null);
      if (result.status === "ok") {
        return { token, token_hash: tokenHash, created: true };
      }
      // Lost a mint race with a concurrent checkout: replay the winner's hash, no token.
      const winner = await store.getMeta(key);
      return { token_hash: winner?.value ?? result.row.value, created: false };
    },
    async verify(orderId: string, token: string | null | undefined): Promise<boolean> {
      if (typeof token !== "string" || token.length === 0) {
        return false;
      }
      const existing = await store.getMeta(metaKey(orderId));
      if (!existing) {
        return false;
      }
      return constantTimeEquals(hashOrderAccessToken(token), existing.value);
    },
  };
}
