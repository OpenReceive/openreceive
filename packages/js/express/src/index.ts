import {
  createHmac,
  timingSafeEqual
} from "node:crypto";
import {
  InMemoryInvoiceStore,
  InvoiceNotFoundError,
  StaticPriceProvider,
  createIdempotencyRequestHash,
  getBtcFiatRatesWithFallback,
  quoteFiatToMsatsWithPrice,
  type InvoiceStorageRow,
  type OpenReceiveBtcFiatRateMapWithSource,
  type OpenReceiveFiatAmount,
  type OpenReceiveIdempotencyScope,
  type OpenReceiveRateQuote,
  type OpenReceiveErrorCode,
  type OpenReceiveReceiveNwcClient,
  type OpenReceiveSourcedPriceProvider
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

export type OpenReceiveLogLevel = "debug" | "info" | "warn" | "error";

export interface OpenReceiveLogEntry {
  readonly level: OpenReceiveLogLevel;
  readonly event: string;
  readonly message: string;
  readonly [key: string]: unknown;
}

export type OpenReceiveLogger = (entry: OpenReceiveLogEntry) => void;

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

export interface OpenReceiveExpressSettlementActionInput {
  req: ExpressLikeRequest;
  invoice: InvoiceStorageRow;
  metadata: Record<string, unknown>;
}

export type OpenReceiveExpressSettlementActionHook = (
  input: OpenReceiveExpressSettlementActionInput
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
  settlementAction?: OpenReceiveExpressSettlementActionHook;
  priceProviders?: readonly OpenReceiveSourcedPriceProvider[];
  priceCurrencies?: readonly string[];
  unsafeAllowUnauthenticatedDemoMode?: boolean;
  logger?: OpenReceiveLogger;
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
  | "invoice.settlement_action_completed"
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
  assertSafeDemoModeConfiguration(options);

  const store = options.store ?? new InMemoryInvoiceStore();
  const eventBus = options.eventBus ?? new InMemoryInvoiceEventBus();
  const clock = options.clock ?? currentUnixSeconds;
  const basePath = normalizeBasePath(options.basePath);
  const priceProviders = options.priceProviders ?? [new StaticPriceProvider()];
  const priceCurrencies = options.priceCurrencies ?? ["USD"];
  const heartbeatMs =
    (options.heartbeatSeconds ?? DEFAULT_HEARTBEAT_SECONDS) * 1000;
  const handle = (
    handler: (req: ExpressLikeRequest, res: ExpressLikeResponse) => Promise<unknown>
  ): ExpressLikeHandler => wrapHandler(options, handler);

  return {
    createInvoice: handle(async (req, res) => {
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
        emitLog(options, "info", "invoice.create.replayed", "Replayed existing invoice for idempotent create request.", invoiceLogFields(existing.row));
        return res.status(200).json(serializeInvoice(existing.row, {
          basePath,
          options,
          clock
        }));
      }

      const resolvedAmount = await resolveCreateAmount({
        body,
        now: clock(),
        priceProviders
      });
      const descriptionFields = getCreateDescriptionFields(body);
      emitLog(options, "info", "invoice.create.requested", "Creating Lightning invoice through receive wallet.", {
        amount_msats: resolvedAmount.amount_msats,
        amount_source: resolvedAmount.amount_source,
        ...(resolvedAmount.fiat_quote === null
          ? {}
          : {
            btc_fiat_price: resolvedAmount.fiat_quote.btc_fiat_price,
            price_source: resolvedAmount.fiat_quote.source
          })
      });
      const invoice = await options.client.makeInvoice({
        amount_msats: BigInt(resolvedAmount.amount_msats),
        ...descriptionFields,
        expiry: optionalSafeInteger(body.expiry),
        metadata: parseOptionalRecord(body.metadata, "metadata")
      });
      const createdAt = invoice.created_at ?? clock();
      const requestedExpirySeconds = optionalSafeInteger(body.expiry) ?? 600;
      const expiresAt =
        invoice.expires_at ??
        createdAt + requestedExpirySeconds;
      const normalizedExpiresAt = Math.min(expiresAt, createdAt + requestedExpirySeconds);

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
        settlement_action_state: "pending",
        created_at: createdAt,
        expires_at: normalizedExpiresAt,
        metadata: parseOptionalRecord(body.metadata, "metadata") ?? {},
        fiat_quote: resolvedAmount.fiat_quote === null
          ? null
          : { ...resolvedAmount.fiat_quote }
      });
      eventBus.publish(
        createResult.row.invoice_id,
        "invoice.created",
        serializeEventData(createResult.row)
      );
      emitLog(options, "info", "invoice.created", "Created Lightning invoice.", invoiceLogFields(createResult.row));

      return res.status(201).json(serializeInvoice(createResult.row, {
        basePath,
        options,
        clock
      }));
    }),

    getInvoice: handle(async (req, res) => {
      applyDefaultHeaders(req, res, options);
      const invoice = requireStoredInvoice(store, req.params?.invoice_id);
      await requireAuthorization(options, "read", req, invoice);
      emitLog(options, "debug", "invoice.read", "Read invoice state.", invoiceLogFields(invoice));
      return res.status(200).json(serializeInvoice(invoice, {
        basePath,
        options,
        clock
      }));
    }),

    lookupInvoice: handle(async (req, res) => {
      applyDefaultHeaders(req, res, options);
      const body = asRecord(req.body);
      const invoice = findLookupInvoice(store, body);
      await requireAuthorization(options, "lookup", req, invoice);
      await requireCsrf(options, req);
      emitLog(options, "info", "invoice.lookup.requested", "Looking up invoice settlement through receive wallet.", invoiceLogFields(invoice));

      let current = invoice;
      if (invoice.workflow_state === "invoice_created") {
        current = store.markVerifying(invoice.invoice_id);
        eventBus.publish(
          current.invoice_id,
          "invoice.verifying",
          serializeEventData(current)
        );
        emitLog(options, "info", "invoice.verifying", "Invoice entered backend verification.", invoiceLogFields(current));
      }

      const lookup = await options.client.lookupInvoice({
        payment_hash: optionalString(body.payment_hash),
        invoice: optionalString(body.invoice)
      });

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
          emitLog(options, "info", "invoice.settled", "Invoice settlement was verified by wallet lookup.", invoiceLogFields(current));
        }
        current = await maybeRunSettlementAction({
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
          emitLog(options, "info", "invoice.expired", "Invoice was closed as expired by wallet lookup.", invoiceLogFields(current));
        }
      } else if (lookup.state === "failed" || lookup.transaction_state === "failed") {
        current = store.markFailedClosed(invoice.invoice_id);
        if (invoice.transaction_state !== "failed") {
          eventBus.publish(
            current.invoice_id,
            "invoice.failed",
            serializeEventData(current)
          );
          emitLog(options, "warn", "invoice.failed", "Invoice was closed as failed by wallet lookup.", invoiceLogFields(current));
        }
      } else {
        emitLog(options, "debug", "invoice.lookup.pending", "Wallet lookup did not prove a terminal invoice state.", invoiceLogFields(current));
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

    refreshInvoice: handle(async (req, res) => {
      applyDefaultHeaders(req, res, options);
      const oldInvoice = requireStoredInvoice(store, req.params?.invoice_id);
      await requireAuthorization(options, "refresh", req, oldInvoice);
      await requireCsrf(options, req);
      emitLog(options, "info", "invoice.refresh.requested", "Refreshing invoice by creating a linked replacement.", invoiceLogFields(oldInvoice));

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
        emitLog(options, "info", "invoice.refresh.replayed", "Replayed existing refreshed invoice for idempotent request.", invoiceLogFields(existing.row));
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
      const expiresAt = Math.min(invoice.expires_at ?? createdAt + 600, createdAt + 600);
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
        settlement_action_state: "pending",
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
      emitLog(options, "info", "invoice.refresh.created", "Created linked replacement invoice.", {
        ...invoiceLogFields(createResult.row),
        old_invoice_id: oldInvoice.invoice_id
      });

      return res.status(201).json(serializeRefreshResult({
        oldInvoice,
        newInvoice: createResult.row,
        reason,
        basePath,
        options,
        clock
      }));
    }),

    invoiceEvents: handle(async (req, res) => {
      applyDefaultHeaders(req, res, options);
      const invoice = requireStoredInvoice(store, req.params?.invoice_id);
      await requireEventAuthorization(options, req, invoice, clock());

      res.status(200);
      res.set("Content-Type", "text/event-stream");
      res.set("Cache-Control", "no-store");
      res.flushHeaders?.();
      const lastEventId = getLastEventId(req);
      const replayedEvents = eventBus.replay(invoice.invoice_id, lastEventId);
      emitLog(options, "info", "invoice.events.opened", "Opened invoice event stream.", {
        ...invoiceLogFields(invoice),
        last_event_id: lastEventId,
        replayed_events: replayedEvents.length
      });
      for (const event of replayedEvents) {
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
          emitLog(options, "debug", "invoice.events.closed", "Closed invoice event stream.", invoiceLogFields(invoice));
        });
      } else {
        res.write?.(": heartbeat\n\n");
        unsubscribe();
        emitLog(options, "debug", "invoice.events.closed", "Closed invoice event stream.", invoiceLogFields(invoice));
      }
    }),

    listRates: handle(async (req, res) => {
      applyDefaultHeaders(req, res, options);
      try {
        const rates = await getBtcFiatRatesForProviders({
          currencies: priceCurrencies,
          priceProviders
        });
        return res.status(200).json(rates.rates);
      } catch (error) {
        throw mapPriceError(error);
      }
    }),

    quoteRates: handle(async (req, res) => {
      applyDefaultHeaders(req, res, options);
      const body = asRecord(req.body);

      try {
        return res.status(200).json(await quoteFiatAmount({
          fiat: parseFiatAmount(body.fiat),
          as_of: clock(),
          priceProviders
        }));
      } catch (error) {
        throw mapPriceError(error);
      }
    }),

    listRoutes: handle(async (req, res) => {
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

    listProviders: handle(async (req, res) => {
      applyDefaultHeaders(req, res, options);
      return res.status(200).json({
        metadata: getProviderRegistryMetadata(),
        providers: getProviders(getProviderFilter(req)),
        disqualified_providers: getDisqualifiedProviders()
      });
    }),

    health: handle(async (req, res) => {
      applyDefaultHeaders(req, res, options);
      return res.status(200).json({ ok: true });
    }),

    capabilities: handle(async (req, res) => {
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
    ...(row.settlement_action_completed_at === undefined ? {} : { settlement_action_completed_at: row.settlement_action_completed_at }),
    ...(row.refreshed_from_invoice_id === undefined
      ? {}
      : { refreshed_from_invoice_id: row.refreshed_from_invoice_id }),
    metadata: row.metadata,
    fiat_quote: row.fiat_quote ?? null,
    checkout: {
      events_url: createEventUrl(row, context),
      routes_url: `${context.basePath}/routes?invoice_id=${row.invoice_id}`
    },
    settlement_action_state: row.settlement_action_state
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
    settlement_action_state: row.settlement_action_state,
    ...(row.settlement_action_completed_at === undefined ? {} : { settlement_action_completed_at: row.settlement_action_completed_at }),
    ...(row.refreshed_from_invoice_id === undefined
      ? {}
      : { refreshed_from_invoice_id: row.refreshed_from_invoice_id })
  };
}

async function maybeRunSettlementAction(input: {
  options: OpenReceiveExpressOptions;
  req: ExpressLikeRequest;
  store: InMemoryInvoiceStore;
  eventBus: InMemoryInvoiceEventBus;
  invoice: InvoiceStorageRow;
  clock: () => number;
}): Promise<InvoiceStorageRow> {
  if (input.invoice.transaction_state !== "settled") return input.invoice;
  if (
    input.invoice.workflow_state === "settlement_action_completed" ||
    input.invoice.settlement_action_state === "completed"
  ) {
    return input.invoice;
  }

  if (input.options.settlementAction !== undefined) {
    try {
      await input.options.settlementAction({
        req: input.req,
        invoice: input.invoice,
        metadata: input.invoice.metadata
      });
    } catch (error) {
      const failed = input.store.markSettlementActionFailed(input.invoice.invoice_id);
      emitLog(input.options, "error", "invoice.settlement_action_failed", "Settlement action hook failed for settled invoice.", {
        ...invoiceLogFields(failed),
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  const completed = input.store.markSettlementActionCompleted({
    invoice_id: input.invoice.invoice_id,
    settlement_action_completed_at: input.clock()
  });
  input.eventBus.publish(
    completed.invoice_id,
    "invoice.settlement_action_completed",
    serializeEventData(completed)
  );
  emitLog(input.options, "info", "invoice.settlement_action_completed", "Settlement action completed for settled invoice.", invoiceLogFields(completed));
  return completed;
}

function invoiceLogFields(row: InvoiceStorageRow): Record<string, unknown> {
  return {
    invoice_id: row.invoice_id,
    payment_hash: row.payment_hash,
    amount_msats: row.amount_msats,
    transaction_state: row.transaction_state,
    workflow_state: row.workflow_state,
    settlement_action_state: row.settlement_action_state,
    ...(row.settled_at === undefined ? {} : { settled_at: row.settled_at }),
    ...(row.settlement_action_completed_at === undefined ? {} : { settlement_action_completed_at: row.settlement_action_completed_at }),
    ...(row.refreshed_from_invoice_id === undefined
      ? {}
      : { refreshed_from_invoice_id: row.refreshed_from_invoice_id })
  };
}

function emitLog(
  options: OpenReceiveExpressOptions,
  level: OpenReceiveLogLevel,
  event: string,
  message: string,
  fields: Record<string, unknown> = {}
): void {
  if (options.logger === undefined) return;

  try {
    options.logger(sanitizeLogEntry({
      level,
      event,
      message,
      ...fields
    }));
  } catch {
    // Logging must never change payment, settlement, or settlement-action behavior.
  }
}

function sanitizeLogEntry(entry: OpenReceiveLogEntry): OpenReceiveLogEntry {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (isSensitiveLogKey(key)) {
      clean[key] = "[REDACTED]";
    } else {
      clean[key] = sanitizeLogValue(value);
    }
  }
  return clean as OpenReceiveLogEntry;
}

function sanitizeLogValue(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(sanitizeLogValue);
  if (typeof value !== "object" || value === null) return value;

  const clean: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (isSensitiveLogKey(key)) {
      clean[key] = "[REDACTED]";
    } else {
      clean[key] = sanitizeLogValue(nested);
    }
  }
  return clean;
}

function isSensitiveLogKey(key: string): boolean {
  return /secret|token|authorization|cookie|nwc/i.test(key);
}

function redactSecrets(value: string): string {
  return value
    .replace(/nostr\+walletconnect:\/\/[^\s"'`<>]+/g, "[REDACTED_NWC]")
    .replace(/([?&](?:_or_evt|token|secret)=)[^&\s"'`<>]+/gi, "$1[REDACTED]");
}

interface ResolvedCreateAmount {
  amount_msats: number;
  amount_source: "amount_msats" | "fiat";
  fiat_quote: OpenReceiveRateQuote | null;
}

async function resolveCreateAmount(input: {
  body: Record<string, unknown>;
  now: number;
  priceProviders: readonly OpenReceiveSourcedPriceProvider[];
}): Promise<ResolvedCreateAmount> {
  const { body } = input;
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
    return {
      amount_msats: amountMsats,
      amount_source: "amount_msats",
      fiat_quote: null
    };
  }

  try {
    const quote = await quoteFiatAmount({
      fiat: parseFiatAmount(body.fiat),
      as_of: input.now,
      priceProviders: input.priceProviders
    });
    return {
      amount_msats: quote.amount_msats,
      amount_source: "fiat",
      fiat_quote: quote
    };
  } catch (error) {
    throw mapPriceError(error);
  }
}

async function quoteFiatAmount(input: {
  fiat: OpenReceiveFiatAmount;
  as_of: number;
  priceProviders: readonly OpenReceiveSourcedPriceProvider[];
}): Promise<OpenReceiveRateQuote> {
  const rates = await getBtcFiatRatesForProviders({
    currencies: [input.fiat.currency],
    priceProviders: input.priceProviders
  });
  const btcFiatPrice = rates.rates.bitcoin[input.fiat.currency.toLowerCase()];

  if (btcFiatPrice === undefined) {
    throw new RangeError(`price provider ${rates.source} did not return ${input.fiat.currency}`);
  }

  return quoteFiatToMsatsWithPrice({
    fiat: input.fiat,
    btc_fiat_price: btcFiatPrice,
    source: rates.source,
    as_of: input.as_of
  });
}

async function getBtcFiatRatesForProviders(input: {
  currencies: readonly string[];
  priceProviders: readonly OpenReceiveSourcedPriceProvider[];
}): Promise<OpenReceiveBtcFiatRateMapWithSource> {
  if (input.priceProviders.length === 1) {
    const [provider] = input.priceProviders;
    return {
      source: provider.source,
      rates: await provider.getBtcFiatRates(input.currencies)
    };
  }

  return getBtcFiatRatesWithFallback({
    currencies: input.currencies,
    providers: input.priceProviders
  });
}

function mapPriceError(error: unknown): HttpError {
  if (error instanceof RangeError) {
    return httpError(400, "INVALID_REQUEST", error.message);
  }

  return httpError(
    503,
    "INTERNAL",
    "Unable to fetch BTC fiat exchange rate."
  );
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

function assertSafeDemoModeConfiguration(
  options: OpenReceiveExpressOptions
): void {
  if (options.unsafeAllowUnauthenticatedDemoMode !== true) return;

  const env = globalThis.process?.env ?? {};
  const mode = (env.OPENRECEIVE_MODE ?? env.NODE_ENV ?? "").toLowerCase();
  const acknowledged =
    env.OPENRECEIVE_ALLOW_UNAUTHENTICATED_DEMO === "true";

  // Fail closed by default: an adapter mounted in a real production app must
  // not silently disable auth + CSRF. A genuinely public test demo (tiny
  // amounts, owner pays self) may opt in explicitly with
  // OPENRECEIVE_ALLOW_UNAUTHENTICATED_DEMO=true.
  if (mode === "production" && !acknowledged) {
    throw new Error(
      "OpenReceive refuses unsafeAllowUnauthenticatedDemoMode when " +
        "OPENRECEIVE_MODE or NODE_ENV is production. Configure auth hooks " +
        "to fail closed, or set OPENRECEIVE_ALLOW_UNAUTHENTICATED_DEMO=true " +
        "to explicitly accept the risk for a public test demo."
    );
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
  options: OpenReceiveExpressOptions,
  handler: (req: ExpressLikeRequest, res: ExpressLikeResponse) => Promise<unknown>
): ExpressLikeHandler {
  return (req, res, next) => {
    return handler(req, res).catch((error: unknown) => {
      if (isHttpError(error)) {
        emitLog(options, error.status >= 500 ? "error" : "warn", "http.error", "OpenReceive request returned an HTTP error.", {
          status: error.status,
          code: error.code,
          message: error.message,
          method: req.method,
          path: req.path
        });
        res.status(error.status).json({
          code: error.code,
          message: error.message
        });
        return;
      }

      emitLog(options, "error", "handler.error", "OpenReceive request handler failed.", {
        error_name: error instanceof Error ? error.name : typeof error,
        error_message: error instanceof Error ? error.message : String(error),
        method: req.method,
        path: req.path
      });
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
