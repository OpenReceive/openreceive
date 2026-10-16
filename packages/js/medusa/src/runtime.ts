// The plugin's one runtime, shared by its routes, its job, its migration
// script and its payment provider: the OpenReceive host on Medusa's own
// database connection, the wallet service and the routes' handler.
//
// The reference of a payment attempt is the id of a Medusa payment session.
// Medusa makes a new session whenever the cart's total changes, so a
// session's amount never moves under an attempt. Holding the session id
// authorizes the routes, as holding the cart id does in Medusa's own store
// API. A settled payment is recorded by OpenReceive alone; once that has
// committed, the plugin hands the session to Medusa's process-payment
// workflow, which authorizes it (the provider answers "captured") and
// completes the cart, unless the storefront already placed the order.

import {
  type AuthorizeContext,
  createHost,
  createHttpHandler,
  createRequestId,
  errorResponse,
  type Host,
  type HostCheckoutPrice,
  HttpError,
  type HttpHandler,
  type KnexLike,
  knexDb,
  maybeReconcilePayments,
  type PaymentRecord,
  paymentsSchemaSql,
  webRequest,
} from "@openreceive/http";
import { createOpenReceive, type OpenReceive } from "@openreceive/node";
import { isOpenReceiveProvider, OPENRECEIVE_MEDUSA_ROUTE_PREFIX } from "./index.ts";
import { decimalAmount, exactOrigins, isPayableStatus, settledAttempt } from "./logic.ts";

/** What the plugin resolves from a Medusa container: Query, the logger, the config and the database. */
export interface MedusaContainer {
  resolve<T = unknown>(key: string): T;
}

/** Medusa's own database connection: a Knex instance, with Medusa's SSL, schema and pool settings. */
export type MedusaConnection = KnexLike & {
  raw(sql: string, bindings?: readonly unknown[]): Promise<{ rows?: Record<string, unknown>[] }>;
};

/** Medusa's container key for that connection (ContainerRegistrationKeys.PG_CONNECTION). */
export const PG_CONNECTION = "__pg_connection__";

interface Query {
  graph(input: {
    readonly entity: string;
    readonly fields: readonly string[];
    readonly filters: Readonly<Record<string, unknown>>;
  }): Promise<{ readonly data: readonly Record<string, unknown>[] }>;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** A Medusa route's request: Express's, plus its request-scoped container. */
export interface MedusaRequest {
  readonly method: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly url: string;
  readonly originalUrl?: string;
  readonly protocol?: string;
  readonly body?: unknown;
  readonly scope: MedusaContainer;
}

export interface MedusaResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body?: Uint8Array): unknown;
}

interface Session {
  readonly id: string;
  readonly amount?: unknown;
  readonly raw_amount?: unknown;
  readonly currency_code?: unknown;
  readonly status?: unknown;
  readonly provider_id?: unknown;
}

interface Runtime {
  connection?: MedusaConnection;
  host?: Host;
  service?: Promise<OpenReceive>;
  handler?: Promise<HttpHandler>;
  container?: MedusaContainer;
  /** Sessions whose payment settled in this process, not yet handed to Medusa. */
  readonly settled: Set<string>;
  /** Sessions Medusa would not complete, with the number of tries. */
  readonly failures: Map<string, number>;
}

// One runtime per process, even if Medusa loads the provider and the routes
// through different paths to this file.
const RUNTIME = Symbol.for("openreceive.medusa.runtime");
const SESSION_FIELDS = ["id", "amount", "raw_amount", "currency_code", "status", "provider_id"];
/** A paid session whose cart Medusa would not complete is tried this many times per process. */
const MAX_PLACE_ATTEMPTS = 3;
/** How far back the job looks for paid sessions Medusa has not completed. */
const SWEEP_SECONDS = 7 * 24 * 60 * 60;

function runtime(): Runtime {
  const scope = globalThis as { [RUNTIME]?: Runtime };
  scope[RUNTIME] ??= { settled: new Set(), failures: new Map() };
  return scope[RUNTIME];
}

/** Keeps Medusa's database connection, the first one this process sees. */
export function useConnection(connection: unknown): void {
  const state = runtime();
  if (state.connection === undefined && isConnection(connection)) state.connection = connection;
}

/** A Knex instance is a function with `raw` and `transaction`. */
function isConnection(value: unknown): value is MedusaConnection {
  return (
    (typeof value === "function" || (typeof value === "object" && value !== null)) &&
    typeof (value as { raw?: unknown }).raw === "function" &&
    typeof (value as { transaction?: unknown }).transaction === "function"
  );
}

/** The latest container seen, for Query, the logger and the config, and its database connection. */
function bind(container: MedusaContainer): MedusaContainer {
  runtime().container = container;
  try {
    useConnection(container.resolve(PG_CONNECTION));
  } catch {
    // A container without the connection: one seen earlier stays in use.
  }
  return container;
}

function logger(container = runtime().container): Logger {
  try {
    if (container !== undefined) return container.resolve<Logger>("logger");
  } catch {
    // A container without a logger: the console below.
  }
  return {
    info: (message) => console.info(message),
    warn: (message) => console.warn(message),
    error: (message) => console.error(message),
  };
}

function connection(): MedusaConnection {
  const found = runtime().connection;
  if (found === undefined) {
    throw new Error(
      "OpenReceive keeps its payments in Medusa's database and has not been handed Medusa's connection yet.",
    );
  }
  return found;
}

/** The OpenReceive host: payment attempts in Medusa's database, priced by Medusa's sessions. */
export function host(): Host {
  const state = runtime();
  state.host ??= createHost({
    db: knexDb(connection(), "postgres"),
    amountFor,
    // Inside the settlement transaction: note the session only. Medusa's
    // workflow runs once that transaction has committed.
    onPaid: (settlement) => {
      state.settled.add(settlement.reference);
    },
  });
  return state.host;
}

/**
 * The wallet: NWC_URI and the optional LSC_URI_PRIMARY from Medusa's
 * environment, pricing in the store's own currencies.
 */
export function service(container: MedusaContainer): Promise<OpenReceive> {
  const state = runtime();
  if (state.service === undefined) {
    const starting = storeCurrencies(container).then((priceCurrencies) =>
      createOpenReceive({ priceCurrencies }),
    );
    state.service = starting;
    // A wallet that was down at boot is tried again on the next call.
    starting.catch(() => {
      if (state.service === starting) state.service = undefined;
    });
  }
  return state.service;
}

/** The currencies the store sells in (Settings → Store), which the price feed must quote. */
async function storeCurrencies(container: MedusaContainer): Promise<string[]> {
  const { data } = await container.resolve<Query>("query").graph({
    entity: "store",
    fields: ["supported_currencies.currency_code"],
    filters: {},
  });
  const codes = new Set<string>();
  for (const store of data) {
    for (const currency of (store.supported_currencies ?? []) as { currency_code?: unknown }[]) {
      if (typeof currency.currency_code === "string")
        codes.add(currency.currency_code.toUpperCase());
    }
  }
  return codes.size === 0 ? ["USD"] : [...codes];
}

async function findSessions(
  ids: readonly string[],
  container = runtime().container,
): Promise<Session[]> {
  if (ids.length === 0) return [];
  if (container === undefined) throw new Error("OpenReceive has no Medusa container yet.");
  const { data } = await container.resolve<Query>("query").graph({
    entity: "payment_session",
    fields: SESSION_FIELDS,
    filters: { id: ids.length === 1 ? ids[0] : [...ids] },
  });
  return data as unknown as Session[];
}

async function findSession(id: string): Promise<Session | undefined> {
  return (await findSessions([id]))[0];
}

/** What a payable OpenReceive session comes to, in its own currency. */
async function amountFor(reference: string): Promise<HostCheckoutPrice | null> {
  const session = await findSession(reference);
  if (
    session === undefined ||
    !isOpenReceiveProvider(String(session.provider_id ?? "")) ||
    !isPayableStatus(session.status)
  ) {
    return null;
  }
  const currency = String(session.currency_code ?? "").toUpperCase();
  const value = decimalAmount(session, currency);
  return value === null ? null : { currency, value };
}

/** Whoever holds an OpenReceive session's id may pay it and follow it. */
async function authorize(context: AuthorizeContext): Promise<boolean> {
  const reference = context.resource.reference;
  if (reference === undefined) return false;
  const session = await findSession(reference);
  return session !== undefined && isOpenReceiveProvider(String(session.provider_id ?? ""));
}

function handler(container: MedusaContainer): Promise<HttpHandler> {
  const state = runtime();
  if (state.handler !== undefined) return state.handler;
  const starting = (async () => {
    let storeCors: unknown;
    try {
      storeCors = container.resolve<{ projectConfig?: { http?: { storeCors?: unknown } } }>(
        "configModule",
      ).projectConfig?.http?.storeCors;
    } catch {
      storeCors = undefined;
    }
    const origins = exactOrigins(storeCors);
    return createHttpHandler({
      service: await service(container),
      host: host(),
      authorize,
      prefix: OPENRECEIVE_MEDUSA_ROUTE_PREFIX,
      // A storefront on another site than Medusa (a Vercel domain, say) is
      // let through only from an exact origin in Medusa's storeCors.
      ...(origins.length > 0 ? { cors: { origins } } : {}),
    });
  })();
  state.handler = starting;
  starting.catch(() => {
    if (state.handler === starting) state.handler = undefined;
  });
  return starting;
}

/**
 * One checkout route. Medusa's own store middleware has already checked the
 * publishable key and answered the CORS preflight; OpenReceive's handler
 * does the rest. Then any payment that settled during the request goes to
 * Medusa.
 */
export async function serveCheckoutRoute(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const container = bind(req.scope);
  let response: Response;
  try {
    const handle = await handler(container);
    response = await handle(
      webRequest({
        method: req.method,
        headers: req.headers,
        url: req.originalUrl ?? req.url,
        ...(req.protocol === undefined ? {} : { protocol: req.protocol }),
        parsedBody: req.body,
      }),
      { native: req },
    );
  } catch (error) {
    if (!(error instanceof HttpError)) {
      logger(container).error(
        `OpenReceive could not start: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    response = errorResponse(
      error instanceof HttpError
        ? error
        : new HttpError(
            503,
            "WALLET_UNAVAILABLE",
            "The payment service is not available. Please try again shortly.",
            { retryable: true },
          ),
      createRequestId(),
    );
  }
  res.statusCode = response.status;
  response.headers.forEach((value, name) => {
    if (name !== "content-length") res.setHeader(name, value);
  });
  res.end(new Uint8Array(await response.arrayBuffer()));
  await placePaidOrders(container);
}

/**
 * Whether a session's payment settled in the wallet. When it has not yet,
 * one reconcile pass runs on the wallet connection the routes or the job
 * already opened (the provider has no container to open one with).
 */
export async function settledPayment(sessionId: string): Promise<PaymentRecord | undefined> {
  const records = await host().payments.listForReference(sessionId);
  const settled = settledAttempt(records);
  const running = runtime().service;
  if (settled !== undefined || records.length === 0 || running === undefined) return settled;
  try {
    await maybeReconcilePayments({ service: await running, host: host() });
  } catch {
    return undefined;
  }
  return settledAttempt(await host().payments.listForReference(sessionId));
}

function walletConfigured(): boolean {
  return (process.env.NWC_URI ?? "").trim() !== "";
}

/** Hands the sessions that settled in this process to Medusa. */
export async function placePaidOrders(container: MedusaContainer): Promise<void> {
  const state = runtime();
  const queued = [...state.settled];
  state.settled.clear();
  if (queued.length === 0) return;
  for (const session of await findSessions(queued, container)) {
    await placeOrder(container, session);
  }
}

type ProcessPayment = typeof import("@medusajs/medusa/core-flows").processPaymentWorkflow;

/**
 * Medusa's process-payment workflow with the `authorized` action: it
 * authorizes the session, which this plugin's provider answers as captured,
 * and completes the cart into an order. If the storefront already completed
 * it, the workflow finds the order and does nothing.
 */
async function placeOrder(container: MedusaContainer, session: Session): Promise<void> {
  if (
    !isOpenReceiveProvider(String(session.provider_id ?? "")) ||
    !isPayableStatus(session.status)
  ) {
    return;
  }
  const state = runtime();
  const tries = state.failures.get(session.id) ?? 0;
  if (tries >= MAX_PLACE_ATTEMPTS) return;
  try {
    const flows = (await import("@medusajs/medusa/core-flows")) as {
      processPaymentWorkflow?: ProcessPayment;
      default?: { processPaymentWorkflow?: ProcessPayment };
    };
    const processPayment = flows.processPaymentWorkflow ?? flows.default?.processPaymentWorkflow;
    if (processPayment === undefined) throw new Error("Medusa has no processPaymentWorkflow.");
    await processPayment(container).run({
      input: { action: "authorized", data: { session_id: session.id, amount: session.amount } },
    });
    state.failures.delete(session.id);
  } catch (error) {
    state.failures.set(session.id, tries + 1);
    const reason = error instanceof Error ? error.message : String(error);
    logger(container).error(
      tries + 1 >= MAX_PLACE_ATTEMPTS
        ? `OpenReceive: payment session ${session.id} is paid in the wallet, but Medusa would not complete its cart (${reason}). It needs attention: the buyer paid.`
        : `OpenReceive: Medusa did not complete the cart of paid payment session ${session.id} yet (${reason}); trying again.`,
    );
  }
}

/**
 * The scheduled pass: one reconcile pass, which finds a payment whose buyer
 * left the page, then every session paid in the last week that Medusa has
 * not completed, in case a process stopped between the two steps.
 */
export async function reconcileAndPlaceOrders(container: MedusaContainer): Promise<void> {
  bind(container);
  if (!walletConfigured()) return;
  await maybeReconcilePayments({
    service: await service(container),
    host: host(),
    onError: (error) =>
      logger(container).warn(
        `OpenReceive reconcile pass failed (will retry): ${error instanceof Error ? error.message : String(error)}`,
      ),
  });
  await placePaidOrders(container);
  // paid_at is unix seconds (BIGINT), as everywhere in the Node engine's tables.
  const since = Math.floor(Date.now() / 1000) - SWEEP_SECONDS;
  const result = (await connection().raw(
    "SELECT DISTINCT reference FROM openreceive_payments WHERE status = 'settled' AND paid_at > ? LIMIT 50",
    [since],
  )) as { rows?: Record<string, unknown>[] };
  const references = (result.rows ?? []).map((row) => String(row.reference));
  for (const session of await findSessions(references, container)) {
    await placeOrder(container, session);
  }
}

/** The two OpenReceive tables in Medusa's database. Every statement is safe to repeat. */
export async function createPaymentTables(container: MedusaContainer): Promise<void> {
  bind(container);
  await connection().raw(paymentsSchemaSql("postgres"));
  logger(container).info("OpenReceive: payment tables are ready.");
}
