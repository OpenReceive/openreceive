import {
  OPENRECEIVE_ON_PAID_STUB_MARKER,
  OPENRECEIVE_PAYMENTS_SCHEMA_VERSION,
  OPENRECEIVE_SUPABASE_FUNCTIONS_VERSION,
  unixSeconds,
} from "@openreceive/core";
import { hostError } from "./errors.ts";
import type { CheckoutCreatedInput } from "./handler.ts";
import { checkpointMetaGate, claimMetaGate, type MetaStore } from "./meta-gate.ts";
import {
  liveAttemptCommitDecision,
  type PaymentRecord,
  type PaymentRepository,
  paymentInsert,
  type ReconcileCursor,
  type ReconciliationTransition,
  type SettlementRecord,
} from "./payment-repository.ts";
import {
  asInteger,
  OPENRECEIVE_RECONCILE_BATCH_SIZE,
  reconcilableFromRow,
  recordFromRow,
} from "./payment-rows.ts";

// Payment attempts in Supabase, reached over Supabase's HTTPS API (PostgREST)
// instead of a Postgres connection. Cloudflare Workers, where Lovable's apps
// run, cannot open TLS to Supabase's database: its certificate comes from a
// private authority, and a Worker's sockets accept no custom one. The HTTPS
// API has a public certificate and works from any runtime with `fetch`.
//
// PostgREST runs each request as its own transaction, so no transaction can
// stay open across the JS decisions the SQL repository makes under its lock.
// Instead JS decides on a snapshot of the reference's rows, and one SQL
// function (from `openreceive scaffold payments --supabase`) takes the same
// per-reference lock, checks the snapshot still holds, and writes. If another
// writer got there first it raises SQLSTATE 40001, and JS reads and decides
// again. Every write to openreceive_payments goes through such a function.
//
// Fulfillment is SQL too: the settlement function calls the host's
// `public.openreceive_on_paid` inside its transaction for the reference's first
// settled attempt, which keeps the exactly-once guarantee of `onPaid` in db
// mode. There is no JS `onPaid` here.

/** How a server reaches its Supabase project. */
export interface SupabaseStorageOptions {
  /** The project URL, `https://<project-ref>.supabase.co` (`SUPABASE_URL`). */
  readonly url: string;
  /**
   * The project's secret key (`sb_secret_…`) or its legacy `service_role`
   * key. Server-only: never in a `VITE_` or `NEXT_PUBLIC_` variable, never in
   * browser code, never in logs.
   */
  readonly key: string;
  /** A `fetch` to use instead of the global one. */
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
}

interface SupabasePaymentsOptions extends SupabaseStorageOptions {
  readonly clock?: () => number;
}

export interface SupabasePaymentRepository extends PaymentRepository<never> {
  /**
   * Record this pending attempt's settlement. For the reference's first
   * settled attempt, `public.openreceive_on_paid` runs in the same
   * transaction, and the call returns true. A failure there records nothing.
   */
  recordSettlement(settlement: SettlementRecord): Promise<boolean>;
}

/** Bounded re-reads when another writer changed the reference first. */
const STALE_RETRIES = 8;
/** A storage check that passed is trusted this long within one process or isolate. */
const STATUS_CACHE_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const SUPABASE_REPOSITORY = Symbol.for("openreceive.supabase-payments");
const PAYMENTS = "openreceive_payments";
const META = "openreceive_meta";
const RECONCILE_COLUMNS = "payment_hash,created_at,checkout_data";

/** Checks that passed, by project URL and key, so a Worker's per-request stack skips them. */
const verifiedStorage = new Map<string, number>();

/** True for a repository from `createSupabasePayments`. */
export function isSupabasePayments(value: unknown): value is SupabasePaymentRepository {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[SUPABASE_REPOSITORY] === true
  );
}

/**
 * The payment repository for Supabase over its HTTPS API. Apply the migration
 * from `npx openreceive scaffold payments --supabase` first; the repository
 * refuses to serve until the functions are in place, `openreceive_on_paid` is
 * yours, and Supabase's `anon` and `authenticated` roles can reach none of it.
 */
export function createSupabasePayments(
  options: SupabasePaymentsOptions,
): SupabasePaymentRepository {
  const base = restBase(options.url);
  const key = checkedKey(options.key);
  const send = options.fetch ?? globalThis.fetch;
  const clock = options.clock ?? unixSeconds;
  // The new keys are not JWTs and go in `apikey` only; the legacy JWT keys
  // also go in Authorization, as supabase-js sends them.
  const authHeaders: Record<string, string> = isJwt(key)
    ? { apikey: key, authorization: `Bearer ${key}` }
    : { apikey: key };

  const call = async (
    method: string,
    path: string,
    init: {
      readonly query?: Readonly<Record<string, string>>;
      readonly body?: unknown;
      readonly prefer?: string;
    } = {},
  ): Promise<Response> => {
    const target = new URL(`${base}/${path}`);
    for (const [name, value] of Object.entries(init.query ?? {}))
      target.searchParams.set(name, value);
    const headers: Record<string, string> = { ...authHeaders, accept: "application/json" };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.prefer !== undefined) headers.prefer = init.prefer;
    const response = await send(target.toString(), {
      method,
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(typeof AbortSignal.timeout === "function"
        ? { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
        : {}),
    });
    if (!response.ok) {
      const error = await supabaseError(response, method, path);
      // A table or function PostgREST cannot find is a migration that never
      // ran (or a schema cache that has not caught up), not a request to blame.
      if (error.code === "PGRST202" || error.code === "PGRST205") throw notReady(diagnose(error));
      throw error;
    }
    return response;
  };
  const select = async (
    table: string,
    query: Readonly<Record<string, string>>,
  ): Promise<Record<string, unknown>[]> =>
    (await (await call("GET", table, { query })).json()) as Record<string, unknown>[];
  const rpc = async (name: string, args: Readonly<Record<string, unknown>>): Promise<unknown> => {
    const response = await call("POST", `rpc/${name}`, { body: args });
    const text = await response.text();
    return text.length === 0 ? null : JSON.parse(text);
  };

  // Once per process (or Worker isolate) per minute: the functions are this
  // library's generation, openreceive_on_paid is the host's own, and the Data
  // API's public roles reach nothing. A failed check is not remembered, so a
  // fixed database serves on the next request.
  const cacheKey = `${base}\u0000${key}`;
  let verified: Promise<void> | undefined;
  const verify = (): Promise<void> => {
    const until = verifiedStorage.get(cacheKey);
    if (until !== undefined && until > Date.now()) return Promise.resolve();
    verified ??= (async () => {
      const status = await rpc("openreceive_supabase_status", {}).catch((error: unknown) => {
        throw error instanceof SupabaseStorageNotReady ? error : notReady(diagnose(error));
      });
      const problem = storageProblem(status);
      if (problem !== undefined) throw notReady(problem);
      verifiedStorage.set(cacheKey, Date.now() + STATUS_CACHE_MS);
    })().finally(() => {
      verified = undefined;
    });
    return verified;
  };

  const rowsForReference = async (reference: string): Promise<readonly PaymentRecord[]> =>
    (
      await select(PAYMENTS, {
        select: "*",
        reference: `eq.${reference}`,
        order: "created_at.desc,payment_hash.desc",
      })
    ).map(recordFromRow);

  const findByPaymentHash = async (paymentHash: string): Promise<PaymentRecord | undefined> => {
    const rows = await select(PAYMENTS, {
      select: "*",
      payment_hash: `eq.${paymentHash.toLowerCase()}`,
    });
    return rows[0] === undefined ? undefined : recordFromRow(rows[0]);
  };

  /** Re-read and decide again whenever a write function reports the reference changed. */
  const retryStale = async <T>(attempt: () => Promise<T>): Promise<T> => {
    for (let tries = 0; tries < STALE_RETRIES; tries += 1) {
      try {
        return await attempt();
      } catch (error) {
        if (!(error instanceof SupabaseRequestError) || error.code !== "40001") throw error;
      }
    }
    throw new Error(
      `OpenReceive could not write a payment attempt: its reference kept changing across ${STALE_RETRIES} reads.`,
    );
  };

  // PostgREST returns the rows a write changed: one row back is the proof the
  // gate would otherwise read back, at one round trip less.
  const wroteOne = async (response: Response): Promise<boolean> => {
    const rows: unknown = await response.json();
    return Array.isArray(rows) && rows.length === 1;
  };
  const metaStore: MetaStore = {
    async read(metaKey) {
      const rows = await select(META, { select: "value,rev", key: `eq.${metaKey}`, limit: "1" });
      return rows[0] === undefined ? undefined : { value: rows[0].value, rev: rows[0].rev };
    },
    async insertIfAbsent(metaKey, value) {
      return wroteOne(
        await call("POST", META, {
          query: { select: "key" },
          body: { key: metaKey, value, rev: 0 },
          prefer: "resolution=ignore-duplicates,return=representation",
        }),
      );
    },
    async compareAndSet(metaKey, value, rev) {
      return wroteOne(
        await call("PATCH", META, {
          query: { key: `eq.${metaKey}`, rev: `eq.${rev}`, select: "key" },
          body: { value, rev: rev + 1 },
          prefer: "return=representation",
        }),
      );
    },
  };

  const repository: SupabasePaymentRepository = {
    async listForReference(reference) {
      await verify();
      return rowsForReference(reference);
    },

    async findByPaymentHash(paymentHash) {
      await verify();
      return findByPaymentHash(paymentHash);
    },

    async listReconcilableAttempts(after) {
      await verify();
      return (
        await select(PAYMENTS, {
          select: RECONCILE_COLUMNS,
          status: "eq.pending",
          ...(after == null ? {} : { or: keysetAfter(after) }),
          order: "created_at.asc,payment_hash.asc",
          limit: String(OPENRECEIVE_RECONCILE_BATCH_SIZE),
        })
      ).map(reconcilableFromRow);
    },

    async findPendingAttempt(paymentHash) {
      await verify();
      const rows = await select(PAYMENTS, {
        select: RECONCILE_COLUMNS,
        payment_hash: `eq.${paymentHash.toLowerCase()}`,
        status: "eq.pending",
      });
      return rows[0] === undefined ? undefined : reconcilableFromRow(rows[0]);
    },

    async claimReconcileGate(input) {
      await verify();
      return claimMetaGate(metaStore, input);
    },

    async checkpointReconcileGate(input) {
      await verify();
      return checkpointMetaGate(metaStore, input);
    },

    async countAttemptsFromIp(clientIp, sinceUnixSeconds) {
      await verify();
      // inserted_at, as in the SQL repository: stamped once and never moved.
      const response = await call("HEAD", PAYMENTS, {
        query: { client_ip: `eq.${clientIp}`, inserted_at: `gte.${sinceUnixSeconds}` },
        prefer: "count=exact",
      });
      const total = /\/(\d+)$/.exec(response.headers.get("content-range") ?? "")?.[1];
      if (total === undefined)
        throw new TypeError("Supabase did not report a row count for the rate limit.");
      return Number(total);
    },

    async commitAttempt(input: CheckoutCreatedInput) {
      await verify();
      const insert = paymentInsert(input);
      const now = clock();
      await retryStale(async () => {
        const existing = await rowsForReference(insert.reference);
        if (existing.some((row) => row.paymentHash === insert.paymentHash)) return;
        if (existing.some((row) => row.status === "settled")) {
          throw hostError("This reference is already paid.", 409, "CONFLICT");
        }
        // Exactly the SQL repository's rule: only a row still offered to a
        // payer counts as live, and a superseded row stays pending (and so
        // scanned) until a wallet scan closes it.
        const supersede: string[] = [];
        for (const row of existing) {
          if (row.status !== "pending" || row.expiresAt <= now || row.statusReason === "superseded")
            continue;
          const decision = liveAttemptCommitDecision(row, insert, now);
          if (decision === "conflict") {
            throw hostError(
              "An unpaid checkout for this payment method is already in progress for this reference.",
              409,
              "CONFLICT",
            );
          }
          if (decision === "supersede") supersede.push(row.paymentHash);
        }
        await rpc("openreceive_commit_attempt", {
          p_reference: insert.reference,
          p_snapshot: snapshot(existing),
          p_supersede: supersede,
          p_attempt: {
            payment_hash: insert.paymentHash,
            expires_at: insert.expiresAt,
            created_at: insert.createdAt,
            checkout_data: JSON.stringify(insert.checkout),
            swap_data: insert.swapData === undefined ? null : JSON.stringify(insert.swapData),
            client_ip: insert.clientIp ?? null,
          },
          p_now: now,
        });
      });
    },

    async recordReconciliation(transition: ReconciliationTransition) {
      await verify();
      await rpc("openreceive_record_reconciliation", {
        p_payment_hash: transition.paymentHash.toLowerCase(),
        p_status: transition.status,
        p_reason: transition.reason,
        p_observed_at: transition.observedAt,
      });
    },

    async recordSettlement(settlement) {
      await verify();
      const paymentHash = settlement.paymentHash.toLowerCase();
      return retryStale(async () => {
        const row = await findByPaymentHash(paymentHash);
        if (row === undefined || row.status !== "pending") return false;
        const rows = await rowsForReference(row.reference);
        const current = rows.find((candidate) => candidate.paymentHash === paymentHash);
        if (current === undefined || current.status !== "pending") return false;
        const first = !rows.some((candidate) => candidate.status === "settled");
        try {
          const won = await rpc("openreceive_record_settlement", {
            p_reference: row.reference,
            p_payment_hash: paymentHash,
            p_snapshot: snapshot(rows),
            p_paid_at: settlement.paidAt,
            p_first: first,
            p_now: clock(),
          });
          return won === true;
        } catch (error) {
          if (error instanceof SupabaseRequestError && error.code !== "40001")
            throw onPaidFailure(error);
          throw error;
        }
      });
    },

    recordSettlementWithFulfillment() {
      throw new TypeError(
        "Supabase storage fulfills in SQL: public.openreceive_on_paid runs inside the settlement " +
          "transaction. Pass storage: { supabase: { url, key } } without onPaid. " +
          "https://openreceive.org/guides/supabase.md",
      );
    },
  };
  Object.defineProperty(repository, SUPABASE_REPOSITORY, { value: true });
  return repository;
}

/** The reference's rows as the write functions compare them. */
function snapshot(rows: readonly PaymentRecord[]): readonly Record<string, string | null>[] {
  return rows
    .map((row) => ({
      payment_hash: row.paymentHash,
      status: row.status,
      status_reason: row.statusReason ?? null,
    }))
    .sort((left, right) =>
      left.payment_hash < right.payment_hash ? -1 : left.payment_hash > right.payment_hash ? 1 : 0,
    );
}

/** The keyset filter after a cursor, from values checked before they enter the filter. */
function keysetAfter(after: ReconcileCursor): string {
  const createdAt = asInteger(after.created_at, "cursor created_at");
  const paymentHash = after.payment_hash;
  if (!/^[0-9a-f]{64}$/.test(paymentHash))
    throw new TypeError("The reconcile cursor holds a malformed payment hash.");
  return `(created_at.gt.${createdAt},and(created_at.eq.${createdAt},payment_hash.gt.${paymentHash}))`;
}

function restBase(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError(
      "Supabase storage needs the project URL, https://<project-ref>.supabase.co (SUPABASE_URL).",
    );
  }
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && isPrivateHost(parsed.hostname))
  )
    throw new TypeError(
      "Supabase storage needs an https:// project URL: the server key must not cross a public " +
        "network in clear text. Plain http:// is accepted only for a private host (localhost, a " +
        "private IP, or a one-word name such as Docker's kong).",
    );
  const path = parsed.pathname.replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
  return `${parsed.origin}${path}/rest/v1`;
}

/**
 * Hosts that cannot be on the public internet: loopback, the private IPv4
 * ranges, and one-word names, which only resolve inside a private network
 * (self-hosted Supabase in Docker serves its API at http://kong:8000).
 */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (v4 !== null) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return !host.includes(".") && !host.includes(":");
}

function checkedKey(key: string): string {
  const trimmed = typeof key === "string" ? key.trim() : "";
  if (trimmed.length === 0)
    throw new TypeError(
      "Supabase storage needs the project's secret key (sb_secret_…) or service_role key, " +
        "server-side only (for example SUPABASE_SERVICE_ROLE_KEY).",
    );
  if (trimmed.startsWith("sb_publishable_"))
    throw new TypeError(
      "That is Supabase's publishable key, which every browser has. OpenReceive needs the secret " +
        "key (sb_secret_…) or the service_role key, kept on the server.",
    );
  const role = isJwt(trimmed) ? jwtRole(trimmed) : undefined;
  if (role === "anon")
    throw new TypeError(
      "That is Supabase's anon key, which every browser has. OpenReceive needs the service_role " +
        "key (or a secret key, sb_secret_…), kept on the server.",
    );
  if (typeof role === "string" && role !== "service_role")
    throw new TypeError(
      `That token's role is ${role}, not service_role: it looks like a user's session. ` +
        "OpenReceive needs the project's service_role key (or a secret key, sb_secret_…).",
    );
  return trimmed;
}

function isJwt(key: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key);
}

function jwtRole(token: string): unknown {
  try {
    const payload = token.split(".")[1] ?? "";
    const json = atob(payload.replaceAll("-", "+").replaceAll("_", "/"));
    return (JSON.parse(json) as { role?: unknown }).role;
  } catch {
    return undefined;
  }
}

/** A PostgREST or gateway refusal. The message names the endpoint, never a query value or key. */
class SupabaseRequestError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly detail: string;

  constructor(status: number, code: string | undefined, detail: string, endpoint: string) {
    super(
      `Supabase ${endpoint} failed (${status}${code === undefined ? "" : ` ${code}`}): ${detail}`,
    );
    this.name = "SupabaseRequestError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

async function supabaseError(
  response: Response,
  method: string,
  path: string,
): Promise<SupabaseRequestError> {
  let code: string | undefined;
  let detail = response.statusText;
  try {
    const body = (await response.json()) as { code?: unknown; message?: unknown };
    if (typeof body.code === "string") code = body.code;
    if (typeof body.message === "string") detail = body.message;
  } catch {
    // HEAD and gateway errors carry no JSON body.
  }
  return new SupabaseRequestError(response.status, code, detail, `${method} /${path}`);
}

/**
 * The storage check failed. The message is for the operator's log (the
 * opportunistic reconcile prints it); payers get the generic 503 body.
 */
class SupabaseStorageNotReady extends Error {
  readonly status = 503;
  readonly body = {
    code: "INTERNAL" as const,
    message: "Payment storage is not ready; payer instructions were withheld. Please retry.",
    retryable: true,
  };

  constructor(detail: string) {
    super(`OpenReceive Supabase storage is not ready: ${detail}`);
    this.name = "SupabaseStorageNotReady";
  }
}

function notReady(detail: string): SupabaseStorageNotReady {
  return new SupabaseStorageNotReady(
    `${detail} https://openreceive.org/guides/supabase.md#supabase-over-https`,
  );
}

const MIGRATE =
  "Run `npx openreceive scaffold payments --supabase` and apply the migration it writes " +
  "(supabase db push, or paste it into the SQL Editor).";

/** Name the fix for a failed status call. */
function diagnose(error: unknown): string {
  if (!(error instanceof SupabaseRequestError))
    return `Supabase could not be reached: ${error instanceof Error ? error.message : String(error)}`;
  if (error.code === "PGRST202" || error.code === "PGRST205" || error.code === "42P01")
    return `OpenReceive's tables or functions are not in this database. ${MIGRATE}`;
  if (error.code === "42501")
    return (
      "The key reached Supabase but may not call OpenReceive's functions: use the secret key " +
      "(sb_secret_…) or the service_role key, not the anon or publishable key."
    );
  if (error.status === 401 || error.status === 403 || error.code?.startsWith("PGRST3"))
    return (
      "Supabase refused the key. Use the project's secret key (sb_secret_…) or service_role key " +
      "from Project Settings > API Keys."
    );
  return error.message;
}

/** What is wrong with a storage status, or undefined when it may serve. */
function storageProblem(status: unknown): string | undefined {
  if (typeof status !== "object" || status === null)
    return "openreceive_supabase_status returned no status.";
  const report = status as {
    functions_version?: unknown;
    schema_version?: unknown;
    on_paid?: unknown;
    exposed?: unknown;
    unprotected_tables?: unknown;
    missing_functions?: unknown;
  };
  const functions = Number(report.functions_version);
  if (functions > OPENRECEIVE_SUPABASE_FUNCTIONS_VERSION)
    return `The database has OpenReceive's Supabase functions version ${functions}, newer than this library's ${OPENRECEIVE_SUPABASE_FUNCTIONS_VERSION}. Upgrade @openreceive/http.`;
  if (functions !== OPENRECEIVE_SUPABASE_FUNCTIONS_VERSION)
    return `The database has OpenReceive's Supabase functions version ${String(report.functions_version)}; this library needs ${OPENRECEIVE_SUPABASE_FUNCTIONS_VERSION}. ${MIGRATE}`;
  const schema = Number(report.schema_version);
  if (schema > OPENRECEIVE_PAYMENTS_SCHEMA_VERSION)
    return `openreceive_meta reports schema version ${schema}, newer than this library's ${OPENRECEIVE_PAYMENTS_SCHEMA_VERSION}. Upgrade @openreceive/http.`;
  const missing = Array.isArray(report.missing_functions) ? report.missing_functions : [];
  if (missing.length > 0) return `Missing functions: ${missing.join(", ")}. ${MIGRATE}`;
  const exposed = Array.isArray(report.exposed) ? report.exposed : [];
  if (exposed.length > 0)
    return (
      `Supabase's public roles can reach OpenReceive's storage (${exposed.join("; ")}). Anyone with ` +
      "the anon key could read server-only data or mark orders paid. Apply the revoke lines from the " +
      "scaffold migration again, and revoke anything granted since."
    );
  const unprotected = Array.isArray(report.unprotected_tables) ? report.unprotected_tables : [];
  if (unprotected.length > 0)
    return `Row level security is off on ${unprotected.join(", ")}. Turn it back on (alter table … enable row level security).`;
  if (report.on_paid === "missing")
    return "public.openreceive_on_paid(text, text, bigint) does not exist. Define it to mark the order paid; the scaffold's migration shows how.";
  if (report.on_paid === "stub")
    return "public.openreceive_on_paid is still the scaffold's placeholder. Replace it, in a migration of your own, with the SQL that marks the order paid.";
  return undefined;
}

/** A settlement the database refused: usually the host's openreceive_on_paid raised. */
function onPaidFailure(error: SupabaseRequestError): Error {
  if (error.detail.includes(OPENRECEIVE_ON_PAID_STUB_MARKER))
    return new Error(
      "Settlement was not recorded: public.openreceive_on_paid is still the scaffold's placeholder. " +
        "The attempt stays pending and settles once it is replaced.",
    );
  return new Error(
    `Settlement was not recorded, and the attempt stays pending for the next pass: ${error.message}`,
  );
}
