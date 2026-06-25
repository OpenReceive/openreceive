import type {
  IncomingMessage,
  ServerResponse
} from "node:http";
import {
  InMemoryInvoiceKvStore,
  InvoiceNotFoundError,
  StaticPriceProvider,
  createIdempotencyRequestHash,
  gatedLookup,
  getBtcFiatRatesWithFallback,
  getIdempotentRecord,
  maybeSweep,
  putCreatedInvoiceRecord,
  quoteFiatToMsatsWithPrice,
  reconcileOnce,
  type InvoiceStorageRow,
  type OpenReceiveBtcFiatRateMapWithSource,
  type OpenReceiveFiatAmount,
  type OpenReceiveIdempotencyScope,
  type OpenReceiveInvoiceKvStore,
  type OpenReceiveRateQuote,
  type OpenReceiveErrorCode,
  type OpenReceiveReceiveNwcClient,
  type OpenReceiveReconcileEvent,
  type OpenReceiveSourcedPriceProvider,
  type StoredRecord
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
import { formatOpenReceiveMissingNwcMessage } from "@openreceive/core";
import {
  createNwcReceiveClient
} from "./alby-nwc.ts";
import {
  resolveOpenReceiveStore,
  type OpenReceiveResolvedStore,
  type ResolveOpenReceiveStoreOptions
} from "./store-uri.ts";

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

export interface OpenReceiveNodeSettlementActionInput {
  req?: ExpressLikeRequest;
  invoice: InvoiceStorageRow;
  orderUuid: string;
  metadata: Record<string, unknown>;
  source: "http_lookup" | "poll";
  lookup_invoice?: unknown;
}

export type OpenReceiveNodeSettlementActionHook = (
  input: OpenReceiveNodeSettlementActionInput
) => Promise<void> | void;

export interface OpenReceiveNodeOptions {
  client: OpenReceiveReceiveNwcClient;
  store?: OpenReceiveInvoiceKvStore;
  basePath?: string;
  namespace?: string;
  onPaid?: OpenReceiveNodeSettlementActionHook;
  priceProviders?: readonly OpenReceiveSourcedPriceProvider[];
  priceCurrencies?: readonly string[];
  logger?: OpenReceiveLogger;
  clock?: () => number;
  lookupBurst?: number;
  lookupRatePerSecond?: number;
  actionLeaseTtlSeconds?: number;
  sweepIntervalSeconds?: number;
  sweepBatch?: number;
  backgroundSweep?: boolean;
}

type OpenReceiveNodeOptionsInput = OpenReceiveNodeOptions;

export interface CreateOpenReceiveOptions
  extends Omit<
    OpenReceiveNodeOptions,
    "client" | "onPaid" | "store"
  > {
  client?: OpenReceiveReceiveNwcClient;
  nwc?: string;
  store?: OpenReceiveInvoiceKvStore;
  storeUri?: string;
  namespace?: string;
  cwd?: string;
  onPaid?: OpenReceiveNodeSettlementActionHook;
  loadSqlite?: ResolveOpenReceiveStoreOptions["loadSqlite"];
  loadPostgres?: ResolveOpenReceiveStoreOptions["loadPostgres"];
}

export interface OpenReceiveNodeHandlers {
  createInvoice: ExpressLikeHandler;
  getInvoice: ExpressLikeHandler;
  lookupInvoice: ExpressLikeHandler;
  refreshInvoice: ExpressLikeHandler;
  poll: ExpressLikeHandler;
  listRates: ExpressLikeHandler;
  quoteRates: ExpressLikeHandler;
  listRoutes: ExpressLikeHandler;
  listProviders: ExpressLikeHandler;
  health: ExpressLikeHandler;
  capabilities: ExpressLikeHandler;
}

export interface OpenReceiveNodeRuntime {
  readonly store: OpenReceiveInvoiceKvStore;
  readonly handlers: OpenReceiveNodeHandlers;
  readonly basePath?: string;
}

export interface OpenReceiveServer
  extends Omit<OpenReceiveNodeOptions, "store"> {
  readonly store: OpenReceiveInvoiceKvStore;
  readonly runtime: OpenReceiveNodeRuntime;
  readonly handlers: OpenReceiveNodeHandlers;
  mountExpress(app: ExpressLikeApp): OpenReceiveNodeHandlers;
  handleFetch(request: Request): Promise<Response>;
  handleNode(req: IncomingMessage, res: ServerResponse): Promise<void>;
  close(): Promise<void>;
}

export interface OpenReceiveFetchRouteMatch {
  readonly name: keyof OpenReceiveNodeHandlers;
  readonly params?: Record<string, string | undefined>;
}

export interface DispatchOpenReceiveFetchHandlerOptions {
  readonly runtime: OpenReceiveNodeRuntime;
  readonly name: keyof OpenReceiveNodeHandlers;
  readonly request: Request;
  readonly params?: Record<string, string | undefined>;
}

export interface DispatchOpenReceiveFetchRouteOptions {
  readonly runtime: OpenReceiveNodeRuntime;
  readonly request: Request;
  readonly path: readonly string[];
}

export interface DispatchOpenReceiveFetchNoWalletRouteOptions {
  readonly request: Request;
  readonly path: readonly string[];
  readonly noWallet?: OpenReceiveFetchNoWalletOptions;
}

export interface OpenReceiveFetchNoWalletOptions {
  readonly basePath?: string;
  readonly message?: string;
}

export type OpenReceiveRouteSource =
  | OpenReceiveServer
  | OpenReceiveNodeRuntime
  | undefined
  | (() =>
    | OpenReceiveServer
    | OpenReceiveNodeRuntime
    | undefined
    | Promise<OpenReceiveServer | OpenReceiveNodeRuntime | undefined>);

export interface CreateOpenReceiveFetchHandlerOptions {
  readonly basePath?: string;
  readonly noWallet?: OpenReceiveFetchNoWalletOptions;
}

export interface CreateOpenReceiveNodeHandlerOptions
  extends CreateOpenReceiveFetchHandlerOptions {
  readonly origin?: string;
}

const DEFAULT_BASE_PATH = "/openreceive/v1";
const DEFAULT_NO_WALLET_MESSAGE = formatOpenReceiveMissingNwcMessage();
const HEX_64 = /^[0-9a-fA-F]{64}$/;

export async function createOpenReceive(
  options: CreateOpenReceiveOptions = {}
): Promise<OpenReceiveServer> {
  const namespace = readOpenReceiveNamespace(options.namespace);
  const client = options.client ?? createNwcReceiveClient({
    connectionString: readOpenReceiveNwc(options.nwc)
  });
  await client.preflight();

  const store = options.store ?? await resolveOpenReceiveStore(options.storeUri, {
    cwd: options.cwd,
    namespace,
    loadSqlite: options.loadSqlite,
    loadPostgres: options.loadPostgres
  });
  await ensureOpenReceiveStoreSchema(store);

  const nodeOptions: OpenReceiveNodeOptions = {
    ...options,
    client,
    store,
    namespace,
    onPaid: options.onPaid
  };
  const runtime = createNodeRuntime(nodeOptions);
  const server: OpenReceiveServer = {
    ...nodeOptions,
    store,
    runtime,
    handlers: runtime.handlers,
    mountExpress(app) {
      return mountExpressRoutes(app, server);
    },
    handleFetch: createFetchHandler(runtime, {
      basePath: options.basePath
    }),
    handleNode: createNodeHandler(runtime, {
      basePath: options.basePath
    }),
    async close() {
      await closeOpenReceiveResource(store);
      await closeOpenReceiveResource(client);
    }
  };

  return server;
}

function readOpenReceiveNwc(configured: string | undefined): string {
  const nwc = configured ?? globalThis.process?.env?.OPENRECEIVE_NWC;
  if (nwc === undefined || nwc.trim().length === 0) {
    throw new Error(formatOpenReceiveMissingNwcMessage());
  }

  return nwc;
}

function readOpenReceiveNamespace(configured: string | undefined): string {
  const namespace = configured ?? globalThis.process?.env?.OPENRECEIVE_NAMESPACE ?? "default";
  if (namespace.trim().length === 0) {
    throw new Error("OPENRECEIVE_NAMESPACE must not be empty.");
  }
  return namespace;
}

async function ensureOpenReceiveStoreSchema(store: OpenReceiveInvoiceKvStore): Promise<void> {
  const ensureSchema = isRecord(store) ? store.ensureSchema : undefined;
  if (typeof ensureSchema === "function") {
    await ensureSchema.call(store);
  }
}

function getOpenReceiveNodeHandlers(
  openreceive: OpenReceiveServer | OpenReceiveNodeRuntime | OpenReceiveNodeOptionsInput
): OpenReceiveNodeHandlers {
  if (isOpenReceiveServer(openreceive)) return openreceive.handlers;
  if (isOpenReceiveNodeRuntime(openreceive)) return openreceive.handlers;
  return createNodeHandlers(openreceive);
}

function getOpenReceiveBasePath(
  openreceive: OpenReceiveRouteSource | OpenReceiveNodeOptionsInput
): string | undefined {
  if (openreceive === undefined || typeof openreceive === "function") return undefined;
  return "basePath" in openreceive ? openreceive.basePath : undefined;
}

function isOpenReceiveServer(candidate: unknown): candidate is OpenReceiveServer {
  return isRecord(candidate) &&
    isOpenReceiveNodeRuntime(candidate.runtime) &&
    isRecord(candidate.handlers);
}

function isOpenReceiveNodeRuntime(candidate: unknown): candidate is OpenReceiveNodeRuntime {
  return isRecord(candidate) &&
    isRecord(candidate.handlers) &&
    "store" in candidate;
}

async function closeOpenReceiveResource(resource: unknown): Promise<void> {
  const close = isRecord(resource) ? resource.close : undefined;
  if (typeof close === "function") {
    await close.call(resource);
  }
}

export function mountExpressRoutes(
  app: ExpressLikeApp,
  openreceive: OpenReceiveServer | OpenReceiveNodeRuntime | OpenReceiveNodeOptionsInput
): OpenReceiveNodeHandlers {
  const handlers = getOpenReceiveNodeHandlers(openreceive);
  const basePath = normalizeBasePath(getOpenReceiveBasePath(openreceive));

  app.post(`${basePath}/invoices`, handlers.createInvoice);
  app.get(`${basePath}/invoices/:invoice_id`, handlers.getInvoice);
  app.post(`${basePath}/invoices/lookup`, handlers.lookupInvoice);
  app.post(`${basePath}/invoices/:invoice_id/refresh`, handlers.refreshInvoice);
  app.get(`${basePath}/rates`, handlers.listRates);
  app.post(`${basePath}/rates/quote`, handlers.quoteRates);
  app.get(`${basePath}/routes`, handlers.listRoutes);
  app.get(`${basePath}/providers`, handlers.listProviders);
  app.get(`${basePath}/health`, handlers.health);
  app.get(`${basePath}/capabilities`, handlers.capabilities);

  return handlers;
}

export function createNodeRuntime(
  options: OpenReceiveNodeOptionsInput
): OpenReceiveNodeRuntime {
  const store = options.store ?? new InMemoryInvoiceKvStore();
  const normalizedOptions = normalizeOpenReceiveNodeOptions(options);

  return {
    basePath: options.basePath,
    store,
    handlers: createNodeHandlers({
      ...normalizedOptions,
      store
    })
  };
}

export function createFetchHandler(
  openreceive: OpenReceiveRouteSource,
  options: CreateOpenReceiveFetchHandlerOptions = {}
): (request: Request) => Promise<Response> {
  const basePath = options.basePath ?? getOpenReceiveBasePath(openreceive);

  return async (request) => {
    const path = fetchPath(request, basePath);
    if (path === undefined) return routeNotFoundResponse();

    const runtime = await resolveOpenReceiveNodeRuntime(openreceive);
    if (runtime === undefined) {
      return dispatchNoWalletRoute({
        request,
        path,
        noWallet: options.noWallet
      });
    }

    return dispatchFetchRoute({
      runtime,
      request,
      path
    });
  };
}

export function createNodeHandler(
  openreceive: OpenReceiveRouteSource,
  options: CreateOpenReceiveNodeHandlerOptions = {}
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const handler = createFetchHandler(openreceive, options);

  return async (req, res) => {
    let response: Response;
    try {
      response = await handler(await createOpenReceiveRequestFromNode(req, options));
    } catch {
      response = jsonResponse({
        code: "INTERNAL",
        message: "OpenReceive request failed."
      }, 500);
    }

    await writeOpenReceiveNodeResponse(res, response);
  };
}

export async function dispatchFetchRoute(
  options: DispatchOpenReceiveFetchRouteOptions
): Promise<Response> {
  const match = matchHttpRoute(options.request.method, options.path);
  if (match === undefined) return routeNotFoundResponse();

  return dispatchFetchHandler({
    runtime: options.runtime,
    request: options.request,
    name: match.name,
    params: match.params
  });
}

export function dispatchNoWalletRoute(
  options: DispatchOpenReceiveFetchNoWalletRouteOptions
): Response {
  const match = matchHttpRoute(options.request.method, options.path);
  if (match === undefined) return routeNotFoundResponse();

  return createNoWalletResponse(match.name, options.noWallet);
}

export function matchHttpRoute(
  method: string,
  path: readonly string[]
): OpenReceiveFetchRouteMatch | undefined {
  const segments = normalizeOpenReceiveFetchRoutePath(path);
  const normalizedMethod = method.toUpperCase();

  if (segments.length === 1) {
    if (normalizedMethod === "GET" && segments[0] === "health") {
      return { name: "health" };
    }
    if (normalizedMethod === "GET" && segments[0] === "capabilities") {
      return { name: "capabilities" };
    }
    if (normalizedMethod === "GET" && segments[0] === "rates") {
      return { name: "listRates" };
    }
    if (normalizedMethod === "GET" && segments[0] === "routes") {
      return { name: "listRoutes" };
    }
    if (normalizedMethod === "GET" && segments[0] === "providers") {
      return { name: "listProviders" };
    }
    if (normalizedMethod === "POST" && segments[0] === "invoices") {
      return { name: "createInvoice" };
    }
  }

  if (segments.length === 2) {
    if (
      normalizedMethod === "POST" &&
      segments[0] === "rates" &&
      segments[1] === "quote"
    ) {
      return { name: "quoteRates" };
    }
    if (
      normalizedMethod === "POST" &&
      segments[0] === "invoices" &&
      segments[1] === "lookup"
    ) {
      return { name: "lookupInvoice" };
    }
    if (normalizedMethod === "GET" && segments[0] === "invoices") {
      return {
        name: "getInvoice",
        params: {
          invoice_id: segments[1]
        }
      };
    }
  }

  if (
    segments.length === 3 &&
    normalizedMethod === "POST" &&
    segments[0] === "invoices" &&
    segments[2] === "refresh"
  ) {
    return {
      name: "refreshInvoice",
      params: {
        invoice_id: segments[1]
      }
    };
  }

  return undefined;
}

export async function dispatchFetchHandler(
  options: DispatchOpenReceiveFetchHandlerOptions
): Promise<Response> {
  const handler = options.runtime.handlers[options.name] as ExpressLikeHandler;
  const req = await createOpenReceiveFetchRequest(
    options.request,
    options.params ?? {}
  );
  const res = new CapturedOpenReceiveFetchResponse();
  let nextError: unknown;

  await handler(req, res, (error?: unknown) => {
    nextError = error;
  });

  if (nextError !== undefined) throw nextError;
  return res.toResponse();
}

export function createNoWalletResponse(
  name: keyof OpenReceiveNodeHandlers,
  options: OpenReceiveFetchNoWalletOptions = {}
): Response {
  const basePath = options.basePath ?? DEFAULT_BASE_PATH;
  const message = options.message ?? DEFAULT_NO_WALLET_MESSAGE;

  if (name === "health") {
    return jsonResponse({
      ok: true,
      wallet_configured: false
    });
  }

  if (name === "capabilities") {
    return jsonResponse({
      base_path: basePath,
      wallet_configured: false,
      settlement: "poll_only",
      methods: ["make_invoice", "lookup_invoice"]
    });
  }

  return jsonResponse({
    code: "WALLET_UNAVAILABLE",
    message
  }, 503);
}

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: HeadersInit = {}
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Cache-Control", "no-store");
  responseHeaders.set("Content-Type", "application/json");
  responseHeaders.set("Referrer-Policy", "same-origin");

  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders
  });
}

export function routeNotFoundResponse(): Response {
  return jsonResponse({
    code: "NOT_FOUND",
    message: "OpenReceive route not found."
  }, 404);
}

export function fetchPath(
  request: Request,
  basePath = DEFAULT_BASE_PATH
): readonly string[] | undefined {
  const pathname = new URL(request.url).pathname;
  const normalizedBasePath = normalizeBasePath(basePath);
  if (pathname === normalizedBasePath) return [];
  if (!pathname.startsWith(`${normalizedBasePath}/`)) return undefined;

  return pathname
    .slice(normalizedBasePath.length + 1)
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment));
}

export function createNodeHandlers(
  options: OpenReceiveNodeOptionsInput
): OpenReceiveNodeHandlers {
  options = normalizeOpenReceiveNodeOptions(options);
  assertDurableStoreConfiguration(options);

  const store = options.store ?? new InMemoryInvoiceKvStore();
  const clock = options.clock ?? currentUnixSeconds;
  const basePath = normalizeBasePath(options.basePath);
  const priceProviders = options.priceProviders ?? [new StaticPriceProvider()];
  const priceCurrencies = options.priceCurrencies ?? ["USD"];
  const handle = (
    handler: (req: ExpressLikeRequest, res: ExpressLikeResponse) => Promise<unknown>,
    sweep = true
  ): ExpressLikeHandler => wrapHandler(options, async (req, res) => {
    const result = await handler(req, res);
    if (sweep) scheduleMaybeSweep(options, store, clock);
    return result;
  });

  return {
    createInvoice: handle(async (req, res) => {
      applyDefaultHeaders(req, res, options);

      const body = asRecord(req.body);
      const orderUuid = parseCreateOrderUuid(body);
      const idempotencyKey = orderUuid;

      const namespaceScope = options.namespace ?? readOpenReceiveNamespace(undefined);
      const operation = "invoice.create" as const;
      const idempotencyScope: OpenReceiveIdempotencyScope = {
        merchant_scope: namespaceScope,
        operation,
        idempotency_key: idempotencyKey
      };
      const requestHash = await createIdempotencyRequestHash(body);
      const existing = await getIdempotentRecord({
        store,
        scope: idempotencyScope,
        idempotency_request_hash: requestHash
      });

      if (existing !== undefined) {
        emitLog(options, "info", "invoice.create.replayed", "Replayed existing invoice for idempotent create request.", invoiceLogFields(existing.record.row));
        return res.status(200).json(serializeInvoice(existing.record.row, {
          basePath
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
        expiry: optionalSafeInteger(body.expiry)
      });
      const createdAt = invoice.created_at ?? clock();
      const requestedExpirySeconds = optionalSafeInteger(body.expiry) ?? 600;
      const expiresAt = invoice.expires_at ?? createdAt + requestedExpirySeconds;
      const normalizedExpiresAt = Math.min(expiresAt, createdAt + requestedExpirySeconds);

      const createResult = await putCreatedInvoiceRecord({
        store,
        createInvoiceId,
        record: {
          rev: 0,
          row: {
            invoice_id: createInvoiceId(),
            merchant_scope: namespaceScope,
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
            metadata: {
              order_uuid: orderUuid
            },
            fiat_quote: resolvedAmount.fiat_quote === null
              ? null
              : { ...resolvedAmount.fiat_quote }
          }
        }
      });
      emitLog(options, "info", "invoice.created", "Created Lightning invoice.", invoiceLogFields(createResult.record.row));

      return res.status(createResult.status === "created" ? 201 : 200).json(
        serializeInvoice(createResult.record.row, { basePath })
      );
    }),

    getInvoice: handle(async (req, res) => {
      applyDefaultHeaders(req, res, options);
      const record = await requireStoredRecord(store, req.params?.invoice_id);
      emitLog(options, "debug", "invoice.read", "Read invoice state.", invoiceLogFields(record.row));
      return res.status(200).json(serializeInvoice(record.row, { basePath }));
    }),

    lookupInvoice: handle(async (req, res) => {
      applyDefaultHeaders(req, res, options);
      const body = asRecord(req.body);
      const record = await findLookupRecord(store, body);
      emitLog(options, "info", "invoice.lookup.requested", "Refreshing invoice status through the gated wallet lookup path.", invoiceLogFields(record.row));

      const result = await gatedLookup({
        ...reconcileOptions(options, store, clock, req),
        record,
        source: "http_lookup"
      });
      emitLog(options, "debug", "invoice.lookup.result", "Invoice status refresh completed.", {
        ...invoiceLogFields(result.record.row),
        reason: result.reason,
        wallet_lookup_performed: result.lookup_invoice !== undefined
      });

      return res.status(200).json({
        ...serializeInvoice(result.record.row, { basePath }),
        preimage_present: result.lookup_invoice?.preimage !== undefined,
        wallet_lookup_performed: result.lookup_invoice !== undefined
      });
    }),

    refreshInvoice: handle(async (req, res) => {
      applyDefaultHeaders(req, res, options);
      const oldRecord = await requireStoredRecord(store, req.params?.invoice_id);
      const oldInvoice = oldRecord.row;
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
      const existing = await getIdempotentRecord({
        store,
        scope: idempotencyScope,
        idempotency_request_hash: requestHash
      });

      if (existing !== undefined) {
        emitLog(options, "info", "invoice.refresh.replayed", "Replayed existing refreshed invoice for idempotent request.", invoiceLogFields(existing.record.row));
        return res.status(200).json(serializeRefreshResult({
          oldInvoice,
          newInvoice: existing.record.row,
          reason,
          basePath
        }));
      }

      const invoice = await options.client.makeInvoice({
        amount_msats: BigInt(oldInvoice.amount_msats)
      });
      const createdAt = invoice.created_at ?? clock();
      const expiresAt = Math.min(invoice.expires_at ?? createdAt + 600, createdAt + 600);
      const createResult = await putCreatedInvoiceRecord({
        store,
        createInvoiceId,
        record: {
          rev: 0,
          row: {
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
          }
        }
      });
      emitLog(options, "info", "invoice.refresh.created", "Created linked replacement invoice.", {
        ...invoiceLogFields(createResult.record.row),
        old_invoice_id: oldInvoice.invoice_id
      });

      return res.status(createResult.status === "created" ? 201 : 200).json(serializeRefreshResult({
        oldInvoice,
        newInvoice: createResult.record.row,
        reason,
        basePath
      }));
    }),

    poll: handle(async (req, res) => {
      applyDefaultHeaders(req, res, options);
      const result = await reconcileOnce(reconcileOptions(options, store, clock));
      return res.status(200).json({
        invoice_ids: result.invoice_ids,
        checked: result.checked
      });
    }, false),

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
    }, false),

    capabilities: handle(async (req, res) => {
      applyDefaultHeaders(req, res, options);
      return res.status(200).json({
        base_path: basePath,
        settlement: "poll_only",
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
    }, false)
  };
}

function normalizeOpenReceiveNodeOptions(
  options: OpenReceiveNodeOptionsInput
): OpenReceiveNodeOptions {
  return options;
}

function reconcileOptions(
  options: OpenReceiveNodeOptions,
  store: OpenReceiveInvoiceKvStore,
  clock: () => number,
  req?: ExpressLikeRequest
) {
  return {
    store,
    client: options.client,
    clock,
    lookupBurst: options.lookupBurst ?? readPositiveIntegerEnv("OPENRECEIVE_LOOKUP_BURST"),
    lookupRatePerSecond: options.lookupRatePerSecond ?? readPositiveNumberEnv("OPENRECEIVE_LOOKUP_RATE_PER_SEC"),
    actionLeaseTtlSeconds: options.actionLeaseTtlSeconds ?? readPositiveIntegerEnv("OPENRECEIVE_ACTION_LEASE_TTL_SEC"),
    sweepIntervalSeconds: options.sweepIntervalSeconds ?? readPositiveIntegerEnv("OPENRECEIVE_SWEEP_INTERVAL_SEC"),
    sweepBatch: options.sweepBatch ?? readPositiveIntegerEnv("OPENRECEIVE_SWEEP_BATCH"),
    settlementAction: async (input: {
      invoice: InvoiceStorageRow;
      metadata: Record<string, unknown>;
      source: "http_lookup" | "poll";
      lookup_invoice?: unknown;
    }) => {
      // Delivered after backend-verified settlement, at least once. Apps must
      // dedupe fulfillment by invoice.payment_hash or their own order id.
      await options.onPaid?.({
        req: input.source === "http_lookup" ? req : undefined,
        invoice: input.invoice,
        orderUuid: input.invoice.idempotency_key,
        metadata: input.metadata,
        source: input.source,
        lookup_invoice: input.lookup_invoice
      });
    },
    onEvent: (event: OpenReceiveReconcileEvent) => {
      emitLog(
        options,
        event.event === "invoice.failed" ? "warn" : "info",
        event.event,
        "OpenReceive reconciled invoice state.",
        {
          ...invoiceLogFields(event.invoice),
          ...(event.reason === undefined ? {} : { reason: event.reason })
        }
      );
    }
  };
}

function readPositiveIntegerEnv(name: string): number | undefined {
  const value = globalThis.process?.env?.[name];
  if (value === undefined || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return parsed;
}

function readPositiveNumberEnv(name: string): number | undefined {
  const value = globalThis.process?.env?.[name];
  if (value === undefined || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new RangeError(`${name} must be a positive number`);
  }
  return parsed;
}

function scheduleMaybeSweep(
  options: OpenReceiveNodeOptions,
  store: OpenReceiveInvoiceKvStore,
  clock: () => number
): void {
  if (options.backgroundSweep === false) return;
  const run = async () => {
    await maybeSweep(reconcileOptions(options, store, clock));
  };

  void run().catch((error) => {
    emitLog(options, "warn", "sweep.failed", "OpenReceive background sweep failed.", {
      error: error instanceof Error ? error.message : String(error)
    });
  });
}

function getProviderFilter(req: ExpressLikeRequest): ProviderFilter {
  const filter: ProviderFilter = {};
  const us = getQueryString(req, "us");

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
}): Record<string, unknown> {
  return {
    old_invoice_id: input.oldInvoice.invoice_id,
    new_invoice_id: input.newInvoice.invoice_id,
    reason: input.reason,
    invoice: serializeInvoice(input.newInvoice, {
      basePath: input.basePath
    })
  };
}

interface SerializeInvoiceContext {
  basePath: string;
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
    order_uuid: row.idempotency_key,
    created_at: row.created_at,
    expires_at: row.expires_at,
    ...(row.settled_at === undefined ? {} : { settled_at: row.settled_at }),
    ...(row.settlement_action_completed_at === undefined ? {} : { settlement_action_completed_at: row.settlement_action_completed_at }),
    ...(row.refreshed_from_invoice_id === undefined
      ? {}
      : { refreshed_from_invoice_id: row.refreshed_from_invoice_id }),
    fiat_quote: row.fiat_quote ?? null,
    checkout: {
      routes_url: `${context.basePath}/routes?invoice_id=${row.invoice_id}`
    },
    settlement_action_state: row.settlement_action_state
  };
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
  options: OpenReceiveNodeOptions,
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
    .replace(/([?&](?:token|secret)=)[^&\s"'`<>]+/gi, "$1[REDACTED]");
}

interface ResolvedCreateAmount {
  amount_msats: number;
  amount_source: "amount_sats" | "amount_msats" | "fiat";
  fiat_quote: OpenReceiveRateQuote | null;
}

async function resolveCreateAmount(input: {
  body: Record<string, unknown>;
  now: number;
  priceProviders: readonly OpenReceiveSourcedPriceProvider[];
}): Promise<ResolvedCreateAmount> {
  const { body } = input;
  const hasAmountSats = body.amount_sats !== undefined;
  const hasAmountMsats = body.amount_msats !== undefined;
  const hasFiat = body.fiat !== undefined;
  const sourceCount = [hasAmountSats, hasAmountMsats, hasFiat]
    .filter(Boolean)
    .length;

  if (sourceCount !== 1) {
    throw httpError(
      400,
      "INVALID_REQUEST",
      "Create invoice request requires exactly one of amount_sats, amount_msats, or fiat."
    );
  }

  if (hasAmountSats) {
    const amountSats = optionalSafeInteger(body.amount_sats);
    if (amountSats === undefined) {
      throw httpError(400, "INVALID_REQUEST", "amount_sats must be a safe integer.");
    }
    const amountMsats = amountSats * 1000;
    if (!Number.isSafeInteger(amountMsats)) {
      throw httpError(400, "INVALID_REQUEST", "amount_sats is outside the safe integer boundary.");
    }
    return {
      amount_msats: amountMsats,
      amount_source: "amount_sats",
      fiat_quote: null
    };
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
    if (isHttpError(error)) throw error;
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
  const optionalInvoiceDescription = optionalString(body.optional_invoice_description);
  const description = optionalString(body.description);
  const descriptionHash = optionalString(body.description_hash);

  if (optionalInvoiceDescription !== undefined && description !== undefined) {
    throw httpError(
      400,
      "INVALID_REQUEST",
      "Create invoice request accepts only one of optional_invoice_description or description."
    );
  }

  const resolvedDescription = optionalInvoiceDescription ?? description;
  if (resolvedDescription !== undefined && resolvedDescription.length > 500) {
    throw httpError(
      400,
      "INVALID_REQUEST",
      "optional_invoice_description must be 500 characters or fewer."
    );
  }

  if (resolvedDescription !== undefined && descriptionHash !== undefined) {
    throw httpError(
      400,
      "INVALID_REQUEST",
      "Create invoice request accepts only one of optional_invoice_description or description_hash."
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
    ...(resolvedDescription === undefined ? {} : { description: resolvedDescription }),
    ...(descriptionHash === undefined ? {} : { description_hash: descriptionHash })
  };
}

function parseCreateOrderUuid(body: Record<string, unknown>): string {
  const orderUuid = optionalString(body.order_uuid);
  if (orderUuid === undefined) {
    throw httpError(400, "INVALID_REQUEST", "order_uuid is required.");
  }
  if (orderUuid.length > 200) {
    throw httpError(400, "INVALID_REQUEST", "order_uuid must be 200 characters or fewer.");
  }
  return orderUuid;
}

function isRefreshableInvoice(invoice: InvoiceStorageRow): boolean {
  return (
    invoice.transaction_state === "expired" ||
    invoice.transaction_state === "failed" ||
    invoice.workflow_state === "expired_closed" ||
    invoice.workflow_state === "failed_closed"
  );
}

async function findLookupRecord(
  store: OpenReceiveInvoiceKvStore,
  body: Record<string, unknown>
): Promise<StoredRecord> {
  const paymentHash = optionalString(body.payment_hash);
  const bolt11Invoice = optionalString(body.invoice);

  if ((paymentHash === undefined) === (bolt11Invoice === undefined)) {
    throw httpError(
      400,
      "INVALID_REQUEST",
      "lookup requires exactly one of payment_hash or invoice."
    );
  }

  const record =
    paymentHash === undefined
      ? await store.getByBolt11Invoice(requiredValue(bolt11Invoice))
      : await store.getByPaymentHash(paymentHash);

  if (record === undefined) {
    throw new InvoiceNotFoundError(paymentHash ?? requiredValue(bolt11Invoice));
  }

  return record;
}

async function requireStoredRecord(
  store: OpenReceiveInvoiceKvStore,
  invoiceId: string | undefined
): Promise<StoredRecord> {
  if (invoiceId === undefined || invoiceId.length === 0) {
    throw httpError(400, "INVALID_REQUEST", "invoice_id route parameter is required.");
  }

  const record = await store.get(invoiceId);
  if (record === undefined) throw new InvoiceNotFoundError(invoiceId);
  return record;
}

function assertDurableStoreConfiguration(
  options: OpenReceiveNodeOptions
): void {
  const env = globalThis.process?.env ?? {};
  const mode = (env.OPENRECEIVE_MODE ?? env.NODE_ENV ?? "").toLowerCase();
  if (mode !== "production") return;

  if (options.store !== undefined && !(options.store instanceof InMemoryInvoiceKvStore)) {
    return;
  }

  throw new Error(
    "OpenReceive refuses to use InMemoryInvoiceKvStore when " +
      "OPENRECEIVE_MODE or NODE_ENV is production. Configure a durable " +
      "OpenReceive store such as Postgres, SQLite, or local-sqlite."
  );
}

async function resolveOpenReceiveNodeRuntime(
  runtime: OpenReceiveRouteSource
): Promise<OpenReceiveNodeRuntime | undefined> {
  const resolved = typeof runtime === "function" ? await runtime() : runtime;
  if (resolved === undefined) return undefined;
  if (isOpenReceiveServer(resolved)) return resolved.runtime;
  return resolved;
}

async function createOpenReceiveRequestFromNode(
  req: IncomingMessage,
  options: CreateOpenReceiveNodeHandlerOptions
): Promise<Request> {
  const method = req.method ?? "GET";
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }

  const origin = options.origin ?? `http://${headers.get("host") ?? "localhost"}`;
  const url = new URL(req.url ?? "/", origin);
  const hasBody = method !== "GET" && method !== "HEAD";

  return new Request(url, {
    method,
    headers,
    body: hasBody ? await readNodeRequestBody(req) : undefined,
    duplex: hasBody ? "half" : undefined
  } as RequestInit & { duplex?: "half" });
}

async function readNodeRequestBody(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

async function writeOpenReceiveNodeResponse(
  res: ServerResponse,
  response: Response
): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  if (response.body === null) {
    res.end();
    return;
  }

  const reader = response.body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      res.write(Buffer.from(next.value));
    }
  } finally {
    res.end();
  }
}

async function createOpenReceiveFetchRequest(
  request: Request,
  params: Record<string, string | undefined>
): Promise<ExpressLikeRequest> {
  const url = new URL(request.url);
  const query: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of url.searchParams.entries()) {
    const existing = query[key];
    if (existing === undefined) {
      query[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      query[key] = [existing, value];
    }
  }

  return {
    method: request.method,
    path: url.pathname,
    params,
    query,
    headers: Object.fromEntries(request.headers.entries()),
    body: await readFetchRequestBody(request),
    get(header) {
      return request.headers.get(header) ?? undefined;
    }
  };
}

async function readFetchRequestBody(request: Request): Promise<unknown> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const text = await request.text();
    return text.length === 0 ? undefined : JSON.parse(text);
  }
  return await request.text();
}

class CapturedOpenReceiveFetchResponse implements ExpressLikeResponse {
  statusCode = 200;
  headers = new Headers();
  body: unknown;
  writes: string[] = [];

  status(code: number): ExpressLikeResponse {
    this.statusCode = code;
    return this;
  }

  set(field: string, value: string): ExpressLikeResponse {
    this.headers.set(field, value);
    return this;
  }

  json(body: unknown): unknown {
    this.body = body;
    this.headers.set("Content-Type", "application/json");
    return body;
  }

  write(chunk: string): unknown {
    this.writes.push(chunk);
    return undefined;
  }

  end(): unknown {
    return undefined;
  }

  flushHeaders(): unknown {
    return undefined;
  }

  toResponse(): Response {
    if (this.writes.length > 0) {
      return new Response(this.writes.join(""), {
        status: this.statusCode,
        headers: this.headers
      });
    }

    return jsonResponse(
      this.body ?? null,
      this.statusCode,
      this.headers
    );
  }
}

function wrapHandler(
  options: OpenReceiveNodeOptions,
  handler: (req: ExpressLikeRequest, res: ExpressLikeResponse) => Promise<unknown>
): ExpressLikeHandler {
  return (req, res, next) => {
    return Promise.resolve()
      .then(() => handler(req, res))
      .catch((error) => {
        if (isHttpError(error)) {
          applyDefaultHeaders(req, res, options);
          res.status(error.status).json({
            code: error.code,
            message: error.message
          });
          return;
        }

        emitLog(options, "error", "handler.error", "OpenReceive route handler failed.", {
          error_message: error instanceof Error ? error.message : String(error)
        });
        next(error);
      });
  };
}

function applyDefaultHeaders(
  req: ExpressLikeRequest,
  res: ExpressLikeResponse,
  options: OpenReceiveNodeOptions
): void {
  res.set("Cache-Control", "no-store");
  res.set("Referrer-Policy", "same-origin");
}

function normalizeBasePath(basePath = DEFAULT_BASE_PATH): string {
  if (!basePath.startsWith("/")) return `/${basePath}`;
  return basePath.replace(/\/+$/, "") || "/";
}

function normalizeOpenReceiveFetchRoutePath(
  path: readonly string[]
): readonly string[] {
  return path.filter((segment) => segment.length > 0);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw httpError(400, "INVALID_REQUEST", "JSON request body must be an object.");
  }
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getHeader(
  req: ExpressLikeRequest,
  header: string
): string | undefined {
  const viaGetter = req.get?.(header);
  if (viaGetter !== undefined) return viaGetter;
  const lower = header.toLowerCase();
  const value =
    req.headers?.[lower] ??
    req.headers?.[header] ??
    req.headers?.[header.toUpperCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

function getQueryString(
  req: ExpressLikeRequest,
  name: string
): string | undefined {
  const value = req.query?.[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalSafeInteger(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(numberValue) ? numberValue : undefined;
}

function parseOptionalRecord(
  value: unknown,
  field: string
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw httpError(400, "INVALID_REQUEST", `${field} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function parseFiatAmount(value: unknown): OpenReceiveFiatAmount {
  const record = parseOptionalRecord(value, "fiat");
  if (record === undefined) {
    throw httpError(400, "INVALID_REQUEST", "fiat must be a JSON object.");
  }
  const currency = optionalString(record.currency);
  const amountValue = optionalString(record.value);
  if (currency === undefined || !/^[A-Z]{3}$/.test(currency)) {
    throw httpError(400, "INVALID_REQUEST", "fiat.currency must be an ISO 4217 uppercase code");
  }
  if (amountValue === undefined) {
    throw httpError(400, "INVALID_REQUEST", "fiat.value must be a decimal string");
  }
  return {
    currency,
    value: amountValue
  };
}

function parseUsFilter(value: string): boolean | null | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (value === "unknown") return undefined;
  throw httpError(400, "INVALID_REQUEST", "us filter must be true, false, unknown, or null.");
}

function requiredValue<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("required value was missing");
  }
  return value;
}

function toSafeInteger(value: bigint | number, field: string): number {
  const numberValue = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(numberValue)) {
    throw httpError(500, "INTERNAL", `${field} is outside JavaScript safe integer bounds.`);
  }
  return numberValue;
}

function createInvoiceId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `or_inv_${[...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function currentUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
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
  error.name = "HttpError";
  error.status = status;
  error.code = code;
  return error;
}

function isHttpError(error: unknown): error is HttpError {
  return (
    error instanceof Error &&
    "status" in error &&
    "code" in error &&
    typeof (error as { status?: unknown }).status === "number"
  );
}
