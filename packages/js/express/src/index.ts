import {
  createHmac,
  timingSafeEqual
} from "node:crypto";
import {
  InMemoryInvoiceStore,
  InvoiceNotFoundError,
  OPENRECEIVE_STATIC_BTC_FIAT_RATES,
  createIdempotencyRequestHash,
  quoteFiatToMsats,
  type InvoiceStorageRow,
  type OpenReceiveIdempotencyScope,
  type OpenReceiveErrorCode,
  type OpenReceiveReceiveNwcClient
} from "@openreceive/core";
import {
  getAssets,
  getCountries,
  getCryptoRoutes,
  getDisqualifiedProviders,
  getFiatRails,
  getPaymentWizardRoutes,
  getProviderRegistryMetadata,
  getProviders,
  type ProviderFilter
} from "@openreceive/provider-data";

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
  refresh?: (
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

export interface OpenReceiveExpressSignedEvents {
  secret: string | Uint8Array;
  ttlSeconds?: number;
  queryParam?: string;
}

export interface OpenReceiveExpressFulfillmentInput {
  req: ExpressLikeRequest;
  invoice: InvoiceStorageRow;
  metadata: Record<string, unknown>;
}

export type OpenReceiveExpressFulfillHook = (
  input: OpenReceiveExpressFulfillmentInput
) => Promise<void> | void;

export interface OpenReceiveExpressOptions {
  client: OpenReceiveReceiveNwcClient;
  store?: InMemoryInvoiceStore;
  eventBus?: InMemoryInvoiceEventBus;
  basePath?: string;
  merchantScope: (req: ExpressLikeRequest) => string;
  auth?: OpenReceiveExpressAuthorization;
  csrf?: OpenReceiveExpressCsrf;
  cors?: OpenReceiveExpressCors;
  signedEvents?: OpenReceiveExpressSignedEvents;
  fulfill?: OpenReceiveExpressFulfillHook;
  unsafeAllowUnauthenticatedDemoMode?: boolean;
  clock?: () => number;
  heartbeatSeconds?: number;
}

export interface OpenReceiveExpressHandlers {
  createInvoice: ExpressLikeHandler;
  getInvoice: ExpressLikeHandler;
  lookupInvoice: ExpressLikeHandler;
  refreshInvoice: ExpressLikeHandler;
  invoiceEvents: ExpressLikeHandler;
  listRates: ExpressLikeHandler;
  quoteRates: ExpressLikeHandler;
  listRoutes: ExpressLikeHandler;
  listProviders: ExpressLikeHandler;
  health: ExpressLikeHandler;
  capabilities: ExpressLikeHandler;
}

const DEFAULT_BASE_PATH = "/openreceive/v1";
const DEFAULT_HEARTBEAT_SECONDS = 20;
const DEFAULT_SIGNED_EVENT_TTL_SECONDS = 300;
const DEFAULT_SIGNED_EVENT_QUERY_PARAM = "_or_evt";
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
  app.post(`${basePath}/invoices/:invoice_id/refresh`, handlers.refreshInvoice);
  app.get(`${basePath}/invoices/:invoice_id/events`, handlers.invoiceEvents);
  app.get(`${basePath}/rates`, handlers.listRates);
  app.post(`${basePath}/rates/quote`, handlers.quoteRates);
  app.get(`${basePath}/routes`, handlers.listRoutes);
  app.get(`${basePath}/providers`, handlers.listProviders);
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
        return res.status(200).json(serializeInvoice(existing.row, {
          basePath,
          options,
          clock
        }));
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

      return res.status(201).json(serializeInvoice(createResult.row, {
        basePath,
        options,
        clock
      }));
    }),

    getInvoice: wrapHandler(async (req, res) => {
      applyDefaultHeaders(req, res, options);
      const invoice = requireStoredInvoice(store, req.params?.invoice_id);
      await requireAuthorization(options, "read", req, invoice);
      return res.status(200).json(serializeInvoice(invoice, {
        basePath,
        options,
        clock
      }));
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
        current = await maybeFulfillInvoice({
          options,
          req,
          store,
          eventBus,
          invoice: current,
          clock
        });
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
        ...serializeInvoice(current, {
          basePath,
          options,
          clock
        }),
        preimage_present: lookup.preimage !== undefined
      });
    }),

    refreshInvoice: wrapHandler(async (req, res) => {
      applyDefaultHeaders(req, res, options);
      const oldInvoice = requireStoredInvoice(store, req.params?.invoice_id);
      await requireAuthorization(options, "refresh", req, oldInvoice);
      await requireCsrf(options, req);

      if (!isRefreshableInvoice(oldInvoice)) {
        throw httpError(
          409,
          "CONFLICT",
          "Invoice can only be refreshed after it expires or fails."
        );
      }

      const body = asRecord(req.body);
      const idempotencyKey = getHeader(req, "idempotency-key");
      if (idempotencyKey === undefined || idempotencyKey.length === 0) {
        throw httpError(400, "INVALID_REQUEST", "Idempotency-Key header is required.");
      }

      const reason = optionalString(body.reason) ?? oldInvoice.transaction_state;
      const operation = "invoice.refresh" as const;
      const idempotencyScope: OpenReceiveIdempotencyScope = {
        merchant_scope: oldInvoice.merchant_scope,
        operation,
        idempotency_key: idempotencyKey
      };
      const requestHash = await createIdempotencyRequestHash(body);
      const existing = store.checkIdempotency({
        scope: idempotencyScope,
        idempotency_request_hash: requestHash
      });

      if (existing !== undefined) {
        return res.status(200).json(serializeRefreshResult({
          oldInvoice,
          newInvoice: existing.row,
          reason,
          basePath,
          options,
          clock
        }));
      }

      const invoice = await options.client.makeInvoice({
        amount_msats: BigInt(oldInvoice.amount_msats)
      });
      const createdAt = invoice.created_at ?? clock();
      const expiresAt = invoice.expires_at ?? createdAt + 600;
      const createResult = store.createInvoice({
        invoice_id: createInvoiceId(),
        merchant_scope: oldInvoice.merchant_scope,
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
        refreshed_from_invoice_id: oldInvoice.invoice_id,
        metadata: oldInvoice.metadata,
        fiat_quote: oldInvoice.fiat_quote ?? null
      });
      eventBus.publish(
        createResult.row.invoice_id,
        "invoice.created",
        serializeEventData(createResult.row)
      );

      return res.status(201).json(serializeRefreshResult({
        oldInvoice,
        newInvoice: createResult.row,
        reason,
        basePath,
        options,
        clock
      }));
    }),

    invoiceEvents: wrapHandler(async (req, res) => {
      applyDefaultHeaders(req, res, options);
      const invoice = requireStoredInvoice(store, req.params?.invoice_id);
      await requireEventAuthorization(options, req, invoice, clock());

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

    listRates: wrapHandler(async (req, res) => {
      applyDefaultHeaders(req, res, options);
      return res.status(200).json(OPENRECEIVE_STATIC_BTC_FIAT_RATES);
    }),

    quoteRates: wrapHandler(async (req, res) => {
      applyDefaultHeaders(req, res, options);
      const body = asRecord(req.body);

      try {
        return res.status(200).json(quoteFiatToMsats({
          fiat: parseFiatAmount(body.fiat),
          as_of: clock()
        }));
      } catch (error) {
        if (error instanceof RangeError) {
          throw httpError(400, "INVALID_REQUEST", error.message);
        }
        throw error;
      }
    }),

    listRoutes: wrapHandler(async (req, res) => {
      applyDefaultHeaders(req, res, options);
      const asset = getQueryString(req, "asset");
      const route = getQueryString(req, "route");
      const country = getQueryString(req, "country");
      const rail = getQueryString(req, "rail");

      if (
        asset !== undefined ||
        route !== undefined ||
        country !== undefined ||
        rail !== undefined
      ) {
        return res.status(200).json({
          routes: getPaymentWizardRoutes({ asset, route, country, rail })
        });
      }

      return res.status(200).json({
        assets: getAssets(),
        crypto_routes: getCryptoRoutes(),
        fiat_rails: getFiatRails(),
        countries: getCountries()
      });
    }),

    listProviders: wrapHandler(async (req, res) => {
      applyDefaultHeaders(req, res, options);
      return res.status(200).json({
        metadata: getProviderRegistryMetadata(),
        providers: getProviders(getProviderFilter(req)),
        disqualified_providers: getDisqualifiedProviders()
      });
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
          refresh: `${basePath}/invoices/{invoice_id}/refresh`,
          rates: `${basePath}/rates`,
          rate_quote: `${basePath}/rates/quote`,
          routes: `${basePath}/routes`,
          providers: `${basePath}/providers`,
          health: `${basePath}/health`
        }
      });
    })
  };
}

function getProviderFilter(req: ExpressLikeRequest): ProviderFilter {
  const filter: ProviderFilter = {};
  const mechanism = getQueryString(req, "mechanism");
  const us = getQueryString(req, "us");

  if (mechanism === "pay_invoice" || mechanism === "withdraw_to_invoice") {
    return {
      ...filter,
      mechanism,
      ...(us === undefined ? {} : { us: parseUsFilter(us) })
    };
  }

  return {
    ...filter,
    ...(us === undefined ? {} : { us: parseUsFilter(us) })
  };
}

function serializeRefreshResult(input: {
  oldInvoice: InvoiceStorageRow;
  newInvoice: InvoiceStorageRow;
  reason: string;
  basePath: string;
  options: OpenReceiveExpressOptions;
  clock: () => number;
}): Record<string, unknown> {
  return {
    old_invoice_id: input.oldInvoice.invoice_id,
    new_invoice_id: input.newInvoice.invoice_id,
    reason: input.reason,
    invoice: serializeInvoice(input.newInvoice, {
      basePath: input.basePath,
      options: input.options,
      clock: input.clock
    })
  };
}

interface SerializeInvoiceContext {
  basePath: string;
  options: OpenReceiveExpressOptions;
  clock: () => number;
}

function serializeInvoice(
  row: InvoiceStorageRow,
  context: SerializeInvoiceContext
): Record<string, unknown> {
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
    ...(row.settled_at === undefined ? {} : { settled_at: row.settled_at }),
    ...(row.fulfilled_at === undefined ? {} : { fulfilled_at: row.fulfilled_at }),
    ...(row.refreshed_from_invoice_id === undefined
      ? {}
      : { refreshed_from_invoice_id: row.refreshed_from_invoice_id }),
    metadata: row.metadata,
    fiat_quote: row.fiat_quote ?? null,
    checkout: {
      events_url: createEventUrl(row, context),
      routes_url: `${context.basePath}/routes?invoice_id=${row.invoice_id}`
    },
    fulfillment: {
      state: row.fulfillment_state
    }
  };
}

interface SignedEventTokenPayload {
  v: 1;
  invoice_id: string;
  exp: number;
}

function createEventUrl(
  row: InvoiceStorageRow,
  context: SerializeInvoiceContext
): string {
  const baseUrl = `${context.basePath}/invoices/${row.invoice_id}/events`;
  const signedEvents = context.options.signedEvents;
  if (signedEvents === undefined) return baseUrl;

  const queryParam = getSignedEventQueryParam(signedEvents);
  const token = createSignedEventToken(row.invoice_id, context.clock(), signedEvents);
  return `${baseUrl}?${queryParam}=${encodeURIComponent(token)}`;
}

async function requireEventAuthorization(
  options: OpenReceiveExpressOptions,
  req: ExpressLikeRequest,
  invoice: InvoiceStorageRow,
  now: number
): Promise<void> {
  const signedEvents = options.signedEvents;
  if (signedEvents !== undefined) {
    const token = getQueryString(req, getSignedEventQueryParam(signedEvents));

    if (token !== undefined) {
      if (!verifySignedEventToken(token, invoice.invoice_id, now, signedEvents)) {
        throw httpError(
          403,
          "UNAUTHORIZED",
          "Signed event URL is invalid or expired."
        );
      }
      return;
    }
  }

  await requireAuthorization(options, "events", req, invoice);
}

function createSignedEventToken(
  invoiceId: string,
  now: number,
  signedEvents: OpenReceiveExpressSignedEvents
): string {
  const payload: SignedEventTokenPayload = {
    v: 1,
    invoice_id: invoiceId,
    exp: now + getSignedEventTtlSeconds(signedEvents)
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = signSignedEventPayload(encodedPayload, signedEvents);
  return `${encodedPayload}.${signature}`;
}

function verifySignedEventToken(
  token: string,
  invoiceId: string,
  now: number,
  signedEvents: OpenReceiveExpressSignedEvents
): boolean {
  const parts = token.split(".");
  if (parts.length !== 2) return false;

  const [encodedPayload, signature] = parts;
  if (encodedPayload === undefined || signature === undefined) return false;

  const expectedSignature = signSignedEventPayload(encodedPayload, signedEvents);
  if (!timingSafeStringEqual(signature, expectedSignature)) return false;

  const payload = parseSignedEventPayload(encodedPayload);
  return (
    payload !== undefined &&
    payload.v === 1 &&
    payload.invoice_id === invoiceId &&
    Number.isSafeInteger(payload.exp) &&
    payload.exp >= now
  );
}

function parseSignedEventPayload(
  encodedPayload: string
): SignedEventTokenPayload | undefined {
  try {
    return JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

function signSignedEventPayload(
  encodedPayload: string,
  signedEvents: OpenReceiveExpressSignedEvents
): string {
  assertSignedEventSecret(signedEvents);
  return createHmac("sha256", signedEvents.secret)
    .update(encodedPayload)
    .digest("base64url");
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function getSignedEventTtlSeconds(
  signedEvents: OpenReceiveExpressSignedEvents
): number {
  const ttl = signedEvents.ttlSeconds ?? DEFAULT_SIGNED_EVENT_TTL_SECONDS;
  if (!Number.isSafeInteger(ttl) || ttl <= 0) {
    throw httpError(
      500,
      "INTERNAL",
      "signedEvents.ttlSeconds must be a positive safe integer."
    );
  }
  return ttl;
}

function getSignedEventQueryParam(
  signedEvents: OpenReceiveExpressSignedEvents
): string {
  const queryParam = signedEvents.queryParam ?? DEFAULT_SIGNED_EVENT_QUERY_PARAM;
  if (!/^[A-Za-z0-9_.~-]+$/.test(queryParam)) {
    throw httpError(
      500,
      "INTERNAL",
      "signedEvents.queryParam must be URL query-name safe."
    );
  }
  return queryParam;
}

function assertSignedEventSecret(
  signedEvents: OpenReceiveExpressSignedEvents
): void {
  const byteLength =
    typeof signedEvents.secret === "string"
      ? Buffer.byteLength(signedEvents.secret, "utf8")
      : signedEvents.secret.byteLength;

  if (byteLength < 32) {
    throw httpError(
      500,
      "INTERNAL",
      "signedEvents.secret must be at least 32 bytes."
    );
  }
}

function serializeEventData(row: InvoiceStorageRow): Record<string, unknown> {
  return {
    invoice_id: row.invoice_id,
    type: "incoming",
    transaction_state: row.transaction_state,
    workflow_state: row.workflow_state,
    payment_hash: row.payment_hash,
    amount_msats: row.amount_msats,
    ...(row.settled_at === undefined ? {} : { settled_at: row.settled_at }),
    ...(row.fulfilled_at === undefined ? {} : { fulfilled_at: row.fulfilled_at }),
    ...(row.refreshed_from_invoice_id === undefined
      ? {}
      : { refreshed_from_invoice_id: row.refreshed_from_invoice_id })
  };
}

async function maybeFulfillInvoice(input: {
  options: OpenReceiveExpressOptions;
  req: ExpressLikeRequest;
  store: InMemoryInvoiceStore;
  eventBus: InMemoryInvoiceEventBus;
  invoice: InvoiceStorageRow;
  clock: () => number;
}): Promise<InvoiceStorageRow> {
  if (input.options.fulfill === undefined) return input.invoice;
  if (input.invoice.transaction_state !== "settled") return input.invoice;
  if (
    input.invoice.workflow_state === "fulfilled" ||
    input.invoice.fulfillment_state === "delivered"
  ) {
    return input.invoice;
  }

  await input.options.fulfill({
    req: input.req,
    invoice: input.invoice,
    metadata: input.invoice.metadata
  });
  const fulfilled = input.store.markFulfilled({
    invoice_id: input.invoice.invoice_id,
    fulfilled_at: input.clock()
  });
  input.eventBus.publish(
    fulfilled.invoice_id,
    "invoice.fulfilled",
    serializeEventData(fulfilled)
  );
  return fulfilled;
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

function isRefreshableInvoice(invoice: InvoiceStorageRow): boolean {
  return (
    invoice.transaction_state === "expired" ||
    invoice.transaction_state === "failed" ||
    invoice.workflow_state === "expired_closed" ||
    invoice.workflow_state === "failed_closed"
  );
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

function getQueryString(
  req: ExpressLikeRequest,
  name: string
): string | undefined {
  const value = req.query?.[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

function parseUsFilter(value: string): boolean | null {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "unknown" || value === "null") return null;
  throw httpError(400, "INVALID_REQUEST", "us filter must be true, false, unknown, or null.");
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
  code: OpenReceiveErrorCode;
}

function httpError(
  status: number,
  code: OpenReceiveErrorCode,
  message: string
): HttpError {
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
