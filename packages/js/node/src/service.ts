import {
  OPENRECEIVE_PRICE_FEED_FALLBACK_URL_ENV,
  OPENRECEIVE_PRICE_FEED_PRIMARY_URL_ENV,
  createCachedLivePriceFeed,
  createIdempotencyRequestHash,
  getBtcFiatRatesWithFallback,
  getIdempotentRecord,
  isOpenReceiveErrorCode,
  isResolvedPriceProvider,
  putCreatedInvoiceRecord,
  quoteBitcoinAmountToMsats,
  quoteFiatToMsatsWithPrice,
  sweepPendingInvoicesOnce,
  type CachedPriceFeed,
  type InvoiceStorageRow,
  type NwcTransaction,
  type OpenReceiveBitcoinAmount,
  type OpenReceiveBtcFiatRateMapWithSource,
  type OpenReceiveErrorBody,
  type OpenReceiveErrorCode,
  type OpenReceiveFiatAmount,
  type OpenReceiveIdempotencyScope,
  type OpenReceiveInvoiceKvStore,
  type OpenReceivePriceFeedCacheStore,
  type OpenReceiveRateQuote,
  type SimplePriceFetch,
  type OpenReceiveReceiveNwcClient,
  type OpenReceiveReconcileEvent,
  type OpenReceiveSettlementActionInput,
  type OpenReceivePendingSweepResult,
  type OpenReceiveSourcedPriceProvider,
  type StoredRecord,
} from "@openreceive/core";
import {
  NwcUriParseError,
  formatOpenReceiveInvalidNwcMessage,
  formatOpenReceiveMissingNwcMessage,
} from "@openreceive/core";
import { createNwcReceiveClient, type NwcEndpointLogger } from "./alby-nwc.ts";
import { OpenReceiveConfigError } from "./config-error.ts";
import { assertOpenReceiveStoreConfiguration } from "./storage-guard.ts";
import { resolveOpenReceiveStore, type ResolveOpenReceiveStoreOptions } from "./store-uri.ts";
import {
  formatOpenReceiveSwapAssetLabel,
  getOpenReceiveSwapAssetInfo,
  isOpenReceiveSwapPayInAsset,
  isOpenReceiveSwapTerminalState,
  listOpenReceiveSwapAssetInfo,
  type OpenReceiveSwapOrder,
  type OpenReceiveSwapPayInAsset,
  type OpenReceiveSwapProvider,
  type OpenReceiveSwapProviderState,
} from "./swap/index.ts";

export type { OpenReceivePendingSweepResult };
export { OpenReceiveConfigError } from "./config-error.ts";
export type { OpenReceiveConfigErrorCode } from "./config-error.ts";

export type OpenReceiveLogLevel = "debug" | "info" | "warn" | "error";

export interface OpenReceiveEvent {
  readonly level: OpenReceiveLogLevel;
  readonly event: string;
  readonly message: string;
  readonly [key: string]: unknown;
}

export type OpenReceiveEventHandler = (event: OpenReceiveEvent) => void;

export interface OpenReceiveLogEntry extends OpenReceiveEvent {}

export type OpenReceiveLogger = (entry: OpenReceiveLogEntry) => void;

export interface OpenReceiveNodeSettlementActionInput {
  invoice: InvoiceStorageRow;
  orderId: string;
  checkoutId: string;
  invoiceId: string;
  paymentHash: string;
  amountMsats: number;
  metadata: Record<string, unknown>;
  source: "status";
  transaction?: NwcTransaction;
}

export type OpenReceiveNodeSettlementActionHook = (
  input: OpenReceiveNodeSettlementActionInput,
) => Promise<void> | void;

export interface OpenReceiveNodeOptions {
  client: OpenReceiveReceiveNwcClient;
  store?: OpenReceiveInvoiceKvStore;
  namespace?: string;
  onPaid?: OpenReceiveNodeSettlementActionHook;
  priceProviders?: readonly OpenReceiveSourcedPriceProvider[];
  priceCurrencies?: readonly string[];
  swap?: OpenReceiveSwapOptions;
  onEvent?: OpenReceiveEventHandler;
  logger?: OpenReceiveLogger;
  clock?: () => number;
  actionLeaseTtlSeconds?: number;
  transactionScanIntervalSeconds?: number;
  transactionScanPageLimit?: number;
  transactionScanWindowPaddingSeconds?: number;
  transactionScanOverlapSeconds?: number;
  sweepOpenInvoiceCap?: number;
  transactionScanTimeoutMs?: number;
  waitUntil?: (promise: Promise<unknown>) => void;
}

export interface CreateOpenReceiveOptions
  extends Omit<OpenReceiveNodeOptions, "client" | "onPaid" | "store"> {
  client?: OpenReceiveReceiveNwcClient;
  nwc?: string;
  store?: OpenReceiveInvoiceKvStore;
  storeUri?: string;
  namespace?: string;
  cwd?: string;
  onPaid?: OpenReceiveNodeSettlementActionHook;
  loadSqlite?: ResolveOpenReceiveStoreOptions["loadSqlite"];
  loadPostgres?: ResolveOpenReceiveStoreOptions["loadPostgres"];
  priceFetch?: SimplePriceFetch;
}

export type OpenReceiveCreateCheckoutRequest = OpenReceiveCreateCheckoutBase &
  (
    | {
        readonly amount: OpenReceiveCreateCheckoutAmount;
        readonly sats?: never;
        readonly usd?: never;
      }
    | {
        readonly amount?: never;
        readonly sats: number | string;
        readonly usd?: never;
      }
    | {
        readonly amount?: never;
        readonly sats?: never;
        readonly usd: string;
      }
  );

export interface OpenReceiveCreateCheckoutBase {
  readonly orderId: string;
  readonly memo?: string;
  readonly descriptionHash?: string;
  readonly metadata?: Record<string, unknown>;
}

export type OpenReceiveGetOrCreateCheckoutRequest = OpenReceiveCreateCheckoutRequest;

export type OpenReceiveCreateCheckoutAmount =
  | { readonly btc: OpenReceiveBitcoinAmount }
  | { readonly fiat: OpenReceiveFiatAmount };

export interface OpenReceiveGetOrderRequest {
  readonly orderId: string;
}

export interface OpenReceiveGetCheckoutRequest {
  readonly checkoutId: string;
}

export interface OpenReceiveSwapOptions {
  readonly providers?: readonly OpenReceiveSwapProvider[];
}

export interface OpenReceiveSwapOptionsRequest {
  readonly orderId: string;
}

export interface OpenReceiveSwapStartRequest {
  readonly orderId: string;
  readonly payInAsset: OpenReceiveSwapPayInAsset | string;
}

export interface OpenReceiveSwapRefundRequest {
  readonly orderId: string;
  readonly payInAsset: OpenReceiveSwapPayInAsset | string;
  readonly refundAddress: string;
}

export interface OpenReceiveSwapOption {
  readonly pay_in_asset: OpenReceiveSwapPayInAsset;
  readonly label: string;
  readonly network_label: string;
  readonly provider: string;
  readonly min_ok: boolean;
  readonly max_ok: boolean;
  readonly pay_amount?: string;
}

export interface OpenReceiveSwapOptionsResponse {
  readonly enabled: boolean;
  readonly options: readonly OpenReceiveSwapOption[];
}

export interface OpenReceivePublicSwap {
  readonly provider: string;
  readonly pay_in_asset: OpenReceiveSwapPayInAsset;
  readonly deposit_address: string;
  readonly deposit_memo?: string;
  readonly deposit_amount: string;
  readonly provider_state: OpenReceiveSwapProviderState;
  readonly provider_expires_at: number;
  readonly deposit_tx_id?: string;
  readonly refund_address?: string;
  readonly refund_tx_id?: string;
  readonly attention?: boolean;
}

export interface OpenReceiveInvoice {
  readonly invoice_id: string;
  readonly type: "incoming";
  readonly rail: "lightning" | "swap";
  readonly status: "pending" | "settled" | "expired" | "failed";
  readonly transaction_state: string;
  readonly workflow_state: string;
  readonly invoice: string;
  readonly payment_hash: string;
  readonly amount_msats: number;
  readonly order_id: string;
  readonly created_at: number;
  readonly expires_at: number;
  readonly settled_at?: number;
  readonly settlement_action_completed_at?: number;
  readonly refreshed_from_invoice_id?: string;
  readonly fiat_quote: OpenReceiveRateQuote | null;
  readonly settlement_action_state: string;
  readonly swap?: OpenReceivePublicSwap;
}

export interface OpenReceiveCheckout {
  readonly checkout_id: string;
  readonly order_id: string;
  readonly status: "open" | "superseded" | "paid" | "expired";
  readonly amount_msats: number;
  readonly fiat?: {
    readonly currency: string;
    readonly value: string;
  };
  readonly active?: OpenReceiveInvoice;
  readonly invoices: readonly OpenReceiveInvoice[];
  readonly paid_at?: number;
  readonly created_at: number;
}

export interface OpenReceiveOrder {
  readonly order_id: string;
  readonly status: "pending" | "paid" | "expired";
  readonly paid: boolean;
  readonly paid_at?: number;
  readonly display_checkout?: OpenReceiveCheckout;
  readonly paid_checkout?: OpenReceiveCheckout;
  readonly active_checkout?: OpenReceiveCheckout;
  readonly checkouts: readonly OpenReceiveCheckout[];
  readonly wallet_scan_performed: boolean;
  readonly transactions_checked: number;
}

export interface OpenReceive {
  readonly store: OpenReceiveInvoiceKvStore;
  readonly namespace: string;
  readonly priceCurrencies: readonly string[];
  createCheckout(input: OpenReceiveCreateCheckoutRequest): Promise<OpenReceiveCheckout>;
  getOrCreateCheckout(input: OpenReceiveGetOrCreateCheckoutRequest): Promise<OpenReceiveCheckout>;
  getOrder(input: OpenReceiveGetOrderRequest): Promise<OpenReceiveOrder>;
  getCheckout(input: OpenReceiveGetCheckoutRequest): Promise<OpenReceiveCheckout>;
  sweepPendingInvoices(): Promise<OpenReceivePendingSweepResult>;
  swapOptions(input: OpenReceiveSwapOptionsRequest): Promise<OpenReceiveSwapOptionsResponse>;
  startSwap(input: OpenReceiveSwapStartRequest): Promise<OpenReceiveInvoice>;
  refundSwap(input: OpenReceiveSwapRefundRequest): Promise<OpenReceiveInvoice>;
  listRates(
    input?: OpenReceiveListRatesRequest,
  ): Promise<OpenReceiveBtcFiatRateMapWithSource["rates"]>;
  quoteRates(input: { readonly fiat: OpenReceiveFiatAmount }): Promise<OpenReceiveRateQuote>;
  close(): Promise<void>;
}

export interface OpenReceiveListRatesRequest {
  readonly currencies?: readonly string[];
}

interface OpenReceiveInvoiceModel {
  readonly invoiceId: string;
  readonly type: "incoming";
  readonly status: OpenReceiveInvoice["status"];
  readonly transactionState: string;
  readonly workflowState: string;
  readonly bolt11: string;
  readonly paymentHash: string;
  readonly amountMsats: number;
  readonly orderId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly settledAt?: number;
  readonly settlementActionCompletedAt?: number;
  readonly refreshedFromInvoiceId?: string;
  readonly fiatQuote: OpenReceiveRateQuote | null;
  readonly settlementActionState: string;
  readonly rail: "lightning" | "swap";
  readonly swap?: OpenReceivePublicSwap;
}

interface OpenReceiveCheckoutModel {
  readonly checkoutId: string;
  readonly orderId: string;
  readonly status: OpenReceiveCheckout["status"];
  readonly amountMsats: number;
  readonly fiat?: {
    readonly currency: string;
    readonly value: string;
  };
  readonly active?: OpenReceiveInvoiceModel;
  readonly invoices: readonly OpenReceiveInvoiceModel[];
  readonly paidAt?: number;
  readonly createdAt: number;
}

interface OpenReceiveOrderModel {
  readonly orderId: string;
  readonly status: OpenReceiveOrder["status"];
  readonly paid: boolean;
  readonly paidAt?: number;
  readonly displayCheckout?: OpenReceiveCheckoutModel;
  readonly paidCheckout?: OpenReceiveCheckoutModel;
  readonly activeCheckout?: OpenReceiveCheckoutModel;
  readonly checkouts: readonly OpenReceiveCheckoutModel[];
  readonly walletScanPerformed: boolean;
  readonly transactionsChecked: number;
}

interface OrderScanMeta {
  readonly walletScanPerformed: boolean;
  readonly transactionsChecked: number;
}

export class OpenReceiveServiceError extends Error {
  readonly status: number;
  readonly code: OpenReceiveErrorCode;
  readonly body: OpenReceiveErrorBody;

  constructor(status: number, body: OpenReceiveErrorBody) {
    super(body.message);
    this.name = "OpenReceiveServiceError";
    this.status = status;
    this.code = body.code;
    this.body = body;
  }
}

interface OpenReceiveServiceContext {
  readonly options: OpenReceiveNodeOptions;
  readonly store: OpenReceiveInvoiceKvStore;
  readonly clock: () => number;
  readonly priceProviders: readonly OpenReceiveSourcedPriceProvider[];
  readonly priceCurrencies: readonly string[];
  readonly swapProviders: readonly OpenReceiveSwapProvider[];
}

interface ResolvedCreateAmount {
  amount_msats: number;
  amount_source: "amount" | "fiat";
  fiat_quote: OpenReceiveRateQuote | null;
}

interface NormalizedCreateCheckoutRequest {
  readonly order_id: string;
  readonly amount: OpenReceiveCreateCheckoutAmount;
  readonly memo?: string;
  readonly description_hash?: string;
  readonly metadata?: Record<string, unknown>;
}

const HEX_64 = /^[0-9a-fA-F]{64}$/;
const OPENRECEIVE_INVOICE_EXPIRY_SECONDS = 600;
const RESERVED_CHECKOUT_METADATA_KEYS = new Set([
  "order_id",
  "checkout_id",
  "superseded",
  "amount_spec",
  "memo",
  "description_hash",
  "rail",
  "swap",
  "swap_attempt_key",
]);

export async function createOpenReceive(
  options: CreateOpenReceiveOptions = {},
): Promise<OpenReceive> {
  const namespace = readOpenReceiveNamespace(options.namespace);
  assertDurableStoreConfiguration({
    configuredStoreUri: options.storeUri,
    store: options.store,
  });
  const client = createConfiguredClient(options);
  await preflightConfiguredClient(client);

  const store = await resolveConfiguredStore(options, namespace);

  const nodeOptions: OpenReceiveNodeOptions = {
    ...options,
    client,
    store,
    namespace,
    onPaid: options.onPaid,
  };
  const priceCurrencies = readOpenReceivePriceCurrencies(options.priceCurrencies);
  const priceProviders = options.priceProviders ?? [
    createOpenReceivePriceFeed({
      store,
      currencies: priceCurrencies,
      fetch: options.priceFetch,
      clock: options.clock,
    }),
  ];
  const swapProviders = options.swap?.providers ?? [];

  const context: OpenReceiveServiceContext = {
    options: nodeOptions,
    store,
    clock: options.clock ?? currentUnixSeconds,
    priceProviders,
    priceCurrencies,
    swapProviders,
  };

  const getOrCreateCheckout = async (
    input: OpenReceiveGetOrCreateCheckoutRequest,
  ): Promise<OpenReceiveCheckout> =>
    await runOpenReceiveOperation(context, async () =>
      toWireCheckout(await createCheckout(context, input)),
    );

  return {
    store,
    namespace,
    priceCurrencies,
    createCheckout: getOrCreateCheckout,
    getOrCreateCheckout,
    async getOrder(input) {
      return await runOpenReceiveOperation(context, async () =>
        toWireOrder(await getOrder(context, input)),
      );
    },
    async getCheckout(input) {
      return await runOpenReceiveOperation(context, async () =>
        toWireCheckout(await getCheckout(context, input)),
      );
    },
    async sweepPendingInvoices() {
      return await runOpenReceiveOperation(
        context,
        async () => await sweepPendingInvoicesOnce(reconcileOptions(context)),
      );
    },
    async swapOptions(input) {
      return await runOpenReceiveOperation(context, () => getSwapOptions(context, input));
    },
    async startSwap(input) {
      return await runOpenReceiveOperation(context, async () =>
        toWireInvoice(await startSwap(context, input)),
      );
    },
    async refundSwap(input) {
      return await runOpenReceiveOperation(context, async () =>
        toWireInvoice(await refundSwap(context, input)),
      );
    },
    async listRates(input) {
      return await runOpenReceiveOperation(context, () => listRates(context, input));
    },
    async quoteRates(input) {
      return await runOpenReceiveOperation(context, () => quoteRates(context, input));
    },
    async close() {
      await closeOpenReceiveResource(store);
      await closeOpenReceiveResource(client);
    },
  };
}

async function createCheckout(
  context: OpenReceiveServiceContext,
  input: OpenReceiveCreateCheckoutRequest,
): Promise<OpenReceiveCheckoutModel> {
  const createInput = normalizeCreateCheckoutRequest(input);
  const orderId = createInput.order_id;
  readCreateAmountKind(createInput.amount);
  const now = context.clock();
  const records = await context.store.listByOrderId(orderId);
  const checkouts = groupCheckouts(records, now);
  const paidCheckout = checkouts.find((checkout) => checkout.status === "paid");

  if (paidCheckout !== undefined) {
    return paidCheckout;
  }

  const open = currentOpenCheckout(checkouts);
  if (open !== undefined && (await amountMatches(context, createInput.amount, open, now))) {
    return open;
  }

  const supersededId = open?.checkoutId ?? retryBaseCheckout(checkouts)?.checkoutId;
  if (open !== undefined) {
    await supersedeCheckout(context, open);
  }

  const checkoutId = createCheckoutId();
  const minted = await mintInvoiceForCheckout(context, {
    newCheckout: {
      orderId,
      checkoutId,
      input: createInput,
      supersededId,
    },
    now,
  });

  // User A creates an invoice, closes the browser, then pays. A's own frontend
  // is gone, so nothing polls A's order. Later, User B takes any action: B
  // creates a checkout, or B polls B's own order status. B's request calls the
  // global sweep, which scans from the oldest open invoice up to the shared
  // cursor. A's now-settled transaction is in that window; the existing
  // payment-hash match settles A's stored record and fires onPaid for A. A
  // never had to be online, and the single cursor keeps reaching back until
  // A's invoice settles or expires out of listOpen.
  scheduleBestEffortSweep(context);

  return requireCheckout(
    groupCheckouts(await context.store.listByOrderId(orderId), now),
    readStoredCheckoutId(minted.row),
  );
}

async function getOrder(
  context: OpenReceiveServiceContext,
  input: OpenReceiveGetOrderRequest,
): Promise<OpenReceiveOrderModel> {
  const orderId = parseGetOrderId(input);
  const records = await context.store.listByOrderId(orderId);
  if (records.length === 0) {
    throw serviceError(404, "NOT_FOUND", "No order found for the given order_id.");
  }
  emitLog(
    context.options,
    "info",
    "order.status.requested",
    "Refreshing order status through the transaction scan path.",
    {
      order_id: orderId,
      invoice_count: records.length,
    },
  );

  const result = await sweepPendingInvoicesOnce(reconcileOptions(context));
  await advanceSwapsForOrder(context, orderId);
  const fresh = await context.store.listByOrderId(orderId);
  emitLog(context.options, "debug", "order.status.result", "Order status refresh completed.", {
    order_id: orderId,
    invoice_count: fresh.length,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    wallet_scan_performed: result.swept,
    transactions_checked: result.page_count ?? 0,
  });

  return buildOrder(
    fresh,
    {
      walletScanPerformed: result.swept,
      transactionsChecked: result.page_count ?? 0,
    },
    context.clock(),
  );
}

async function getCheckout(
  context: OpenReceiveServiceContext,
  input: OpenReceiveGetCheckoutRequest,
): Promise<OpenReceiveCheckoutModel> {
  const checkoutId = parseGetCheckoutId(input);
  const records = await context.store.listByCheckoutId(checkoutId);
  if (records.length === 0) {
    throw serviceError(404, "NOT_FOUND", "No checkout found for the given checkout_id.");
  }
  await sweepPendingInvoicesOnce(reconcileOptions(context));
  await advanceSwapsForRecords(context, await context.store.listByCheckoutId(checkoutId));
  const fresh = await context.store.listByCheckoutId(checkoutId);
  return requireCheckout(groupCheckouts(fresh, context.clock()), checkoutId);
}

async function mintInvoiceForCheckout(
  context: OpenReceiveServiceContext,
  input: {
    readonly newCheckout: {
      readonly orderId: string;
      readonly checkoutId: string;
      readonly input: NormalizedCreateCheckoutRequest;
      readonly supersededId?: string;
    };
    readonly now: number;
  },
): Promise<StoredRecord> {
  const createInput = input.newCheckout.input;
  const orderId = input.newCheckout.orderId;
  const checkoutId = input.newCheckout.checkoutId;
  const requestHashBody = createCheckoutRequestHashBody(createInput);
  const operation = "invoice.create";
  const idempotencyKey = `${orderId}:super:${input.newCheckout.supersededId ?? "none"}:amt:${amountKeyFromCreateAmount(createInput.amount)}`;
  const namespaceScope = context.options.namespace ?? readOpenReceiveNamespace(undefined);
  const scope: OpenReceiveIdempotencyScope = {
    namespace: namespaceScope,
    operation,
    idempotency_key: idempotencyKey,
  };
  const requestHash = await createIdempotencyRequestHash(requestHashBody);
  const existing = await getIdempotentRecord({
    store: context.store,
    scope,
    idempotency_request_hash: requestHash,
  });

  if (existing !== undefined) {
    emitLog(
      context.options,
      "info",
      "checkout.create.replayed",
      "Replayed existing invoice for idempotent checkout request.",
      invoiceLogFields(existing.record.row),
    );
    return existing.record;
  }

  const resolved = await resolveCreateAmount({
    body: createAmountRequest(createInput.amount),
    now: input.now,
    priceProviders: context.priceProviders,
    priceCurrencies: context.priceCurrencies,
  });
  const descriptionFields = getCreateDescriptionFields({
    memo: createInput.memo,
    descriptionHash: createInput.description_hash,
  });
  emitLog(
    context.options,
    "info",
    "checkout.create.requested",
    "Creating Lightning invoice through receive wallet.",
    {
      order_id: orderId,
      checkout_id: checkoutId,
      amount_msats: resolved.amount_msats,
      amount_source: resolved.amount_source,
      ...(resolved.fiat_quote === null
        ? {}
        : {
            btc_fiat_price: resolved.fiat_quote.btc_fiat_price,
            price_source: resolved.fiat_quote.source,
          }),
    },
  );
  const walletInvoice = await context.options.client.makeInvoice({
    amount_msats: BigInt(resolved.amount_msats),
    ...descriptionFields,
    expiry: OPENRECEIVE_INVOICE_EXPIRY_SECONDS,
  });
  const createdAt = walletInvoice.created_at ?? context.clock();
  const expiresAt = walletInvoice.expires_at ?? createdAt + OPENRECEIVE_INVOICE_EXPIRY_SECONDS;
  const normalizedExpiresAt = Math.min(expiresAt, createdAt + OPENRECEIVE_INVOICE_EXPIRY_SECONDS);
  const metadata = checkoutMetadata(createInput, orderId, checkoutId);
  const createResult = await putCreatedInvoiceRecord({
    store: context.store,
    createStoredInvoiceId,
    record: {
      rev: 0,
      row: {
        invoice_id: createStoredInvoiceId(),
        namespace: namespaceScope,
        operation,
        idempotency_key: idempotencyKey,
        idempotency_request_hash: requestHash,
        payment_hash: walletInvoice.payment_hash,
        invoice: walletInvoice.invoice,
        amount_msats: toSafeInteger(walletInvoice.amount_msats, "amount_msats"),
        transaction_state: "pending",
        workflow_state: "invoice_created",
        settlement_action_state: "pending",
        created_at: createdAt,
        expires_at: normalizedExpiresAt,
        metadata,
        fiat_quote: resolved.fiat_quote === null ? null : { ...resolved.fiat_quote },
      },
    },
  });
  emitLog(context.options, "info", "checkout.created", "Created Lightning invoice for checkout.", {
    ...invoiceLogFields(createResult.record.row),
    order_id: orderId,
    checkout_id: checkoutId,
  });

  return createResult.record;
}

function checkoutMetadata(
  input: NormalizedCreateCheckoutRequest,
  orderId: string,
  checkoutId: string,
): Record<string, unknown> {
  const passthrough = checkoutPassthroughMetadata(input);

  return {
    ...passthrough,
    order_id: orderId,
    checkout_id: checkoutId,
    amount_spec: structuredClone(input.amount),
    ...(input.memo === undefined ? {} : { memo: input.memo }),
    ...(input.description_hash === undefined ? {} : { description_hash: input.description_hash }),
  };
}

function checkoutPassthroughMetadata(
  input: NormalizedCreateCheckoutRequest | undefined,
): Record<string, unknown> {
  const source = parseOptionalRecord(input?.metadata, "metadata");
  if (source === undefined) return {};

  const passthrough: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!RESERVED_CHECKOUT_METADATA_KEYS.has(key)) {
      passthrough[key] = structuredClone(value);
    }
  }
  return passthrough;
}

async function amountMatches(
  context: OpenReceiveServiceContext,
  amount: OpenReceiveCreateCheckoutAmount,
  checkout: OpenReceiveCheckoutModel,
  now: number,
): Promise<boolean> {
  if ("fiat" in amount || checkout.fiat !== undefined) {
    return (
      "fiat" in amount &&
      checkout.fiat !== undefined &&
      amount.fiat.currency === checkout.fiat.currency &&
      amount.fiat.value === checkout.fiat.value
    );
  }

  const resolved = await resolveCreateAmount({
    body: createAmountRequest(amount),
    now,
    priceProviders: context.priceProviders,
    priceCurrencies: context.priceCurrencies,
  });
  return resolved.amount_msats === checkout.amountMsats;
}

function readStoredAmountSpec(row: InvoiceStorageRow): OpenReceiveCreateCheckoutAmount | undefined {
  const value = row.metadata.amount_spec;
  if (!isRecord(value)) return undefined;
  if (isRecord(value.btc)) {
    return {
      btc: value.btc as unknown as OpenReceiveBitcoinAmount,
    };
  }
  if (isRecord(value.fiat)) {
    const currency = optionalString(value.fiat.currency);
    const fiatValue = optionalString(value.fiat.value);
    if (currency !== undefined && fiatValue !== undefined) {
      return {
        fiat: {
          currency,
          value: fiatValue,
        },
      };
    }
  }
  return undefined;
}

function createAmountRequest(amount: OpenReceiveCreateCheckoutAmount): Record<string, unknown> {
  readCreateAmountKind(amount);
  return {
    ...("btc" in amount ? { amount: amount.btc } : {}),
    ...("fiat" in amount ? { fiat: amount.fiat } : {}),
  };
}

function createCheckoutRequestHashBody(
  input: NormalizedCreateCheckoutRequest,
): Record<string, unknown> {
  return {
    order_id: input.order_id,
    amount: structuredClone(input.amount),
    ...(input.memo === undefined ? {} : { memo: input.memo }),
    ...(input.description_hash === undefined ? {} : { description_hash: input.description_hash }),
    ...(input.metadata === undefined ? {} : { metadata: checkoutPassthroughMetadata(input) }),
  };
}

function amountKeyFromCreateAmount(amount: OpenReceiveCreateCheckoutAmount): string {
  readCreateAmountKind(amount);
  if ("fiat" in amount) {
    return `fiat:${amount.fiat.currency}:${amount.fiat.value}`;
  }
  return `btc:${amount.btc.currency}:${amount.btc.value}`;
}

function readCreateAmountKind(amount: OpenReceiveCreateCheckoutAmount): "btc" | "fiat" {
  if (!isRecord(amount)) {
    throw serviceError(
      400,
      "INVALID_REQUEST",
      "Create checkout request requires exactly one of amount.btc or amount.fiat.",
    );
  }

  const unsupportedKeys = Object.keys(amount).filter((key) => key !== "btc" && key !== "fiat");
  const hasBtc = "btc" in amount && amount.btc !== undefined;
  const hasFiat = "fiat" in amount && amount.fiat !== undefined;
  if (unsupportedKeys.length > 0 || [hasBtc, hasFiat].filter(Boolean).length !== 1) {
    throw serviceError(
      400,
      "INVALID_REQUEST",
      "Create checkout request requires exactly one of amount.btc or amount.fiat.",
    );
  }
  return hasBtc ? "btc" : "fiat";
}

function buildOrder(
  records: readonly StoredRecord[],
  scanMeta: OrderScanMeta,
  now: number,
): OpenReceiveOrderModel {
  if (records.length === 0) {
    throw serviceError(500, "INTERNAL", "Order has no invoices.");
  }
  const checkouts = groupCheckouts(records, now);
  const paidCheckout = checkouts.find((checkout) => checkout.status === "paid");
  const activeCheckout = currentOpenCheckout(checkouts);
  const paid = paidCheckout !== undefined;
  const status: OpenReceiveOrderModel["status"] = paid
    ? "paid"
    : activeCheckout !== undefined
      ? "pending"
      : "expired";
  const displayCheckout = paidCheckout ?? activeCheckout ?? checkouts[0];

  return {
    orderId: readStoredOrderId(records[0].row),
    status,
    paid,
    ...(paidCheckout?.paidAt === undefined ? {} : { paidAt: paidCheckout.paidAt }),
    ...(displayCheckout === undefined ? {} : { displayCheckout }),
    ...(paidCheckout === undefined ? {} : { paidCheckout }),
    ...(activeCheckout === undefined ? {} : { activeCheckout }),
    checkouts,
    walletScanPerformed: scanMeta.walletScanPerformed,
    transactionsChecked: scanMeta.transactionsChecked,
  };
}

function groupCheckouts(records: readonly StoredRecord[], now: number): OpenReceiveCheckoutModel[] {
  const groups = new Map<string, StoredRecord[]>();
  for (const record of records) {
    const checkoutId = readStoredCheckoutId(record.row);
    const group = groups.get(checkoutId) ?? [];
    group.push(record);
    groups.set(checkoutId, group);
  }

  return [...groups.entries()]
    .map(([checkoutId, group]) => buildCheckout(checkoutId, group, now))
    .sort((left, right) =>
      left.createdAt === right.createdAt
        ? right.checkoutId.localeCompare(left.checkoutId)
        : right.createdAt - left.createdAt,
    );
}

function buildCheckout(
  checkoutId: string,
  records: readonly StoredRecord[],
  now: number,
): OpenReceiveCheckoutModel {
  const sortedRecords = [...records].sort((left, right) =>
    left.row.created_at === right.row.created_at
      ? right.row.invoice_id.localeCompare(left.row.invoice_id)
      : right.row.created_at - left.row.created_at,
  );
  const invoices = sortedRecords.map((record) => serializeInvoice(record.row, now));
  const paidInvoice = invoices.find((invoice) => invoice.status === "settled");
  const superseded = sortedRecords.some((record) => record.row.metadata.superseded === true);
  const status: OpenReceiveCheckoutModel["status"] =
    paidInvoice !== undefined
      ? "paid"
      : superseded
        ? "superseded"
        : invoices.every((invoice) => invoice.status === "expired" || invoice.status === "failed")
          ? "expired"
          : "open";
  const active =
    status === "open"
      ? invoices.find(
          (invoice) =>
            invoice.rail !== "swap" && invoice.status === "pending" && invoice.expiresAt > now,
        )
      : undefined;
  const amountSpec = readStoredAmountSpec(sortedRecords[0].row);
  const base = active ?? paidInvoice ?? requiredValue(invoices[0]);

  return {
    checkoutId,
    orderId: readStoredOrderId(sortedRecords[0].row),
    status,
    amountMsats: base.amountMsats,
    ...(amountSpec !== undefined && "fiat" in amountSpec
      ? {
          fiat: {
            currency: amountSpec.fiat.currency,
            value: amountSpec.fiat.value,
          },
        }
      : {}),
    ...(active === undefined ? {} : { active }),
    invoices,
    ...(paidInvoice?.settledAt === undefined ? {} : { paidAt: paidInvoice.settledAt }),
    createdAt: Math.min(...sortedRecords.map((record) => record.row.created_at)),
  };
}

function currentOpenCheckout(
  checkouts: readonly OpenReceiveCheckoutModel[],
): OpenReceiveCheckoutModel | undefined {
  return checkouts.find((checkout) => checkout.status === "open");
}

function retryBaseCheckout(
  checkouts: readonly OpenReceiveCheckoutModel[],
): OpenReceiveCheckoutModel | undefined {
  return checkouts.find((checkout) => checkout.status === "expired");
}

function requireCheckout(
  checkouts: readonly OpenReceiveCheckoutModel[],
  checkoutId: string,
): OpenReceiveCheckoutModel {
  const checkout = checkouts.find((candidate) => candidate.checkoutId === checkoutId);
  if (checkout === undefined) {
    throw serviceError(500, "INTERNAL", "Created checkout was not readable.");
  }
  return checkout;
}

async function supersedeCheckout(
  context: OpenReceiveServiceContext,
  checkout: OpenReceiveCheckoutModel,
): Promise<void> {
  const records = await context.store.listByCheckoutId(checkout.checkoutId);
  for (const record of records) {
    const superseded: StoredRecord = {
      rev: record.rev + 1,
      row: {
        ...record.row,
        metadata: {
          ...record.row.metadata,
          superseded: true,
        },
      },
    };
    const result = await context.store.put(superseded, record.rev);
    if (result.status === "conflict") {
      emitLog(
        context.options,
        "warn",
        "checkout.supersede.conflict",
        "Skipped superseding a checkout invoice after a storage conflict.",
        invoiceLogFields(result.record.row),
      );
    }
  }
}

async function getSwapOptions(
  context: OpenReceiveServiceContext,
  input: OpenReceiveSwapOptionsRequest,
): Promise<OpenReceiveSwapOptionsResponse> {
  const providers = context.swapProviders;
  if (providers.length === 0) {
    return {
      enabled: false,
      options: [],
    };
  }

  const orderId = parseGetOrderId(input);
  const records = await context.store.listByOrderId(orderId);
  if (records.length === 0) {
    throw serviceError(404, "NOT_FOUND", "No order found for the given order_id.");
  }

  const checkout = currentOpenCheckout(groupCheckouts(records, context.clock()));
  if (checkout === undefined) {
    return {
      enabled: true,
      options: [],
    };
  }

  const providerByAsset = await resolveSwapProvidersByAsset(providers);
  const options = await Promise.all(
    listOpenReceiveSwapAssetInfo().map(async (asset) => {
      const provider = providerByAsset.get(asset.pay_in_asset);
      if (provider === undefined) {
        return {
          pay_in_asset: asset.pay_in_asset,
          label: asset.label,
          network_label: asset.network_label,
          provider: "",
          min_ok: false,
          max_ok: false,
        } satisfies OpenReceiveSwapOption;
      }

      const quote = await provider.quote({
        payInAsset: asset.pay_in_asset,
        invoiceAmountMsats: checkout.amountMsats,
      });
      return {
        pay_in_asset: asset.pay_in_asset,
        label: asset.label,
        network_label: asset.network_label,
        provider: quote.provider,
        min_ok: quote.min_ok,
        max_ok: quote.max_ok,
        ...(quote.pay_amount === undefined ? {} : { pay_amount: quote.pay_amount }),
      } satisfies OpenReceiveSwapOption;
    }),
  );

  return {
    enabled: true,
    options,
  };
}

async function startSwap(
  context: OpenReceiveServiceContext,
  input: OpenReceiveSwapStartRequest,
): Promise<OpenReceiveInvoiceModel> {
  const body = asRecord(input);
  const orderId = parseOrderId(body);
  const payInAsset = parseSwapPayInAsset(body.payInAsset ?? body.pay_in_asset);
  const now = context.clock();
  const records = await context.store.listByOrderId(orderId);
  if (records.length === 0) {
    throw serviceError(404, "NOT_FOUND", "No order found for the given order_id.");
  }

  await sweepPendingInvoicesOnce(reconcileOptions(context));
  await advanceSwapsForRecords(context, records);
  const freshRecords = await context.store.listByOrderId(orderId);
  const checkouts = groupCheckouts(freshRecords, now);
  const paidCheckout = checkouts.find((checkout) => checkout.status === "paid");
  if (paidCheckout !== undefined) {
    throw serviceError(409, "CONFLICT", "Order is already paid.");
  }

  const checkout = currentOpenCheckout(checkouts);
  if (checkout === undefined) {
    throw serviceError(409, "CONFLICT", "Order has no open checkout to start a swap.");
  }
  if (checkout.active === undefined) {
    throw serviceError(409, "CONFLICT", "Open checkout has no Lightning invoice to swap.");
  }

  const checkoutRecords = await context.store.listByCheckoutId(checkout.checkoutId);
  const existing = findReusableSwapRecord(checkoutRecords, payInAsset, now);
  if (existing !== undefined) {
    return serializeInvoice(existing.row, now);
  }

  const nonTerminalSwapCount = checkoutRecords.filter((record) =>
    isReusableSwapRecord(record, now)
  ).length;
  if (nonTerminalSwapCount >= 3) {
    throw serviceError(
      409,
      "CONFLICT",
      "Checkout already has three active swap attempts. Wait for one to expire before starting another.",
    );
  }

  const provider = await selectSwapProvider(context.swapProviders, payInAsset);
  if (provider === undefined) {
    throw serviceError(
      400,
      "INVALID_REQUEST",
      `${formatOpenReceiveSwapAssetLabel(payInAsset)} is not available for automated swaps.`,
    );
  }

  const displayRecord = checkoutRecords.find(
    (record) => record.row.invoice_id === checkout.active?.invoiceId,
  );
  if (displayRecord === undefined) {
    throw serviceError(500, "INTERNAL", "Active checkout invoice was not readable.");
  }

  const invoiceExpirySeconds = getOpenReceiveSwapAssetInfo(payInAsset).expiry_seconds;
  const walletInvoice = await context.options.client.makeInvoice({
    amount_msats: BigInt(displayRecord.row.amount_msats),
    ...getStoredDescriptionFields(displayRecord.row),
    expiry: invoiceExpirySeconds,
  });
  const createdAt = walletInvoice.created_at ?? context.clock();
  const expiresAt = walletInvoice.expires_at ?? createdAt + invoiceExpirySeconds;
  const normalizedExpiresAt = Math.min(expiresAt, createdAt + invoiceExpirySeconds);
  const providerOrder = await provider.createSwap({
    payInAsset,
    bolt11: walletInvoice.invoice,
    invoiceAmountMsats: displayRecord.row.amount_msats,
  });
  const idempotencyKey = `${checkout.checkoutId}:swap:${payInAsset}`;
  const requestHash = await createIdempotencyRequestHash({
    checkout_id: checkout.checkoutId,
    pay_in_asset: payInAsset,
    amount_msats: displayRecord.row.amount_msats,
    rail: "swap",
  });
  const namespaceScope = context.options.namespace ?? readOpenReceiveNamespace(undefined);
  const operation = "invoice.create";
  const createResult = await putCreatedInvoiceRecord({
    store: context.store,
    createStoredInvoiceId,
    record: {
      rev: 0,
      row: {
        invoice_id: createStoredInvoiceId(),
        namespace: namespaceScope,
        operation,
        idempotency_key: idempotencyKey,
        idempotency_request_hash: requestHash,
        payment_hash: walletInvoice.payment_hash,
        invoice: walletInvoice.invoice,
        amount_msats: toSafeInteger(walletInvoice.amount_msats, "amount_msats"),
        transaction_state: "pending",
        workflow_state: "invoice_created",
        settlement_action_state: "pending",
        created_at: createdAt,
        expires_at: normalizedExpiresAt,
        metadata: {
          ...swapBaseMetadata(displayRecord.row),
          rail: "swap",
          swap_attempt_key: idempotencyKey,
          swap: {
            ...swapMetadataFromProviderOrder(providerOrder, now),
            created_at: now,
          },
        },
        fiat_quote:
          displayRecord.row.fiat_quote === undefined
            ? null
            : structuredClone(displayRecord.row.fiat_quote),
      },
    },
  });

  emitLog(context.options, "info", "swap.created", "Created automated swap invoice.", {
    ...invoiceLogFields(createResult.record.row),
    order_id: orderId,
    checkout_id: checkout.checkoutId,
    provider: provider.name,
    pay_in_asset: payInAsset,
    provider_order_id: providerOrder.provider_order_id,
  });

  return serializeInvoice(createResult.record.row, now);
}

async function refundSwap(
  context: OpenReceiveServiceContext,
  input: OpenReceiveSwapRefundRequest,
): Promise<OpenReceiveInvoiceModel> {
  const body = asRecord(input);
  const orderId = parseOrderId(body);
  const payInAsset = parseSwapPayInAsset(body.payInAsset ?? body.pay_in_asset);
  const refundAddress = optionalString(body.refundAddress ?? body.refund_address);
  if (refundAddress === undefined) {
    throw serviceError(400, "INVALID_REQUEST", "refund_address is required.");
  }
  assertRefundAddressShape(payInAsset, refundAddress);

  const records = await context.store.listByOrderId(orderId);
  const candidate = records
    .filter((record) => readStoredSwapPayInAsset(record.row) === payInAsset)
    .sort((left, right) => right.row.created_at - left.row.created_at)
    .find((record) => readStoredSwapState(record.row) === "refund_required");
  if (candidate === undefined) {
    throw serviceError(409, "CONFLICT", "No refund-required swap found for this order and asset.");
  }

  const order = readStoredSwapOrder(candidate.row);
  const provider = context.swapProviders.find((item) => item.name === order.provider);
  if (provider === undefined) {
    throw serviceError(503, "INTERNAL", "Swap provider is unavailable.");
  }

  await provider.requestRefund(order, refundAddress);
  const updated = await updateSwapRecord(context, candidate, (swap) => ({
    ...swap,
    provider_state: "refund_pending",
    refund_address: refundAddress,
    last_polled_at: context.clock(),
  }));
  return serializeInvoice(updated.row, context.clock());
}

async function advanceSwapsForOrder(
  context: OpenReceiveServiceContext,
  orderId: string,
): Promise<void> {
  if (context.swapProviders.length === 0) return;
  await advanceSwapsForRecords(context, await context.store.listByOrderId(orderId));
}

async function advanceSwapsForRecords(
  context: OpenReceiveServiceContext,
  records: readonly StoredRecord[],
): Promise<void> {
  if (context.swapProviders.length === 0) return;
  const now = context.clock();
  const candidates = records
    .filter((record) => shouldPollSwapRecord(record, now))
    .sort((left, right) => left.row.created_at - right.row.created_at);

  for (const record of candidates) {
    const order = readStoredSwapOrder(record.row);
    const provider = context.swapProviders.find((item) => item.name === order.provider);
    if (provider === undefined) continue;

    try {
      const updatedOrder = await provider.getStatus(order);
      await updateSwapRecord(context, record, (swap) => ({
        ...swap,
        ...swapMetadataFromProviderOrder(updatedOrder, now),
        last_polled_at: now,
      }));
    } catch (error) {
      emitLog(context.options, "warn", "swap.status.failed", "Swap provider status refresh failed.", {
        invoice_id: record.row.invoice_id,
        provider: order.provider,
        provider_order_id: order.provider_order_id,
        error_message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function resolveSwapProvidersByAsset(
  providers: readonly OpenReceiveSwapProvider[],
): Promise<Map<OpenReceiveSwapPayInAsset, OpenReceiveSwapProvider>> {
  const byAsset = new Map<OpenReceiveSwapPayInAsset, OpenReceiveSwapProvider>();
  for (const provider of providers) {
    const supported = await provider.supportedPayInAssets();
    for (const asset of listOpenReceiveSwapAssetInfo()) {
      if (!byAsset.has(asset.pay_in_asset) && supported.has(asset.pay_in_asset)) {
        byAsset.set(asset.pay_in_asset, provider);
      }
    }
  }
  return byAsset;
}

async function selectSwapProvider(
  providers: readonly OpenReceiveSwapProvider[],
  payInAsset: OpenReceiveSwapPayInAsset,
): Promise<OpenReceiveSwapProvider | undefined> {
  for (const provider of providers) {
    if ((await provider.supportedPayInAssets()).has(payInAsset)) return provider;
  }
  return undefined;
}

function findReusableSwapRecord(
  records: readonly StoredRecord[],
  payInAsset: OpenReceiveSwapPayInAsset,
  now: number,
): StoredRecord | undefined {
  return records
    .filter((record) => readStoredSwapPayInAsset(record.row) === payInAsset)
    .filter((record) => isReusableSwapRecord(record, now))
    .sort((left, right) => right.row.created_at - left.row.created_at)[0];
}

function isReusableSwapRecord(record: StoredRecord, now: number): boolean {
  if (readInvoiceRail(record.row) !== "swap") return false;
  if (record.row.expires_at <= now) return false;
  if (record.row.transaction_state === "settled") return false;
  const state = readStoredSwapState(record.row);
  return state !== undefined && !isOpenReceiveSwapTerminalState(state);
}

function shouldPollSwapRecord(record: StoredRecord, now: number): boolean {
  if (!isReusableSwapRecord(record, now)) return false;
  const lastPolledAt = readStoredSwapLastPolledAt(record.row);
  return lastPolledAt === undefined || now - lastPolledAt >= 10;
}

async function updateSwapRecord(
  context: OpenReceiveServiceContext,
  record: StoredRecord,
  update: (swap: Record<string, unknown>) => Record<string, unknown>,
): Promise<StoredRecord> {
  let current = (await context.store.get(record.row.invoice_id)) ?? record;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const currentSwap = parseSwapMetadata(current.row);
    if (currentSwap === undefined) return current;
    const updated: StoredRecord = {
      rev: current.rev + 1,
      row: {
        ...current.row,
        metadata: {
          ...current.row.metadata,
          swap: update(currentSwap),
        },
      },
    };
    const result = await context.store.put(updated, current.rev);
    if (result.status === "ok") return result.record;
    current = result.record;
  }
  return current;
}

function swapBaseMetadata(row: InvoiceStorageRow): Record<string, unknown> {
  const metadata = structuredClone(row.metadata);
  delete metadata.superseded;
  delete metadata.rail;
  delete metadata.swap;
  delete metadata.swap_attempt_key;
  return metadata;
}

function swapMetadataFromProviderOrder(
  order: OpenReceiveSwapOrder,
  now: number,
): Record<string, unknown> {
  return {
    provider: order.provider,
    provider_order_id: order.provider_order_id,
    provider_token: order.provider_token,
    pay_in_asset: order.pay_in_asset,
    deposit_address: order.deposit_address,
    ...(order.deposit_memo === undefined ? {} : { deposit_memo: order.deposit_memo }),
    deposit_amount: order.deposit_amount,
    provider_state: order.state,
    provider_expires_at: order.expires_at,
    ...(order.deposit_tx_id === undefined ? {} : { deposit_tx_id: order.deposit_tx_id }),
    ...(order.refund_tx_id === undefined ? {} : { refund_tx_id: order.refund_tx_id }),
    ...(order.attention === undefined ? {} : { attention: order.attention }),
    last_polled_at: now,
  };
}

function readInvoiceRail(row: InvoiceStorageRow): "lightning" | "swap" {
  return row.metadata.rail === "swap" ? "swap" : "lightning";
}

function readPublicSwap(row: InvoiceStorageRow): OpenReceivePublicSwap | undefined {
  const swap = parseSwapMetadata(row);
  if (swap === undefined) return undefined;
  const payInAsset = parseStoredSwapPayInAsset(swap.pay_in_asset);
  const provider = optionalString(swap.provider);
  const depositAddress = optionalString(swap.deposit_address);
  const depositAmount = optionalString(swap.deposit_amount);
  const providerState = optionalString(swap.provider_state) as OpenReceiveSwapProviderState | undefined;
  const providerExpiresAt = optionalSafeInteger(swap.provider_expires_at);
  if (
    payInAsset === undefined ||
    provider === undefined ||
    depositAddress === undefined ||
    depositAmount === undefined ||
    providerState === undefined ||
    providerExpiresAt === undefined
  ) {
    return undefined;
  }

  return {
    provider,
    pay_in_asset: payInAsset,
    deposit_address: depositAddress,
    ...(optionalString(swap.deposit_memo) === undefined
      ? {}
      : { deposit_memo: optionalString(swap.deposit_memo) }),
    deposit_amount: depositAmount,
    provider_state: providerState,
    provider_expires_at: providerExpiresAt,
    ...(optionalString(swap.deposit_tx_id) === undefined
      ? {}
      : { deposit_tx_id: optionalString(swap.deposit_tx_id) }),
    ...(optionalString(swap.refund_address) === undefined
      ? {}
      : { refund_address: optionalString(swap.refund_address) }),
    ...(optionalString(swap.refund_tx_id) === undefined
      ? {}
      : { refund_tx_id: optionalString(swap.refund_tx_id) }),
    ...(typeof swap.attention === "boolean" ? { attention: swap.attention } : {}),
  };
}

function readStoredSwapOrder(row: InvoiceStorageRow): OpenReceiveSwapOrder {
  const swap = parseSwapMetadata(row);
  if (swap === undefined) {
    throw serviceError(500, "INTERNAL", "Stored swap metadata is missing.");
  }
  const provider = optionalString(swap.provider);
  const providerOrderId = optionalString(swap.provider_order_id);
  const providerToken = optionalString(swap.provider_token);
  const payInAsset = parseStoredSwapPayInAsset(swap.pay_in_asset);
  const depositAddress = optionalString(swap.deposit_address);
  const depositAmount = optionalString(swap.deposit_amount);
  const providerState = optionalString(swap.provider_state) as OpenReceiveSwapProviderState | undefined;
  const providerExpiresAt = optionalSafeInteger(swap.provider_expires_at);
  if (
    provider === undefined ||
    providerOrderId === undefined ||
    providerToken === undefined ||
    payInAsset === undefined ||
    depositAddress === undefined ||
    depositAmount === undefined ||
    providerState === undefined ||
    providerExpiresAt === undefined
  ) {
    throw serviceError(500, "INTERNAL", "Stored swap metadata is incomplete.");
  }

  return {
    provider,
    provider_order_id: providerOrderId,
    provider_token: providerToken,
    pay_in_asset: payInAsset,
    deposit_address: depositAddress,
    ...(optionalString(swap.deposit_memo) === undefined
      ? {}
      : { deposit_memo: optionalString(swap.deposit_memo) }),
    deposit_amount: depositAmount,
    expires_at: providerExpiresAt,
    state: providerState,
    ...(optionalString(swap.deposit_tx_id) === undefined
      ? {}
      : { deposit_tx_id: optionalString(swap.deposit_tx_id) }),
    ...(optionalString(swap.refund_tx_id) === undefined
      ? {}
      : { refund_tx_id: optionalString(swap.refund_tx_id) }),
    ...(typeof swap.attention === "boolean" ? { attention: swap.attention } : {}),
  };
}

function parseSwapMetadata(row: InvoiceStorageRow): Record<string, unknown> | undefined {
  if (readInvoiceRail(row) !== "swap") return undefined;
  return isRecord(row.metadata.swap) ? row.metadata.swap : undefined;
}

function readStoredSwapPayInAsset(row: InvoiceStorageRow): OpenReceiveSwapPayInAsset | undefined {
  return parseStoredSwapPayInAsset(parseSwapMetadata(row)?.pay_in_asset);
}

function readStoredSwapState(row: InvoiceStorageRow): OpenReceiveSwapProviderState | undefined {
  return optionalString(parseSwapMetadata(row)?.provider_state) as
    | OpenReceiveSwapProviderState
    | undefined;
}

function readStoredSwapLastPolledAt(row: InvoiceStorageRow): number | undefined {
  return optionalSafeInteger(parseSwapMetadata(row)?.last_polled_at);
}

function parseStoredSwapPayInAsset(value: unknown): OpenReceiveSwapPayInAsset | undefined {
  return isOpenReceiveSwapPayInAsset(value) ? value : undefined;
}

function parseSwapPayInAsset(value: unknown): OpenReceiveSwapPayInAsset {
  if (!isOpenReceiveSwapPayInAsset(value)) {
    throw serviceError(400, "INVALID_REQUEST", "pay_in_asset is not supported.");
  }
  return value;
}

function getStoredDescriptionFields(row: InvoiceStorageRow): {
  readonly description?: string;
  readonly description_hash?: string;
} {
  return getCreateDescriptionFields({
    memo: row.metadata.memo,
    descriptionHash: row.metadata.description_hash,
  });
}

function optionalSafeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) ? (value as number) : undefined;
}

function assertRefundAddressShape(
  payInAsset: OpenReceiveSwapPayInAsset,
  refundAddress: string,
): void {
  if (refundAddress.length > 200 || /\s/.test(refundAddress)) {
    throw serviceError(400, "INVALID_REQUEST", "refund_address is not valid for this asset.");
  }
  const network = getOpenReceiveSwapAssetInfo(payInAsset).network;
  const valid =
    network === "ETH"
      ? /^0x[0-9a-fA-F]{40}$/.test(refundAddress)
      : network === "SOL"
        ? /^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(refundAddress)
        : network === "TRX"
          ? /^T[1-9A-HJ-NP-Za-km-z]{20,60}$/.test(refundAddress)
          : refundAddress.length >= 5;
  if (!valid) {
    throw serviceError(400, "INVALID_REQUEST", "refund_address is not valid for this asset.");
  }
}

async function listRates(
  context: OpenReceiveServiceContext,
  input: OpenReceiveListRatesRequest = {},
): Promise<OpenReceiveBtcFiatRateMapWithSource["rates"]> {
  try {
    const currencies =
      input.currencies === undefined
        ? context.priceCurrencies
        : normalizeOpenReceivePriceCurrencies(input.currencies, "listRates currencies");
    for (const currency of currencies) {
      assertAllowedFiatCurrency(currency, context.priceCurrencies);
    }
    const rates = await getBtcFiatRatesForProviders({
      currencies,
      priceProviders: context.priceProviders,
    });
    return rates.rates;
  } catch (error) {
    throw mapPriceError(error);
  }
}

async function quoteRates(
  context: OpenReceiveServiceContext,
  input: { readonly fiat: OpenReceiveFiatAmount },
): Promise<OpenReceiveRateQuote> {
  const body = asRecord(input);
  try {
    const fiat = parseFiatAmount(body.fiat);
    assertAllowedFiatCurrency(fiat.currency, context.priceCurrencies);
    return await quoteFiatAmount({
      fiat,
      as_of: context.clock(),
      priceProviders: context.priceProviders,
    });
  } catch (error) {
    throw mapPriceError(error);
  }
}

async function runOpenReceiveOperation<T>(
  context: OpenReceiveServiceContext,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const normalized = normalizeOpenReceiveServiceError(error);
    if (normalized instanceof OpenReceiveServiceError) throw normalized;
    emitLog(context.options, "error", "service.error", "OpenReceive service method failed.", {
      error_message: normalized instanceof Error ? normalized.message : String(normalized),
    });
    throw normalized;
  }
}

function scheduleBestEffortSweep(context: OpenReceiveServiceContext): void {
  const promise = sweepPendingInvoicesOnce(reconcileOptions(context)).catch((error: unknown) => {
    emitLog(context.options, "warn", "checkout.sweep.failed", "Background invoice sweep failed.", {
      error_message: error instanceof Error ? error.message : String(error),
    });
  });
  if (context.options.waitUntil !== undefined) {
    context.options.waitUntil(promise);
    return;
  }
  void promise;
}

function normalizeOpenReceiveServiceError(error: unknown): unknown {
  if (error instanceof OpenReceiveServiceError) return error;
  if (isStatusCodeError(error)) {
    return new OpenReceiveServiceError(error.status, {
      code: error.code,
      message: error.message,
    });
  }
  return error;
}

function createConfiguredClient(options: CreateOpenReceiveOptions): OpenReceiveReceiveNwcClient {
  if (options.client !== undefined) return options.client;
  try {
    return createNwcReceiveClient({
      connectionString: readOpenReceiveNwc(options.nwc),
      logger: createNwcEndpointLogger(options),
    });
  } catch (error) {
    if (error instanceof OpenReceiveConfigError) throw error;
    const reason = error instanceof NwcUriParseError ? error.description : undefined;
    throw new OpenReceiveConfigError({
      code: "INVALID_NWC",
      message: formatOpenReceiveInvalidNwcMessage({ reason }),
      hint: "Set OPENRECEIVE_NWC to a receive-only nostr+walletconnect URI from your wallet.",
      cause: error,
    });
  }
}

async function preflightConfiguredClient(client: OpenReceiveReceiveNwcClient): Promise<void> {
  try {
    await client.preflight();
  } catch (error) {
    throw new OpenReceiveConfigError({
      code: "WALLET_PREFLIGHT_FAILED",
      message: "OpenReceive wallet preflight failed.",
      hint: "Check that OPENRECEIVE_NWC is receive-only, reachable, and advertises make_invoice plus list_transactions.",
      cause: error,
    });
  }
}

async function resolveConfiguredStore(
  options: CreateOpenReceiveOptions,
  namespace: string,
): Promise<OpenReceiveInvoiceKvStore> {
  try {
    const store =
      options.store ??
      (await resolveOpenReceiveStore(options.storeUri, {
        cwd: options.cwd,
        namespace,
        loadSqlite: options.loadSqlite,
        loadPostgres: options.loadPostgres,
      }));
    await ensureOpenReceiveStoreSchema(store);
    return store;
  } catch (error) {
    if (error instanceof OpenReceiveConfigError) throw error;
    throw new OpenReceiveConfigError({
      code: "STORE_UNAVAILABLE",
      message: "OpenReceive store is unavailable.",
      hint: "Check OPENRECEIVE_STORE, database credentials, migrations, and the configured namespace.",
      cause: error,
    });
  }
}

function isStatusCodeError(
  error: unknown,
): error is Error & { readonly status: number; readonly code: OpenReceiveErrorCode } {
  return (
    error instanceof Error &&
    typeof (error as { status?: unknown }).status === "number" &&
    isOpenReceiveErrorCode((error as { code?: unknown }).code)
  );
}

function readOpenReceiveNwc(configured: string | undefined): string {
  const nwc = configured ?? globalThis.process?.env?.OPENRECEIVE_NWC;
  if (nwc === undefined || nwc.trim().length === 0) {
    throw new OpenReceiveConfigError({
      code: "MISSING_NWC",
      message: formatOpenReceiveMissingNwcMessage(),
      hint: "Create a receive-only NWC connection in your wallet and set OPENRECEIVE_NWC on the server.",
    });
  }

  return nwc;
}

function readOpenReceiveNamespace(configured: string | undefined): string {
  const namespace = configured ?? globalThis.process?.env?.OPENRECEIVE_NAMESPACE ?? "default";
  if (namespace.trim().length === 0) {
    throw new OpenReceiveConfigError({
      code: "STORE_UNAVAILABLE",
      message: "OPENRECEIVE_NAMESPACE must not be empty.",
      hint: "Set OPENRECEIVE_NAMESPACE to a stable non-empty app namespace, or omit it to use default.",
    });
  }
  return namespace;
}

function readOpenReceivePriceCurrencies(
  configured: readonly string[] | undefined,
): readonly string[] {
  const rawCurrencies = configured ??
    globalThis.process?.env?.OPENRECEIVE_PRICE_CURRENCIES?.split(",") ?? ["USD"];
  return normalizeOpenReceivePriceCurrencies(rawCurrencies, "OPENRECEIVE_PRICE_CURRENCIES");
}

function normalizeOpenReceivePriceCurrencies(
  rawCurrencies: readonly string[],
  label: string,
): readonly string[] {
  const currencies = [
    ...new Set(rawCurrencies.map((currency) => currency.trim().toUpperCase()).filter(Boolean)),
  ];
  if (currencies.length === 0) {
    throw new OpenReceiveConfigError({
      code: "INVALID_PRICE_CURRENCIES",
      message: `${label} must include at least one currency.`,
      hint: "Set OPENRECEIVE_PRICE_CURRENCIES to comma-separated fiat codes like USD,EUR, or omit it to use USD.",
    });
  }
  for (const currency of currencies) {
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new OpenReceiveConfigError({
        code: "INVALID_PRICE_CURRENCIES",
        message: `Invalid ${label} entry: ${currency}.`,
        hint: "Use three-letter fiat currency codes such as USD or EUR.",
      });
    }
  }
  return currencies;
}

async function ensureOpenReceiveStoreSchema(store: OpenReceiveInvoiceKvStore): Promise<void> {
  const ensureSchema = isRecord(store) ? store.ensureSchema : undefined;
  if (typeof ensureSchema === "function") {
    await ensureSchema.call(store);
  }
}

async function closeOpenReceiveResource(resource: unknown): Promise<void> {
  const close = isRecord(resource) ? resource.close : undefined;
  if (typeof close === "function") {
    await close.call(resource);
  }
}

function reconcileOptions(context: OpenReceiveServiceContext) {
  return {
    store: context.store,
    client: context.options.client,
    clock: context.clock,
    actionLeaseTtlSeconds:
      context.options.actionLeaseTtlSeconds ??
      readPositiveIntegerEnv("OPENRECEIVE_ACTION_LEASE_TTL_SEC"),
    transactionScanIntervalSeconds:
      context.options.transactionScanIntervalSeconds ??
      readPositiveIntegerEnv("OPENRECEIVE_TRANSACTION_SCAN_INTERVAL_SEC"),
    transactionScanPageLimit:
      context.options.transactionScanPageLimit ??
      readPositiveIntegerEnv("OPENRECEIVE_TRANSACTION_SCAN_PAGE_LIMIT"),
    transactionScanWindowPaddingSeconds:
      context.options.transactionScanWindowPaddingSeconds ??
      readNonNegativeIntegerEnv("OPENRECEIVE_TRANSACTION_SCAN_WINDOW_PADDING_SEC"),
    transactionScanOverlapSeconds:
      context.options.transactionScanOverlapSeconds ??
      readNonNegativeIntegerEnv("OPENRECEIVE_TRANSACTION_SCAN_OVERLAP_SEC"),
    sweepOpenInvoiceCap:
      context.options.sweepOpenInvoiceCap ??
      readPositiveIntegerEnv("OPENRECEIVE_SWEEP_OPEN_INVOICE_CAP"),
    transactionScanTimeoutMs:
      context.options.transactionScanTimeoutMs ??
      readPositiveIntegerEnv("OPENRECEIVE_TRANSACTION_SCAN_TIMEOUT_MS"),
    settlementAction: async (input: OpenReceiveSettlementActionInput) => {
      // Delivered after backend-verified settlement, at least once. Apps must
      // dedupe fulfillment by checkoutId or their own order id.
      await context.options.onPaid?.({
        invoice: input.invoice,
        orderId: readStoredOrderId(input.invoice),
        checkoutId: readStoredCheckoutId(input.invoice),
        invoiceId: input.invoice.invoice_id,
        paymentHash: input.invoice.payment_hash,
        amountMsats: input.invoice.amount_msats,
        metadata: input.metadata,
        source: input.source,
        transaction: input.transaction,
      });
    },
    onEvent: (event: OpenReceiveReconcileEvent) => {
      emitLog(
        context.options,
        event.event === "invoice.failed" || event.event === "transaction_scan.failed"
          ? "warn"
          : "info",
        event.event,
        "OpenReceive refreshed invoice state.",
        {
          ...invoiceLogFields(event.invoice),
          ...(event.reason === undefined ? {} : { reason: event.reason }),
        },
      );
    },
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

function readNonNegativeIntegerEnv(name: string): number | undefined {
  const value = globalThis.process?.env?.[name];
  if (value === undefined || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function toWireInvoice(model: OpenReceiveInvoiceModel): OpenReceiveInvoice {
  return {
    invoice_id: model.invoiceId,
    type: model.type,
    rail: model.rail,
    status: model.status,
    transaction_state: model.transactionState,
    workflow_state: model.workflowState,
    invoice: model.bolt11,
    payment_hash: model.paymentHash,
    amount_msats: model.amountMsats,
    order_id: model.orderId,
    created_at: model.createdAt,
    expires_at: model.expiresAt,
    ...(model.settledAt === undefined ? {} : { settled_at: model.settledAt }),
    ...(model.settlementActionCompletedAt === undefined
      ? {}
      : { settlement_action_completed_at: model.settlementActionCompletedAt }),
    ...(model.refreshedFromInvoiceId === undefined
      ? {}
      : { refreshed_from_invoice_id: model.refreshedFromInvoiceId }),
    fiat_quote: model.fiatQuote,
    settlement_action_state: model.settlementActionState,
    ...(model.swap === undefined ? {} : { swap: model.swap }),
  };
}

function toWireCheckout(model: OpenReceiveCheckoutModel): OpenReceiveCheckout {
  return {
    checkout_id: model.checkoutId,
    order_id: model.orderId,
    status: model.status,
    amount_msats: model.amountMsats,
    ...(model.fiat === undefined ? {} : { fiat: model.fiat }),
    ...(model.active === undefined ? {} : { active: toWireInvoice(model.active) }),
    invoices: model.invoices.map(toWireInvoice),
    ...(model.paidAt === undefined ? {} : { paid_at: model.paidAt }),
    created_at: model.createdAt,
  };
}

function toWireOrder(model: OpenReceiveOrderModel): OpenReceiveOrder {
  return {
    order_id: model.orderId,
    status: model.status,
    paid: model.paid,
    ...(model.paidAt === undefined ? {} : { paid_at: model.paidAt }),
    ...(model.displayCheckout === undefined
      ? {}
      : { display_checkout: toWireCheckout(model.displayCheckout) }),
    ...(model.paidCheckout === undefined
      ? {}
      : { paid_checkout: toWireCheckout(model.paidCheckout) }),
    ...(model.activeCheckout === undefined
      ? {}
      : { active_checkout: toWireCheckout(model.activeCheckout) }),
    checkouts: model.checkouts.map(toWireCheckout),
    wallet_scan_performed: model.walletScanPerformed,
    transactions_checked: model.transactionsChecked,
  };
}

function serializeInvoice(row: InvoiceStorageRow, now: number): OpenReceiveInvoiceModel {
  return {
    invoiceId: row.invoice_id,
    type: "incoming",
    rail: readInvoiceRail(row),
    status: deriveInvoiceStatus(row, now),
    transactionState: row.transaction_state,
    workflowState: row.workflow_state,
    bolt11: row.invoice,
    paymentHash: row.payment_hash,
    amountMsats: row.amount_msats,
    orderId: readStoredOrderId(row),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.settled_at === undefined ? {} : { settledAt: row.settled_at }),
    ...(row.settlement_action_completed_at === undefined
      ? {}
      : { settlementActionCompletedAt: row.settlement_action_completed_at }),
    ...(row.refreshed_from_invoice_id === undefined
      ? {}
      : { refreshedFromInvoiceId: row.refreshed_from_invoice_id }),
    fiatQuote: (row.fiat_quote ?? null) as OpenReceiveRateQuote | null,
    settlementActionState: row.settlement_action_state,
    ...(readPublicSwap(row) === undefined ? {} : { swap: readPublicSwap(row) }),
  };
}

function deriveInvoiceStatus(
  row: InvoiceStorageRow,
  now: number,
): OpenReceiveInvoiceModel["status"] {
  if (row.settled_at !== undefined || row.transaction_state === "settled") {
    return "settled";
  }
  if (row.transaction_state === "expired" || row.workflow_state === "expired_closed") {
    return "expired";
  }
  if (row.transaction_state === "failed" || row.workflow_state === "failed_closed") {
    return "failed";
  }
  if (row.expires_at <= now) {
    return "expired";
  }
  return "pending";
}

function readStoredOrderId(row: InvoiceStorageRow): string {
  const orderId = row.metadata.order_id;
  return typeof orderId === "string" && orderId.length > 0 ? orderId : row.idempotency_key;
}

function readStoredCheckoutId(row: InvoiceStorageRow): string {
  const checkoutId = row.metadata.checkout_id;
  if (typeof checkoutId === "string" && checkoutId.length > 0) return checkoutId;
  throw serviceError(500, "INTERNAL", "Stored invoice is missing checkout metadata.");
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
    ...(row.settlement_action_completed_at === undefined
      ? {}
      : { settlement_action_completed_at: row.settlement_action_completed_at }),
    ...(row.refreshed_from_invoice_id === undefined
      ? {}
      : { refreshed_from_invoice_id: row.refreshed_from_invoice_id }),
  };
}

function emitLog(
  options: OpenReceiveNodeOptions,
  level: OpenReceiveLogLevel,
  event: string,
  message: string,
  fields: Record<string, unknown> = {},
): void {
  emitOpenReceiveEvent(options, {
    level,
    event,
    message,
    ...fields,
  });
}

function emitOpenReceiveEvent(
  options: {
    readonly onEvent?: OpenReceiveEventHandler;
    readonly logger?: OpenReceiveLogger;
  },
  event: OpenReceiveEvent,
): void {
  if (options.onEvent === undefined && options.logger === undefined) return;

  const sanitized = sanitizeOpenReceiveEvent(event);

  try {
    options.onEvent?.(sanitized);
  } catch {
    // Diagnostics must never change payment, settlement, or settlement-action behavior.
  }

  try {
    options.logger?.(sanitized);
  } catch {
    // Logging must never change payment, settlement, or settlement-action behavior.
  }
}

// Bridges the receive client's NWC endpoint hits (get_info / make_invoice /
// list_transactions) into the service's onEvent + logger sinks, reusing the
// same sanitization so secrets never reach a log line. Returns undefined when
// no sink is configured so the client can skip building entries entirely.
function createNwcEndpointLogger(options: CreateOpenReceiveOptions): NwcEndpointLogger | undefined {
  if (options.onEvent === undefined && options.logger === undefined) return undefined;
  return (entry) => emitOpenReceiveEvent(options, entry);
}

function sanitizeOpenReceiveEvent(entry: OpenReceiveEvent): OpenReceiveEvent {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (isSensitiveLogKey(key)) {
      clean[key] = "[REDACTED]";
    } else {
      clean[key] = sanitizeLogValue(value);
    }
  }
  return clean as OpenReceiveEvent;
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

async function resolveCreateAmount(input: {
  body: Record<string, unknown>;
  now: number;
  priceProviders: readonly OpenReceiveSourcedPriceProvider[];
  priceCurrencies: readonly string[];
}): Promise<ResolvedCreateAmount> {
  const { body } = input;
  const hasAmount = body.amount !== undefined;
  const hasFiat = body.fiat !== undefined;
  const sourceCount = [hasAmount, hasFiat].filter(Boolean).length;

  if (sourceCount !== 1) {
    throw serviceError(
      400,
      "INVALID_REQUEST",
      "Create checkout request requires exactly one of amount.btc or amount.fiat.",
    );
  }

  if (hasAmount) {
    try {
      const quote = quoteBitcoinAmountToMsats(parseBitcoinAmount(body.amount));
      return {
        amount_msats: quote.amount_msats,
        amount_source: "amount",
        fiat_quote: null,
      };
    } catch (error) {
      if (error instanceof OpenReceiveServiceError) throw error;
      throw mapPriceError(error);
    }
  }

  try {
    const fiat = parseFiatAmount(body.fiat);
    assertAllowedFiatCurrency(fiat.currency, input.priceCurrencies);
    const quote = await quoteFiatAmount({
      fiat,
      as_of: input.now,
      priceProviders: input.priceProviders,
    });
    return {
      amount_msats: quote.amount_msats,
      amount_source: "fiat",
      fiat_quote: quote,
    };
  } catch (error) {
    if (error instanceof OpenReceiveServiceError) throw error;
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
    priceProviders: input.priceProviders,
  });
  const btcFiatPrice = rates.rates.bitcoin[input.fiat.currency.toLowerCase()];

  if (btcFiatPrice === undefined) {
    throw new RangeError(`price provider ${rates.source} did not return ${input.fiat.currency}`);
  }

  return quoteFiatToMsatsWithPrice({
    fiat: input.fiat,
    btc_fiat_price: btcFiatPrice,
    source: rates.source,
    as_of: input.as_of,
  });
}

function assertAllowedFiatCurrency(currency: string, allowedCurrencies: readonly string[]): void {
  if (!allowedCurrencies.includes(currency)) {
    throw serviceError(
      400,
      "INVALID_REQUEST",
      `fiat.currency must be one of the configured priceCurrencies: ${allowedCurrencies.join(", ")}.`,
    );
  }
}

async function getBtcFiatRatesForProviders(input: {
  currencies: readonly string[];
  priceProviders: readonly OpenReceiveSourcedPriceProvider[];
}): Promise<OpenReceiveBtcFiatRateMapWithSource> {
  if (input.priceProviders.length === 1) {
    const [provider] = input.priceProviders;
    if (isResolvedPriceProvider(provider)) {
      return await provider.getBtcFiatRatesWithSource(input.currencies);
    }
    return {
      source: provider.source,
      rates: await provider.getBtcFiatRates(input.currencies),
    };
  }

  return getBtcFiatRatesWithFallback({
    currencies: input.currencies,
    providers: input.priceProviders,
  });
}

// Builds the database-cached live price feed (primary first, fallback second),
// honoring the OPENRECEIVE_PRICE_FEED_PRIMARY_URL / _FALLBACK_URL dev overrides.
// Pass the same OpenReceive store the service uses so the 60s cache is durable.
export function createOpenReceivePriceFeed(options: {
  store: OpenReceivePriceFeedCacheStore;
  currencies: readonly string[];
  fetch?: SimplePriceFetch;
  clock?: () => number;
  cacheSeconds?: number;
}): CachedPriceFeed {
  const overrides = readPriceFeedUrlOverrides();
  return createCachedLivePriceFeed({
    store: options.store,
    currencies: options.currencies,
    fetch: options.fetch,
    clock: options.clock,
    cacheSeconds: options.cacheSeconds,
    primaryUrl: overrides.primaryUrl,
    fallbackUrl: overrides.fallbackUrl,
  });
}

function readPriceFeedUrlOverrides(): {
  primaryUrl: string | undefined;
  fallbackUrl: string | undefined;
} {
  return {
    primaryUrl: readPriceFeedUrlEnv(OPENRECEIVE_PRICE_FEED_PRIMARY_URL_ENV),
    fallbackUrl: readPriceFeedUrlEnv(OPENRECEIVE_PRICE_FEED_FALLBACK_URL_ENV),
  };
}

function readPriceFeedUrlEnv(name: string): string | undefined {
  const value = globalThis.process?.env?.[name];
  if (value === undefined || value.trim().length === 0) return undefined;
  return value.trim();
}

function mapPriceError(error: unknown): OpenReceiveServiceError {
  if (error instanceof OpenReceiveServiceError) return error;
  if (error instanceof RangeError) {
    return serviceError(400, "INVALID_REQUEST", error.message);
  }

  return serviceError(503, "INTERNAL", "Unable to fetch BTC fiat exchange rate.");
}

function getCreateDescriptionFields(input: {
  readonly memo?: unknown;
  readonly descriptionHash?: unknown;
}): {
  readonly description?: string;
  readonly description_hash?: string;
} {
  const memo = optionalString(input.memo);
  const descriptionHash = optionalString(input.descriptionHash);

  if (memo !== undefined && memo.length > 500) {
    throw serviceError(400, "INVALID_REQUEST", "memo must be 500 characters or fewer.");
  }

  if (memo !== undefined && descriptionHash !== undefined) {
    throw serviceError(
      400,
      "INVALID_REQUEST",
      "Create checkout request accepts only one of memo or descriptionHash.",
    );
  }

  if (descriptionHash !== undefined && !HEX_64.test(descriptionHash)) {
    throw serviceError(400, "INVALID_REQUEST", "descriptionHash must be 64 hex characters.");
  }

  return {
    ...(memo === undefined ? {} : { description: memo }),
    ...(descriptionHash === undefined ? {} : { description_hash: descriptionHash }),
  };
}

function normalizeCreateCheckoutRequest(
  input: OpenReceiveCreateCheckoutRequest,
): NormalizedCreateCheckoutRequest {
  const body = asRecord(input);
  const orderId = parseOrderId(body);
  const amount = normalizeCreateCheckoutAmount(body);
  const memo = optionalString(body.memo);
  const descriptionHash = optionalString(body.descriptionHash ?? body.description_hash);
  const metadata = parseOptionalRecord(body.metadata, "metadata");

  return {
    order_id: orderId,
    amount,
    ...(memo === undefined ? {} : { memo }),
    ...(descriptionHash === undefined ? {} : { description_hash: descriptionHash }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function normalizeCreateCheckoutAmount(
  body: Record<string, unknown>,
): OpenReceiveCreateCheckoutAmount {
  const sourceCount = [
    body.amount !== undefined,
    body.usd !== undefined,
    body.sats !== undefined,
  ].filter(Boolean).length;

  if (sourceCount !== 1) {
    throw serviceError(
      400,
      "INVALID_REQUEST",
      "Create checkout request requires exactly one of amount, usd, or sats.",
    );
  }

  if (body.amount !== undefined) {
    readCreateAmountKind(body.amount as OpenReceiveCreateCheckoutAmount);
    return structuredClone(body.amount) as OpenReceiveCreateCheckoutAmount;
  }

  if (body.usd !== undefined) {
    const value = optionalString(body.usd);
    if (
      value === undefined ||
      !/^[0-9]+(?:\.[0-9]+)?$/.test(value) ||
      /^0+(?:\.0+)?$/.test(value)
    ) {
      throw serviceError(400, "INVALID_REQUEST", "usd must be a positive decimal string.");
    }
    return {
      fiat: {
        currency: "USD",
        value,
      },
    };
  }

  return {
    btc: {
      currency: "SATS",
      value: normalizeSatsShortcut(body.sats),
    },
  };
}

function normalizeSatsShortcut(value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw serviceError(400, "INVALID_REQUEST", "sats must be a positive integer.");
    }
    return String(value);
  }

  if (typeof value === "string" && /^[0-9]+$/.test(value) && BigInt(value) > 0n) {
    return value;
  }

  throw serviceError(400, "INVALID_REQUEST", "sats must be a positive integer.");
}

function parseOrderId(body: Record<string, unknown>): string {
  const orderId = optionalString(body.orderId ?? body.order_id);
  if (orderId === undefined) {
    throw serviceError(400, "INVALID_REQUEST", "orderId is required.");
  }
  if (orderId.length > 200) {
    throw serviceError(400, "INVALID_REQUEST", "orderId must be 200 characters or fewer.");
  }
  return orderId;
}

function parseGetCheckoutId(input: OpenReceiveGetCheckoutRequest): string {
  const body = asRecord(input);
  const checkoutId = optionalString(body.checkoutId ?? body.checkout_id);
  if (checkoutId === undefined) {
    throw serviceError(400, "INVALID_REQUEST", "checkoutId is required.");
  }
  if (checkoutId.length > 200) {
    throw serviceError(400, "INVALID_REQUEST", "checkoutId must be 200 characters or fewer.");
  }
  return checkoutId;
}

function parseGetOrderId(input: OpenReceiveGetOrderRequest): string {
  return parseOrderId(asRecord(input));
}

function assertDurableStoreConfiguration(input: {
  readonly configuredStoreUri: string | undefined;
  readonly store: OpenReceiveInvoiceKvStore | undefined;
}): void {
  assertOpenReceiveStoreConfiguration({
    storeUri: input.configuredStoreUri,
    store: input.store,
    emitWarning: false,
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw serviceError(400, "INVALID_REQUEST", "Input must be an object.");
  }
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseOptionalRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw serviceError(400, "INVALID_REQUEST", `${field} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function parseFiatAmount(value: unknown): OpenReceiveFiatAmount {
  const record = parseOptionalRecord(value, "fiat");
  if (record === undefined) {
    throw serviceError(400, "INVALID_REQUEST", "fiat must be a JSON object.");
  }
  const currency = optionalString(record.currency);
  const amountValue = optionalString(record.value);
  if (currency === undefined || !/^[A-Z]{3}$/.test(currency)) {
    throw serviceError(400, "INVALID_REQUEST", "fiat.currency must be an ISO 4217 uppercase code");
  }
  if (amountValue === undefined) {
    throw serviceError(400, "INVALID_REQUEST", "fiat.value must be a decimal string");
  }
  return {
    currency,
    value: amountValue,
  };
}

function parseBitcoinAmount(value: unknown): OpenReceiveBitcoinAmount {
  const record = parseOptionalRecord(value, "amount");
  if (record === undefined) {
    throw serviceError(400, "INVALID_REQUEST", "amount must be a JSON object.");
  }
  const currency = optionalString(record.currency);
  const amountValue = optionalString(record.value);
  if (currency === undefined || !["BTC", "SAT", "SATS"].includes(currency)) {
    throw serviceError(
      400,
      "INVALID_REQUEST",
      "amount.currency must be BTC, SAT, or SATS. Use fiat for price-feed currencies.",
    );
  }
  if (amountValue === undefined) {
    throw serviceError(400, "INVALID_REQUEST", "amount.value must be a decimal string");
  }
  return {
    currency: currency as OpenReceiveBitcoinAmount["currency"],
    value: amountValue,
  };
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
    throw serviceError(500, "INTERNAL", `${field} is outside JavaScript safe integer bounds.`);
  }
  return numberValue;
}

function createStoredInvoiceId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `or_inv_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function createCheckoutId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `or_chk_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function currentUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function serviceError(
  status: number,
  code: OpenReceiveErrorCode,
  message: string,
): OpenReceiveServiceError {
  return new OpenReceiveServiceError(status, {
    code,
    message,
  });
}
