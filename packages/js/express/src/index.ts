import {
  InMemoryInvoiceStore,
  InvoiceNotFoundError,
  createIdempotencyRequestHash,
  quoteFiatToMsats,
  type InvoiceStorageRow,
  type OpenReceiveIdempotencyScope,
  type OpenReceiveReceiveNwcClient
} from "@openreceive/core";

export interface ExpressLikeApp {
  get(path: string, ...handlers: ExpressLikeHandler[]): unknown;
  post(path: string, ...handlers: ExpressLikeHandler[]): unknown;
}

export interface ExpressLikeRequest {
  method?: string;
  path?: string;
  params?: Record<string, string | undefined>;
  query?: Record<string, string | string[] | undefined>;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
  get?: (header: string) => string | undefined;
  on?: (event: "close", listener: () => void) => unknown;
  user?: unknown;
}

export interface ExpressLikeResponse {
  status(code: number): ExpressLikeResponse;
  set(field: string, value: string): ExpressLikeResponse;
  json(body: unknown): unknown;
  write?: (chunk: string) => unknown;
  end?: () => unknown;
  flushHeaders?: () => unknown;
}

export type ExpressLikeNext = (error?: unknown) => void;
export type ExpressLikeHandler = (
  req: ExpressLikeRequest,
  res: ExpressLikeResponse,
  next: ExpressLikeNext
) => unknown;

export interface OpenReceiveExpressAuthorization {
  create?: (req: ExpressLikeRequest) => Promise<boolean> | boolean;
  read?: (
    req: ExpressLikeRequest,
    invoice: InvoiceStorageRow
  ) => Promise<boolean> | boolean;
  lookup?: (
    req: ExpressLikeRequest,
    invoice: InvoiceStorageRow
  ) => Promise<boolean> | boolean;
  events?: (
    req: ExpressLikeRequest,
    invoice: InvoiceStorageRow
  ) => Promise<boolean> | boolean;
}

export interface OpenReceiveExpressCsrf {
  verify?: (req: ExpressLikeRequest) => Promise<boolean> | boolean;
}

export interface OpenReceiveExpressCors {
  allowed_origins?: string[];
  credentials?: boolean;
}

export interface OpenReceiveExpressOptions {
  client: OpenReceiveReceiveNwcClient;
  store?: InMemoryInvoiceStore;
  eventBus?: InMemoryInvoiceEventBus;
  basePath?: string;
  merchantScope: (req: ExpressLikeRequest) => string;
  auth?: OpenReceiveExpressAuthorization;
  csrf?: OpenReceiveExpressCsrf;
  cors?: OpenReceiveExpressCors;
  unsafeAllowUnauthenticatedDemoMode?: boolean;
  clock?: () => number;
  heartbeatSeconds?: number;
}

export interface OpenReceiveExpressHandlers {
  createInvoice: ExpressLikeHandler;
  getInvoice: ExpressLikeHandler;
  lookupInvoice: ExpressLikeHandler;
  invoiceEvents: ExpressLikeHandler;
  health: ExpressLikeHandler;
  capabilities: ExpressLikeHandler;
}

const DEFAULT_BASE_PATH = "/openreceive/v1";
const DEFAULT_HEARTBEAT_SECONDS = 20;
const HEX_64 = /^[0-9a-fA-F]{64}$/;

export type OpenReceiveInvoiceEventName =
  | "invoice.created"
  | "invoice.verifying"
  | "invoice.settled"
  | "invoice.expired"
  | "invoice.failed"
  | "invoice.fulfilled"
  | "invoice.cancelled";

export interface OpenReceiveInvoiceEvent {
  id: number;
  invoice_id: string;
  event: OpenReceiveInvoiceEventName;
  data: Record<string, unknown>;
}

export class InMemoryInvoiceEventBus {
  #events = new Map<string, OpenReceiveInvoiceEvent[]>();
  #subscribers = new Map<
    string,
    Set<(event: OpenReceiveInvoiceEvent) => void>
  >();

  publish(
    invoiceId: string,
    event: OpenReceiveInvoiceEventName,
    data: Record<string, unknown>
  ): OpenReceiveInvoiceEvent {
    const invoiceEvents = this.#events.get(invoiceId) ?? [];
    const nextEvent: OpenReceiveInvoiceEvent = {
      id: invoiceEvents.length + 1,
      invoice_id: invoiceId,
      event,
      data
    };

    invoiceEvents.push(nextEvent);
    this.#events.set(invoiceId, invoiceEvents);

    for (const subscriber of this.#subscribers.get(invoiceId) ?? []) {
      subscriber(nextEvent);
    }

    return nextEvent;
  }

  replay(invoiceId: string, afterEventId = 0): OpenReceiveInvoiceEvent[] {
    return (this.#events.get(invoiceId) ?? []).filter(
      (event) => event.id > afterEventId
    );
  }

  subscribe(
    invoiceId: string,
    subscriber: (event: OpenReceiveInvoiceEvent) => void
  ): () => void {
    const subscribers = this.#subscribers.get(invoiceId) ?? new Set();
    subscribers.add(subscriber);
    this.#subscribers.set(invoiceId, subscribers);

    return () => {
      subscribers.delete(subscriber);
      if (subscribers.size === 0) {
        this.#subscribers.delete(invoiceId);
      }
    };
  }
}

export function mountOpenReceiveExpressRoutes(
  app: ExpressLikeApp,
  options: OpenReceiveExpressOptions
): OpenReceiveExpressHandlers {
  const handlers = createOpenReceiveExpressHandlers(options);
  const basePath = normalizeBasePath(options.basePath);

  app.post(`${basePath}/invoices`, handlers.createInvoice);
  app.get(`${basePath}/invoices/:invoice_id`, handlers.getInvoice);
  app.post(`${basePath}/invoices/lookup`, handlers.lookupInvoice);
  app.get(`${basePath}/invoices/:invoice_id/events`, handlers.invoiceEvents);
  app.get(`${basePath}/health`, handlers.health);
  app.get(`${basePath}/capabilities`, handlers.capabilities);

  return handlers;
}

export function createOpenReceiveExpressHandlers(
  options: OpenReceiveExpressOptions
): OpenReceiveExpressHandlers {
  const store = options.store ?? new InMemoryInvoiceStore();
  const eventBus = options.eventBus ?? new InMemoryInvoiceEventBus();
  const clock = options.clock ?? currentUnixSeconds;
  const basePath = normalizeBasePath(options.basePath);
  const heartbeatMs =
    (options.heartbeatSeconds ?? DEFAULT_HEARTBEAT_SECONDS) * 1000;

  return {
    createInvoice: wrapHandler(async (req, res) => {
      applyDefaultHeaders(req, res, options);
      await requireAuthorization(options, "create", req);
      await requireCsrf(options, req);

      const body = asRecord(req.body);
      const idempotencyKey = getHeader(req, "idempotency-key");
      if (idempotencyKey === undefined || idempotencyKey.length === 0) {
        throw httpError(400, "INVALID_REQUEST", "Idempotency-Key header is required.");
      }

      const merchantScope = options.merchantScope(req);
      const operation = "invoice.create" as const;
      const idempotencyScope: OpenReceiveIdempotencyScope = {
        merchant_scope: merchantScope,
        operation,
        idempotency_key: idempotencyKey
      };
      const requestHash = await createIdempotencyRequestHash(body);
      const existing = store.checkIdempotency({
        scope: idempotencyScope,
        idempotency_request_hash: requestHash
      });

      if (existing !== undefined) {
        return res.status(200).json(serializeInvoice(existing.row, basePath));
      }

      const amountMsats = getCreateAmountMsats(body, clock());
      const descriptionFields = getCreateDescriptionFields(body);
      const invoice = await options.client.makeInvoice({
        amount_msats: BigInt(amountMsats),
        ...descriptionFields,
        expiry: optionalSafeInteger(body.expiry),
        metadata: parseOptionalRecord(body.metadata, "metadata")
      });
      const createdAt = invoice.created_at ?? clock();
      const expiresAt =
        invoice.expires_at ??
        createdAt + (optionalSafeInteger(body.expiry) ?? 600);

      const createResult = store.createInvoice({
        invoice_id: createInvoiceId(),
        merchant_scope: merchantScope,
        operation,
        idempotency_key: idempotencyKey,
        idempotency_request_hash: requestHash,
        payment_hash: invoice.payment_hash,
        invoice: invoice.invoice,
        amount_msats: toSafeInteger(invoice.amount_msats, "amount_msats"),
        transaction_state: "pending",
        workflow_state: "invoice_created",
        fulfillment_state: "pending",
        created_at: createdAt,
        expires_at: expiresAt,
        metadata: parseOptionalRecord(body.metadata, "metadata") ?? {},
        fiat_quote: body.fiat === undefined ? null : {
          ...quoteFiatToMsats({
            fiat: parseFiatAmount(body.fiat),
            as_of: createdAt
          })
        }
      });
      eventBus.publish(
        createResult.row.invoice_id,
        "invoice.created",
        serializeEventData(createResult.row)
      );

      return res.status(201).json(serializeInvoice(createResult.row, basePath));
    }),

    getInvoice: wrapHandler(async (req, res) => {
      applyDefaultHeaders(req, res, options);
      const invoice = requireStoredInvoice(store, req.params?.invoice_id);
      await requireAuthorization(options, "read", req, invoice);
      return res.status(200).json(serializeInvoice(invoice, basePath));
    }),

    lookupInvoice: wrapHandler(async (req, res) => {
      applyDefaultHeaders(req, res, options);
      const body = asRecord(req.body);
      const invoice = findLookupInvoice(store, body);
      await requireAuthorization(options, "lookup", req, invoice);
      await requireCsrf(options, req);

      const lookup = await options.client.lookupInvoice({
        payment_hash: optionalString(body.payment_hash),
        invoice: optionalString(body.invoice)
      });

      let current = invoice;
      if (lookup.settled_at !== undefined || lookup.state === "settled" || lookup.transaction_state === "settled") {
        current = store.markSettled({
          invoice_id: invoice.invoice_id,
          settled_at: lookup.settled_at
        });
        if (invoice.transaction_state !== "settled") {
          eventBus.publish(
            current.invoice_id,
            "invoice.settled",
            serializeEventData(current)
          );
        }
      } else if (lookup.state === "expired" || lookup.transaction_state === "expired") {
        current = store.markExpiredClosed(invoice.invoice_id);
        if (invoice.transaction_state !== "expired") {
          eventBus.publish(
            current.invoice_id,
            "invoice.expired",
            serializeEventData(current)
          );
        }
      } else if (lookup.state === "failed" || lookup.transaction_state === "failed") {
        current = store.markFailedClosed(invoice.invoice_id);
        if (invoice.transaction_state !== "failed") {
          eventBus.publish(
            current.invoice_id,
            "invoice.failed",
            serializeEventData(current)
          );
        }
      }

      return res.status(200).json({
        ...serializeInvoice(current, basePath),
        preimage_present: lookup.preimage !== undefined
      });
    }),

    invoiceEvents: wrapHandler(async (req, res) => {
      applyDefaultHeaders(req, res, options);
      const invoice = requireStoredInvoice(store, req.params?.invoice_id);
      await requireAuthorization(options, "events", req, invoice);

      res.status(200);
      res.set("Content-Type", "text/event-stream");
      res.set("Cache-Control", "no-store");
      res.flushHeaders?.();
      for (const event of eventBus.replay(invoice.invoice_id, getLastEventId(req))) {
        res.write?.(formatSseEvent(event.id, event.event, event.data));
      }

      const unsubscribe = eventBus.subscribe(invoice.invoice_id, (event) => {
        res.write?.(formatSseEvent(event.id, event.event, event.data));
      });
      if (req.on !== undefined) {
        const heartbeat = setInterval(() => {
          res.write?.(": heartbeat\n\n");
        }, heartbeatMs);
        req.on("close", () => {
          clearInterval(heartbeat);
          unsubscribe();
        });
      } else {
        res.write?.(": heartbeat\n\n");
        unsubscribe();
      }
    }),

    health: wrapHandler(async (req, res) => {
      applyDefaultHeaders(req, res, options);
      return res.status(200).json({ ok: true });
    }),

    capabilities: wrapHandler(async (req, res) => {
      applyDefaultHeaders(req, res, options);
      return res.status(200).json({
        base_path: basePath,
        transports: ["sse"],
        methods: ["make_invoice", "lookup_invoice"],
        routes: {
          invoices: `${basePath}/invoices`,
          lookup: `${basePath}/invoices/lookup`,
          health: `${basePath}/health`
        }
      });
    })
  };
}

function serializeInvoice(row: InvoiceStorageRow, basePath: string): Record<string, unknown> {
  return {
    invoice_id: row.invoice_id,
    type: "incoming",
    transaction_state: row.transaction_state,
    workflow_state: row.workflow_state,
    invoice: row.invoice,
    payment_hash: row.payment_hash,
    amount_msats: row.amount_msats,
    created_at: row.created_at,
    expires_at: row.expires_at,
    metadata: row.metadata,
    fiat_quote: row.fiat_quote ?? null,
    checkout: {
      events_url: `${basePath}/invoices/${row.invoice_id}/events`,
      routes_url: `${basePath}/routes?invoice_id=${row.invoice_id}`
    },
    fulfillment: {
      state: row.fulfillment_state
    }
  };
}

function serializeEventData(row: InvoiceStorageRow): Record<string, unknown> {
  return {
    invoice_id: row.invoice_id,
    type: "incoming",
    transaction_state: row.transaction_state,
    workflow_state: row.workflow_state,
    payment_hash: row.payment_hash,
    amount_msats: row.amount_msats
  };
}

function getCreateAmountMsats(
  body: Record<string, unknown>,
  now: number
): number {
  const hasAmountMsats = body.amount_msats !== undefined;
  const hasFiat = body.fiat !== undefined;

  if (hasAmountMsats === hasFiat) {
    throw httpError(
      400,
      "INVALID_REQUEST",
      "Create invoice request requires exactly one of amount_msats or fiat."
    );
  }

  if (hasAmountMsats) {
    const amountMsats = optionalSafeInteger(body.amount_msats);
    if (amountMsats === undefined) {
      throw httpError(400, "INVALID_REQUEST", "amount_msats must be a safe integer.");
    }
    return amountMsats;
  }

  return quoteFiatToMsats({
    fiat: parseFiatAmount(body.fiat),
    as_of: now
  }).amount_msats;
}

function getCreateDescriptionFields(body: Record<string, unknown>): {
  readonly description?: string;
  readonly description_hash?: string;
} {
  const description = optionalString(body.description);
  const descriptionHash = optionalString(body.description_hash);

  if (description !== undefined && descriptionHash !== undefined) {
    throw httpError(
      400,
      "INVALID_REQUEST",
      "Create invoice request accepts only one of description or description_hash."
    );
  }

  if (descriptionHash !== undefined && !HEX_64.test(descriptionHash)) {
    throw httpError(
      400,
      "INVALID_REQUEST",
      "description_hash must be 64 hex characters."
    );
  }

  return {
    ...(description === undefined ? {} : { description }),
    ...(descriptionHash === undefined ? {} : { description_hash: descriptionHash })
  };
}

function findLookupInvoice(
  store: InMemoryInvoiceStore,
  body: Record<string, unknown>
): InvoiceStorageRow {
  const paymentHash = optionalString(body.payment_hash);
  const bolt11Invoice = optionalString(body.invoice);

  if ((paymentHash === undefined) === (bolt11Invoice === undefined)) {
    throw httpError(
      400,
      "INVALID_REQUEST",
      "lookup requires exactly one of payment_hash or invoice."
    );
  }

  const invoice =
    paymentHash === undefined
      ? store.getInvoiceByBolt11Invoice(requiredValue(bolt11Invoice))
      : store.getInvoiceByPaymentHash(paymentHash);

  if (invoice === undefined) {
    throw new InvoiceNotFoundError(paymentHash ?? requiredValue(bolt11Invoice));
  }

  return invoice;
}

async function requireAuthorization(
  options: OpenReceiveExpressOptions,
  action: keyof OpenReceiveExpressAuthorization,
  req: ExpressLikeRequest,
  invoice?: InvoiceStorageRow
): Promise<void> {
  if (options.unsafeAllowUnauthenticatedDemoMode === true) return;

  if (action === "create") {
    if (options.auth?.create === undefined) {
      throw httpError(401, "UNAUTHORIZED", "OpenReceive create authorization hook is required.");
    }

    const allowed = await options.auth.create(req);
    if (!allowed) {
      throw httpError(403, "UNAUTHORIZED", "OpenReceive request is not authorized.");
    }
    return;
  }

  if (invoice === undefined) {
    throw new Error(`OpenReceive ${action} authorization requires an invoice.`);
  }

  const hook = options.auth?.[action] as
    | ((
        req: ExpressLikeRequest,
        invoice: InvoiceStorageRow
      ) => Promise<boolean> | boolean)
    | undefined;

  if (hook === undefined) {
    throw httpError(401, "UNAUTHORIZED", `OpenReceive ${action} authorization hook is required.`);
  }

  const allowed = await hook(req, invoice);
  if (!allowed) {
    throw httpError(403, "UNAUTHORIZED", "OpenReceive request is not authorized.");
  }
}

async function requireCsrf(
  options: OpenReceiveExpressOptions,
  req: ExpressLikeRequest
): Promise<void> {
  if (options.unsafeAllowUnauthenticatedDemoMode === true) return;
  if (options.csrf?.verify === undefined) return;

  const verified = await options.csrf.verify(req);
  if (!verified) {
    throw httpError(403, "UNAUTHORIZED", "CSRF verification failed.");
  }
}

function applyDefaultHeaders(
  req: ExpressLikeRequest,
  res: ExpressLikeResponse,
  options: OpenReceiveExpressOptions
): void {
  res.set("Cache-Control", "no-store");
  res.set("Referrer-Policy", "same-origin");

  const origin = getHeader(req, "origin");
  if (origin === undefined || options.cors?.allowed_origins === undefined) return;

  if (options.cors.allowed_origins.includes("*") && options.cors.credentials) {
    throw httpError(
      500,
      "INTERNAL",
      "Wildcard CORS cannot be used with credentials."
    );
  }

  if (options.cors.allowed_origins.includes(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    if (options.cors.credentials === true) {
      res.set("Access-Control-Allow-Credentials", "true");
    }
  }
}

function wrapHandler(
  handler: (req: ExpressLikeRequest, res: ExpressLikeResponse) => Promise<unknown>
): ExpressLikeHandler {
  return (req, res, next) => {
    return handler(req, res).catch((error: unknown) => {
      if (isHttpError(error)) {
        res.status(error.status).json({
          code: error.code,
          message: error.message
        });
        return;
      }

      next(error);
    });
  };
}

function formatSseEvent(
  id: number,
  event: string,
  data: Record<string, unknown>
): string {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function getLastEventId(req: ExpressLikeRequest): number {
  const value = getHeader(req, "last-event-id");
  if (value === undefined) return 0;

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function requireStoredInvoice(
  store: InMemoryInvoiceStore,
  invoiceId: string | undefined
): InvoiceStorageRow {
  if (invoiceId === undefined || invoiceId.length === 0) {
    throw httpError(400, "INVALID_REQUEST", "invoice_id is required.");
  }

  const invoice = store.getInvoice(invoiceId);
  if (invoice === undefined) throw new InvoiceNotFoundError(invoiceId);
  return invoice;
}

function parseFiatAmount(value: unknown): { currency: string; value: string } {
  const fiat = asRecord(value);
  const currency = optionalString(fiat.currency);
  const amount = optionalString(fiat.value);

  if (currency === undefined || amount === undefined) {
    throw httpError(400, "INVALID_REQUEST", "fiat.currency and fiat.value are required.");
  }

  return {
    currency,
    value: amount
  };
}

function normalizeBasePath(basePath: string | undefined): string {
  const value = basePath ?? DEFAULT_BASE_PATH;
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function createInvoiceId(): string {
  return `or_inv_${globalThis.crypto.randomUUID().replace(/-/g, "")}`;
}

function currentUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function getHeader(
  req: ExpressLikeRequest,
  name: string
): string | undefined {
  const fromGetter = req.get?.(name);
  if (fromGetter !== undefined) return fromGetter;

  const headers = req.headers ?? {};
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) return {};
  return value as Record<string, unknown>;
}

function parseOptionalRecord(
  value: unknown,
  fieldName: string
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw httpError(400, "INVALID_REQUEST", `${fieldName} must be an object.`);
  }
  return asRecord(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalSafeInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "bigint" && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  return undefined;
}

function toSafeInteger(value: bigint, fieldName: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw httpError(500, "INTERNAL", `${fieldName} exceeds JSON safe integer boundary.`);
  }

  return Number(value);
}

function requiredValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value to be present.");
  return value;
}

interface HttpError extends Error {
  status: number;
  code: string;
}

function httpError(status: number, code: string, message: string): HttpError {
  const error = new Error(message) as HttpError;
  error.name = "OpenReceiveHttpError";
  error.status = status;
  error.code = code;
  return error;
}

function isHttpError(error: unknown): error is HttpError {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    "code" in error
  );
}
