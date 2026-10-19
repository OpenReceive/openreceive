// The plugin's one runtime, shared by its routes, its payment method handler
// and its scheduled task: the OpenReceive host on Vendure's own database
// connection, the wallet service and the routes' handler.
//
// The reference of a payment is an order's code, currency and amount due
// (`<code>:<currency>:<due>`), which the storefront gets from POST
// /openreceive/order with the buyer's session. Only that session, or the
// signed-in customer the order belongs to, may pay it. A settled payment is
// recorded by OpenReceive alone; once that has committed, the plugin adds a
// settled Vendure payment to the order, and Vendure places it.

import { Readable } from "node:stream";
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
  maybeReconcilePayments,
  type PaymentRecord,
  paymentsSchemaStatements,
  typeOrmDb,
  webRequest,
} from "@openreceive/http";
import { createOpenReceive, type OpenReceive } from "@openreceive/node";
import {
  Channel,
  ConfigService,
  type ErrorResult,
  type Injector,
  Logger,
  Order,
  OrderService,
  Payment,
  type PaymentMetadata,
  PaymentMethod,
  PaymentMethodService,
  type RequestContext,
  RequestContextService,
  TransactionalConnection,
} from "@vendure/core";
import {
  OPENRECEIVE_VENDURE_HANDLER_CODE,
  OPENRECEIVE_VENDURE_ROUTE_PREFIX,
  orderReference,
  parseOrderReference,
} from "./index.ts";
import {
  amountDue,
  decimalAmount,
  exactOrigins,
  isOpenOrderState,
  settledAttempt,
  sqlDialect,
} from "./logic.ts";

const LOG = "OpenReceive";

/** An Express request, as a Vendure REST route sees it. */
export interface RouteRequest {
  readonly method: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly url: string;
  readonly originalUrl?: string;
  readonly protocol?: string;
  readonly body?: unknown;
}

export interface RouteResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body?: Uint8Array): unknown;
}

interface Runtime {
  injector?: Injector;
  host?: Host;
  service?: Promise<OpenReceive>;
  handler?: Promise<HttpHandler>;
  /** References whose payment settled in this process, not yet added to their orders. */
  readonly settled: Set<string>;
  /** References whose orders Vendure would not take the payment for, with the number of tries. */
  readonly failures: Map<string, number>;
}

// One runtime per process, even if Vendure loads the plugin twice.
const RUNTIME = Symbol.for("openreceive.vendure.runtime");
/** A paid reference whose order would not take the payment is tried this many times per process. */
const MAX_PLACE_ATTEMPTS = 3;
/** How far back the scheduled task looks for paid references that have no Vendure payment. */
const SWEEP_SECONDS = 7 * 24 * 60 * 60;
const ORDER_RELATIONS = {
  payments: { refunds: true },
  customer: { user: true },
  channels: true,
} as const;

function runtime(): Runtime {
  const scope = globalThis as { [RUNTIME]?: Runtime };
  scope[RUNTIME] ??= { settled: new Set(), failures: new Map() };
  return scope[RUNTIME];
}

/** Keeps Vendure's injector, the first one this process sees. */
export function useInjector(injector: Injector): void {
  runtime().injector ??= injector;
}

function get<T>(type: abstract new (...args: never[]) => T): T {
  const injector = runtime().injector;
  if (injector === undefined) {
    throw new Error("OpenReceive has not been handed Vendure's injector yet.");
  }
  return injector.get<T>(type);
}

function connection(): TransactionalConnection {
  return get(TransactionalConnection);
}

/** The database's SQL dialect; refuses SQLite and sql.js. */
function dialect(): "postgres" | "mysql" {
  const type = connection().rawConnection.options.type;
  const found = sqlDialect(type);
  if (found === undefined) {
    throw new Error(
      `OpenReceive keeps its payments in Vendure's database, which must be PostgreSQL, MySQL or MariaDB; this Vendure runs on ${type}.`,
    );
  }
  return found;
}

/** The OpenReceive host: payment attempts in Vendure's database, priced by Vendure's orders. */
export function host(): Host {
  const state = runtime();
  state.host ??= createHost({
    db: typeOrmDb(connection().rawConnection, dialect()),
    amountFor,
    // Inside the settlement transaction: note the reference only. The order
    // takes its Vendure payment once that transaction has committed.
    onPaid: (settlement) => {
      state.settled.add(settlement.reference);
    },
  });
  return state.host;
}

/**
 * The wallet: NWC_URI and the optional LSC_URI_PRIMARY from the Vendure
 * server's environment, pricing in every currency its channels sell in.
 */
export function service(): Promise<OpenReceive> {
  const state = runtime();
  if (state.service === undefined) {
    const starting = channelCurrencies().then((priceCurrencies) =>
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

async function channelCurrencies(): Promise<string[]> {
  const channels = await connection().rawConnection.getRepository(Channel).find();
  const codes = new Set<string>();
  for (const channel of channels) {
    for (const code of [channel.defaultCurrencyCode, ...(channel.availableCurrencyCodes ?? [])]) {
      if (typeof code === "string" && code.length > 0) codes.add(code.toUpperCase());
    }
  }
  return codes.size === 0 ? ["USD"] : [...codes];
}

/** An order by its code, in any channel, with its payments, customer and channels. */
function findOrder(code: string): Promise<Order | null> {
  return connection()
    .rawConnection.getRepository(Order)
    .findOne({ where: { code }, relations: ORDER_RELATIONS });
}

function precision(): number {
  return get(ConfigService).entityOptions.moneyStrategy?.precision ?? 2;
}

/**
 * What a reference comes to: the amount it names, if that is still what is
 * due on its open order, in the order's currency. A reference whose order
 * changed, closed or was paid prices as nothing, so no invoice is made for it.
 */
async function amountFor(reference: string): Promise<HostCheckoutPrice | null> {
  const named = parseOrderReference(reference);
  if (named === undefined) return null;
  const order = await findOrder(named.code);
  if (
    order === null ||
    !order.active ||
    !isOpenOrderState(order.state) ||
    order.currencyCode.toUpperCase() !== named.currency ||
    amountDue(order) !== named.due
  ) {
    return null;
  }
  const value = decimalAmount(named.due, precision(), named.currency);
  return value === null ? null : { currency: named.currency, value };
}

function sameId(left: unknown, right: unknown): boolean {
  return left !== undefined && left !== null && String(left) === String(right);
}

/** The buyer's own order: this session's active order, or one the signed-in customer owns. */
function ownsOrder(ctx: RequestContext, order: Order): boolean {
  if (sameId(ctx.session?.activeOrderId, order.id)) return true;
  return ctx.activeUserId !== undefined && sameId(order.customer?.user?.id, ctx.activeUserId);
}

/**
 * The order's buyer may pay it and follow it. Following a payment, which
 * reveals nothing new, is also open to whoever Vendure lets see the order by
 * its code, so a guest's page still sees the payment settle after Vendure
 * has closed the session's active order.
 */
async function authorize(context: AuthorizeContext): Promise<boolean> {
  const ctx = (context.native as { ctx?: RequestContext } | undefined)?.ctx;
  const named = parseOrderReference(context.resource.reference ?? "");
  if (ctx === undefined || named === undefined) return false;
  const order = await findOrder(named.code);
  if (
    order === null ||
    !(order.channels ?? []).some((channel) => sameId(channel.id, ctx.channelId))
  ) {
    return false;
  }
  if (ownsOrder(ctx, order)) return true;
  if (context.action !== "payment.check" && context.action !== "swap.read") return false;
  const strategy = get(ConfigService).orderOptions.orderByCodeAccessStrategy;
  return strategy !== undefined && (await strategy.canAccessOrder(ctx, order));
}

function handler(): Promise<HttpHandler> {
  const state = runtime();
  if (state.handler !== undefined) return state.handler;
  const starting = (async () => {
    const origins = exactOrigins(get(ConfigService).apiOptions.cors);
    return createHttpHandler({
      service: await service(),
      host: host(),
      authorize,
      prefix: OPENRECEIVE_VENDURE_ROUTE_PREFIX,
      // A storefront calling the routes from the browser on another site is
      // let through only from an exact origin in Vendure's own cors setting.
      ...(origins.length > 0 ? { cors: { origins } } : {}),
    });
  })();
  state.handler = starting;
  starting.catch(() => {
    if (state.handler === starting) state.handler = undefined;
  });
  return starting;
}

/** The enabled payment method in the order's channel whose handler is OpenReceive's, if any. */
async function openReceiveMethod(ctx: RequestContext): Promise<PaymentMethod | undefined> {
  const methods = await connection()
    .getRepository(ctx, PaymentMethod)
    .createQueryBuilder("method")
    .leftJoin("method.channels", "channel")
    .where("channel.id = :channelId", { channelId: ctx.channelId })
    .andWhere("method.enabled = :enabled", { enabled: true })
    .getMany();
  return methods.find((method) => method.handler?.code === OPENRECEIVE_VENDURE_HANDLER_CODE);
}

function isErrorResult(value: unknown): value is ErrorResult {
  return value !== null && typeof value === "object" && "errorCode" in value;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * POST /openreceive/order: the session's active order, ready to pay. An order
 * still adding items moves to ArrangingPayment, as Vendure's own checkout
 * does before a payment, which checks its customer, address and shipping.
 * Answers the reference the checkout pays.
 */
async function startOrder(ctx: RequestContext, req: RouteRequest): Promise<Response> {
  if (req.method.toUpperCase() !== "POST") {
    throw new HttpError(
      405,
      "INVALID_REQUEST",
      "This OpenReceive route does not support that HTTP method.",
    );
  }
  // A JSON body is what makes a browser on another site ask first (CORS).
  const type = String(req.headers["content-type"] ?? "");
  if (!type.includes("application/json")) {
    throw new HttpError(415, "INVALID_REQUEST", "Send this request as application/json.");
  }
  const orderId = ctx.session?.activeOrderId;
  if (orderId === undefined || orderId === null) {
    throw new HttpError(404, "NOT_FOUND", "This session has no active order.");
  }
  const orders = get(OrderService);
  let order = await orders.findOne(ctx, orderId);
  if (order === undefined || !order.active) {
    throw new HttpError(404, "NOT_FOUND", "This session has no active order.");
  }
  if (order.state === "AddingItems") {
    const moved = await orders.transitionToState(ctx, order.id, "ArrangingPayment");
    if (isErrorResult(moved)) {
      throw new HttpError(409, "CONFLICT", moved.transitionError ?? moved.message);
    }
    order = moved;
  } else if (order.state !== "ArrangingPayment") {
    throw new HttpError(409, "CONFLICT", "This order is not open for payment.");
  }
  const method = await openReceiveMethod(ctx);
  const eligible =
    method !== undefined &&
    (await get(PaymentMethodService).getEligiblePaymentMethods(ctx, order)).some(
      (quote) => quote.code === method.code && quote.isEligible,
    );
  if (!eligible) {
    throw new HttpError(409, "CONFLICT", "OpenReceive is not a payment method for this order.");
  }
  const priced = await findOrder(order.code);
  const due = priced === null ? 0 : amountDue(priced);
  const amount = decimalAmount(due, precision(), order.currencyCode);
  if (amount === null) throw new HttpError(409, "CONFLICT", "Nothing is due on this order.");
  return json(200, {
    reference: orderReference({ code: order.code, currency: order.currencyCode, due }),
    order_code: order.code,
    amount,
    currency: order.currencyCode.toUpperCase(),
  });
}

/**
 * One checkout route. Vendure's guard has already read the session into
 * `ctx`; OpenReceive's handler does the rest. A payment that settled during
 * the request is added to its order before the answer goes out, so a
 * checkout that saw it settle finds its order placed.
 */
export async function serveRoute(
  ctx: RequestContext,
  req: RouteRequest & Readable,
  res: RouteResponse,
): Promise<void> {
  let response: Response;
  try {
    const path = (req.originalUrl ?? req.url).split("?")[0] ?? "";
    if (path.replace(/\/$/, "") === `${OPENRECEIVE_VENDURE_ROUTE_PREFIX}/order`) {
      response = await startOrder(ctx, req);
    } else {
      const handle = await handler();
      response = await handle(
        webRequest({
          method: req.method,
          headers: req.headers,
          url: req.originalUrl ?? req.url,
          ...(req.protocol === undefined ? {} : { protocol: req.protocol }),
          parsedBody: req.body,
          unparsedBody: () => Readable.toWeb(req) as ReadableStream<Uint8Array>,
        }),
        { native: { ctx, req } },
      );
      await placePaidOrders();
    }
  } catch (error) {
    if (!(error instanceof HttpError)) {
      Logger.error(
        `OpenReceive could not answer: ${error instanceof Error ? error.message : String(error)}`,
        LOG,
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
}

function walletConfigured(): boolean {
  return (process.env.NWC_URI ?? "").trim() !== "";
}

/** The first settled attempt of a reference: the one its order is paid with. */
async function paidAttempt(reference: string): Promise<PaymentRecord | undefined> {
  const records = await host().payments.listForReference(reference);
  return settledAttempt(records.filter((record) => (record.statusReason ?? null) === null));
}

/** Adds the payments that settled in this process to their orders. */
export async function placePaidOrders(): Promise<void> {
  const state = runtime();
  const queued = [...state.settled];
  state.settled.clear();
  for (const reference of queued) await placeOrder(reference);
}

/**
 * A request context for the order's own channel, as Vendure's payment plugins
 * build one for a webhook. By the channel's token, so Vendure loads the
 * channel with its tax zones, which pricing the order needs.
 */
async function adminContext(order: Order): Promise<RequestContext> {
  const channels = order.channels ?? [];
  const channel =
    channels.find((candidate) => candidate.code !== "__default_channel__") ?? channels[0];
  return get(RequestContextService).create({
    apiType: "admin",
    ...(channel === undefined ? {} : { channelOrToken: channel.token }),
  });
}

/**
 * The settled payment, added to its order as a settled Vendure payment with
 * the Lightning payment hash as its transaction id. Vendure then places an
 * order its payments cover. The order row is locked for the check and the
 * write, so the routes and the scheduled task never add one payment twice.
 */
async function placeOrder(reference: string): Promise<void> {
  const state = runtime();
  const tries = state.failures.get(reference) ?? 0;
  if (tries >= MAX_PLACE_ATTEMPTS) return;
  const named = parseOrderReference(reference);
  const paid = await paidAttempt(reference);
  if (named === undefined || paid === undefined) return;
  try {
    const found = await findOrder(named.code);
    if (found === null) throw new Error(`Vendure has no order ${named.code}`);
    const ctx = await adminContext(found);
    const outcome = await connection().withTransaction(ctx, async (txCtx) => {
      await connection()
        .getRepository(txCtx, Order)
        .createQueryBuilder("order")
        .setLock("pessimistic_write")
        .where("order.id = :id", { id: found.id })
        .getOne();
      const payments = await connection()
        .getRepository(txCtx, Payment)
        .find({ where: { order: { id: found.id } } });
      if (payments.some((payment) => payment.transactionId === paid.paymentHash)) return "recorded";
      const orders = get(OrderService);
      const order = await orders.findOne(txCtx, found.id);
      if (order === undefined || !order.active) {
        throw new Error(
          `order ${named.code} is no longer open (it reads ${order?.state ?? "missing"})`,
        );
      }
      if (order.state !== "ArrangingPayment") {
        const moved = await orders.transitionToState(txCtx, order.id, "ArrangingPayment");
        if (isErrorResult(moved)) throw new Error(moved.transitionError ?? moved.message);
      }
      const method = await openReceiveMethod(txCtx);
      if (method === undefined) {
        throw new Error("no enabled payment method in its channel uses the OpenReceive handler");
      }
      const result = await orders.addPaymentToOrder(txCtx, order.id, {
        method: method.code,
        metadata: { reference, paymentHash: paid.paymentHash, paidAt: paid.paidAt },
      });
      if (isErrorResult(result)) throw new Error(result.message);
      return result.state;
    });
    state.failures.delete(reference);
    if (outcome !== "recorded" && outcome !== "PaymentSettled") {
      Logger.warn(
        `OpenReceive: order ${named.code} took the payment ${paid.paymentHash} but reads ${outcome}: its total changed after the invoice was made. The buyer owes the rest, or you refund the payment.`,
        LOG,
      );
    }
  } catch (error) {
    state.failures.set(reference, tries + 1);
    const reason = error instanceof Error ? error.message : String(error);
    Logger.error(
      tries + 1 >= MAX_PLACE_ATTEMPTS
        ? `OpenReceive: payment ${paid.paymentHash} for order ${named.code} is paid in the wallet, but Vendure would not take it (${reason}). It needs attention: the buyer paid.`
        : `OpenReceive: Vendure did not take payment ${paid.paymentHash} for order ${named.code} yet (${reason}); trying again.`,
      LOG,
    );
  }
}

/**
 * The scheduled pass: one reconcile pass, which finds a payment whose buyer
 * left the page, then every reference paid in the last week whose order has
 * no Vendure payment for it, in case a process stopped between the two steps.
 */
export async function reconcileAndPlaceOrders(): Promise<void> {
  if (!walletConfigured()) return;
  await maybeReconcilePayments({
    service: await service(),
    host: host(),
    onError: (error) =>
      Logger.warn(
        `OpenReceive reconcile pass failed (will retry): ${error instanceof Error ? error.message : String(error)}`,
        LOG,
      ),
  });
  await placePaidOrders();
  // paid_at is unix seconds, as everywhere in OpenReceive's tables.
  const since = Math.floor(Date.now() / 1000) - SWEEP_SECONDS;
  const placeholder = dialect() === "postgres" ? "$1" : "?";
  const rows = (await connection().rawConnection.query(
    `SELECT reference, payment_hash FROM openreceive_payments WHERE status = 'settled' AND status_reason IS NULL AND paid_at > ${placeholder} ORDER BY paid_at DESC LIMIT 50`,
    [since],
  )) as { reference: string; payment_hash: string }[];
  const payments = connection().rawConnection.getRepository(Payment);
  for (const row of rows) {
    if ((await payments.findOne({ where: { transactionId: row.payment_hash } })) !== null) continue;
    await placeOrder(String(row.reference));
  }
}

/**
 * The payment method handler's createPayment, for the plugin's own calls
 * only: a settled Vendure payment, for an attempt the wallet settled on this
 * order. The Shop API can never add one, so a buyer cannot mark an order paid.
 */
export async function settledPayment(
  ctx: RequestContext,
  order: Order,
  metadata: PaymentMetadata,
): Promise<{ amount: number; state: "Settled"; transactionId: string; metadata: PaymentMetadata }> {
  if (ctx.apiType !== "admin") {
    throw new Error("OpenReceive adds its payments to orders itself, once the wallet has them.");
  }
  const reference = String(metadata.reference ?? "");
  const paymentHash = String(metadata.paymentHash ?? "");
  const named = parseOrderReference(reference);
  const record = await host().payments.findByPaymentHash(paymentHash);
  if (
    named === undefined ||
    named.code !== order.code ||
    record === undefined ||
    record.reference !== reference ||
    record.status !== "settled"
  ) {
    throw new Error(`OpenReceive has no settled payment ${paymentHash} for order ${order.code}.`);
  }
  return {
    amount: named.due,
    state: "Settled",
    transactionId: paymentHash,
    metadata: {
      reference,
      paymentHash,
      paidAt: record.paidAt,
      public: { paymentHash },
    },
  };
}

/** Warns at boot when Vendure's migrations have not created the tables yet. */
export async function checkTables(): Promise<void> {
  try {
    await connection().rawConnection.query("SELECT 1 FROM openreceive_payments WHERE 1 = 0");
  } catch {
    Logger.error(
      "OpenReceive's tables are missing from Vendure's database. Run Vendure's migrations (runMigrations in src/index.ts, as a new Vendure project does at startup, or npx vendure migrate) and restart.",
      LOG,
    );
  }
}

/** The two OpenReceive tables. Every statement is safe to repeat. */
export function paymentTableStatements(type: string): readonly string[] {
  const found = sqlDialect(type);
  if (found === undefined) {
    throw new Error(
      `OpenReceive keeps its payments in Vendure's database, which must be PostgreSQL, MySQL or MariaDB; this Vendure runs on ${type}.`,
    );
  }
  return paymentsSchemaStatements(found);
}
