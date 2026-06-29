import {
  OPENRECEIVE_PRICE_FEED_FALLBACK_URL_ENV,
  OPENRECEIVE_PRICE_FEED_PRIMARY_URL_ENV,
  createCachedLivePriceFeed,
  createIdempotencyRequestHash,
  getBtcFiatRatesWithFallback,
  getIdempotentRecord,
  isHealthCheckablePriceFeed,
  isOpenReceiveErrorCode,
  isResolvedPriceProvider,
  putCreatedInvoiceRecord,
  quoteBitcoinAmountToMsats,
  quoteFiatToMsatsWithPrice,
  refreshInvoiceRecordsStatus as refreshStoredInvoiceRecordsStatus,
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
  type OpenReceiveSourcedPriceProvider,
  type StoredRecord,
} from "@openreceive/core";
import { formatOpenReceiveMissingNwcMessage } from "@openreceive/core";
import { createNwcReceiveClient } from "./alby-nwc.ts";
import { OpenReceiveConfigError, type OpenReceiveConfigErrorCode } from "./config-error.ts";
import { assertOpenReceiveStoreConfiguration } from "./storage-guard.ts";
import { resolveOpenReceiveStore, type ResolveOpenReceiveStoreOptions } from "./store-uri.ts";

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
  onEvent?: OpenReceiveEventHandler;
  logger?: OpenReceiveLogger;
  clock?: () => number;
  actionLeaseTtlSeconds?: number;
  transactionScanIntervalSeconds?: number;
  transactionScanPageLimit?: number;
  transactionScanWindowPaddingSeconds?: number;
  transactionScanTimeoutMs?: number;
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

export interface OpenReceiveCreateCheckoutRequest {
  readonly orderId: string;
  readonly amount: OpenReceiveCreateInvoiceAmount;
  readonly memo?: string;
  readonly descriptionHash?: string;
  readonly expiresInSeconds?: number | string;
}

export type OpenReceiveCreateInvoiceAmount =
  | { readonly btc: OpenReceiveBitcoinAmount }
  | { readonly sats: number | string }
  | { readonly msats: number | string }
  | { readonly fiat: OpenReceiveFiatAmount };

export interface OpenReceiveGetOrderRequest {
  readonly orderId: string;
}

export interface OpenReceiveGetCheckoutRequest {
  readonly checkoutId: string;
}

export interface OpenReceiveInvoice {
  readonly invoiceId: string;
  readonly type: "incoming";
  readonly status: "pending" | "settled" | "expired" | "failed";
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
}

export interface OpenReceiveCheckout {
  readonly checkoutId: string;
  readonly orderId: string;
  readonly status: "open" | "superseded" | "paid" | "expired";
  readonly amountMsats: number;
  readonly fiat?: {
    readonly currency: string;
    readonly value: string;
  };
  readonly active?: OpenReceiveInvoice;
  readonly invoices: readonly OpenReceiveInvoice[];
  readonly paidAt?: number;
  readonly createdAt: number;
}

export interface OpenReceiveOrder {
  readonly orderId: string;
  readonly status: "pending" | "paid" | "expired";
  readonly paid: boolean;
  readonly paidAt?: number;
  readonly paidCheckout?: OpenReceiveCheckout;
  readonly activeCheckout?: OpenReceiveCheckout;
  readonly checkouts: readonly OpenReceiveCheckout[];
  readonly walletScanPerformed: boolean;
  readonly transactionsChecked: number;
}

export interface OpenReceive {
  readonly store: OpenReceiveInvoiceKvStore;
  createCheckout(input: OpenReceiveCreateCheckoutRequest): Promise<OpenReceiveCheckout>;
  getOrder(input: OpenReceiveGetOrderRequest): Promise<OpenReceiveOrder>;
  getCheckout(input: OpenReceiveGetCheckoutRequest): Promise<OpenReceiveCheckout>;
  listRates(): Promise<OpenReceiveBtcFiatRateMapWithSource["rates"]>;
  quoteRates(input: { readonly fiat: OpenReceiveFiatAmount }): Promise<OpenReceiveRateQuote>;
  close(): Promise<void>;
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
}

interface ResolvedCreateAmount {
  amount_msats: number;
  amount_source: "amount" | "amount_sats" | "amount_msats" | "fiat";
  fiat_quote: OpenReceiveRateQuote | null;
}

const HEX_64 = /^[0-9a-fA-F]{64}$/;

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
  const priceCurrencies = options.priceCurrencies ?? ["USD"];
  const priceProviders = options.priceProviders ?? [
    createOpenReceivePriceFeed({
      store,
      currencies: priceCurrencies,
      fetch: options.priceFetch,
      clock: options.clock,
    }),
  ];

  const context: OpenReceiveServiceContext = {
    options: nodeOptions,
    store,
    clock: options.clock ?? currentUnixSeconds,
    priceProviders,
    priceCurrencies,
  };

  await assertPriceFeedBootHealthy(context);

  return {
    store,
    async createCheckout(input) {
      return await runOpenReceiveOperation(context, () => createCheckout(context, input));
    },
    async getOrder(input) {
      return await runOpenReceiveOperation(context, () => getOrder(context, input));
    },
    async getCheckout(input) {
      return await runOpenReceiveOperation(context, () => getCheckout(context, input));
    },
    async listRates() {
      return await runOpenReceiveOperation(context, () => listRates(context));
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
): Promise<OpenReceiveCheckout> {
  const orderId = parseCreateCheckoutOrderId(input);
  const now = context.clock();
  const records = await context.store.listByOrderId(orderId);
  const checkouts = groupCheckouts(records, now);
  const paidCheckout = checkouts.find((checkout) => checkout.status === "paid");

  if (paidCheckout !== undefined) {
    return paidCheckout;
  }

  const open = currentOpenCheckout(checkouts);
  if (open !== undefined && (await amountMatches(context, input.amount, open, now))) {
    if (open.active !== undefined) {
      return open;
    }

    await mintInvoiceForCheckout(context, {
      continueCheckout: open,
      now,
    });
    return requireCheckout(
      groupCheckouts(await context.store.listByOrderId(orderId), now),
      open.checkoutId,
    );
  }

  const supersededId = open?.checkoutId;
  if (open !== undefined) {
    await supersedeCheckout(context, open);
  }

  const checkoutId = createCheckoutId();
  const minted = await mintInvoiceForCheckout(context, {
    newCheckout: {
      orderId,
      checkoutId,
      input,
      supersededId,
    },
    now,
  });

  return requireCheckout(
    groupCheckouts(await context.store.listByOrderId(orderId), now),
    readStoredCheckoutId(minted.row),
  );
}

async function getOrder(
  context: OpenReceiveServiceContext,
  input: OpenReceiveGetOrderRequest,
): Promise<OpenReceiveOrder> {
  const orderId = parseGetOrderId(input);
  const records = await context.store.listByOrderId(orderId);
  if (records.length === 0) {
    throw serviceError(404, "NOT_FOUND", "No order found for the given orderId.");
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

  const result = await refreshStoredInvoiceRecordsStatus({
    ...reconcileOptions(context),
    records,
  });
  const fresh = await context.store.listByOrderId(orderId);
  emitLog(context.options, "debug", "order.status.result", "Order status refresh completed.", {
    order_id: orderId,
    invoice_count: fresh.length,
    reason: result.reason,
    wallet_scan_performed: result.wallet_scan_performed,
    transactions_checked: result.transactions_checked,
  });

  return buildOrder(
    fresh,
    {
      walletScanPerformed: result.wallet_scan_performed,
      transactionsChecked: result.transactions_checked,
    },
    context.clock(),
  );
}

async function getCheckout(
  context: OpenReceiveServiceContext,
  input: OpenReceiveGetCheckoutRequest,
): Promise<OpenReceiveCheckout> {
  const checkoutId = parseGetCheckoutId(input);
  const records = await context.store.listByCheckoutId(checkoutId);
  if (records.length === 0) {
    throw serviceError(404, "NOT_FOUND", "No checkout found for the given checkoutId.");
  }
  return requireCheckout(groupCheckouts(records, context.clock()), checkoutId);
}

async function mintInvoiceForCheckout(
  context: OpenReceiveServiceContext,
  input: {
    readonly newCheckout?: {
      readonly orderId: string;
      readonly checkoutId: string;
      readonly input: OpenReceiveCreateCheckoutRequest;
      readonly supersededId?: string;
    };
    readonly continueCheckout?: OpenReceiveCheckout;
    readonly now: number;
  },
): Promise<StoredRecord> {
  if ((input.newCheckout === undefined) === (input.continueCheckout === undefined)) {
    throw serviceError(
      500,
      "INTERNAL",
      "Checkout invoice mint requires exactly one checkout mode.",
    );
  }

  const renewalRecords =
    input.continueCheckout === undefined
      ? []
      : await context.store.listByCheckoutId(input.continueCheckout.checkoutId);
  const renewal = renewalRecords[0];
  if (input.continueCheckout !== undefined && renewal === undefined) {
    throw serviceError(404, "NOT_FOUND", "No checkout found for the given checkoutId.");
  }

  const firstCreate = input.newCheckout !== undefined;
  const createInput = input.newCheckout?.input;
  const orderId = input.newCheckout?.orderId ?? readStoredOrderId(requiredValue(renewal).row);
  const checkoutId =
    input.newCheckout?.checkoutId ?? readStoredCheckoutId(requiredValue(renewal).row);
  const requestHashBody = firstCreate
    ? createCheckoutRequestHashBody(requiredValue(createInput))
    : createRenewalRequestHashBody(checkoutId, requiredValue(renewal).row.invoice_id);
  const operation = firstCreate ? "invoice.create" : "invoice.renew";
  const idempotencyKey = firstCreate
    ? `${orderId}:super:${requiredValue(input.newCheckout).supersededId ?? "none"}:amt:${amountKeyFromCreateAmount(requiredValue(createInput).amount)}`
    : `${checkoutId}:after:${requiredValue(renewal).row.invoice_id}`;
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
      firstCreate ? "checkout.create.replayed" : "checkout.renew.replayed",
      "Replayed existing invoice for idempotent checkout request.",
      invoiceLogFields(existing.record.row),
    );
    return existing.record;
  }

  const resolved = await resolveCheckoutInvoiceAmount({
    context,
    input: createInput,
    renewal,
    now: input.now,
  });
  const descriptionFields = checkoutDescriptionFields(createInput, renewal);
  const expiry = checkoutExpiry(createInput, renewal);
  emitLog(
    context.options,
    "info",
    firstCreate ? "checkout.create.requested" : "checkout.renew.requested",
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
    expiry,
  });
  const createdAt = walletInvoice.created_at ?? context.clock();
  const requestedExpirySeconds = expiry ?? 600;
  const expiresAt = walletInvoice.expires_at ?? createdAt + requestedExpirySeconds;
  const normalizedExpiresAt = Math.min(expiresAt, createdAt + requestedExpirySeconds);
  const metadata = checkoutMetadata(createInput, orderId, checkoutId, renewal);
  const createResult = await putCreatedInvoiceRecord({
    store: context.store,
    createInvoiceId,
    record: {
      rev: 0,
      row: {
        invoice_id: createInvoiceId(),
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
        ...(renewal === undefined ? {} : { refreshed_from_invoice_id: renewal.row.invoice_id }),
        metadata,
        fiat_quote: resolved.fiat_quote === null ? null : { ...resolved.fiat_quote },
      },
    },
  });
  emitLog(
    context.options,
    "info",
    firstCreate ? "checkout.created" : "checkout.renewed",
    "Created Lightning invoice for checkout.",
    {
      ...invoiceLogFields(createResult.record.row),
      order_id: orderId,
      checkout_id: checkoutId,
      ...(renewal === undefined ? {} : { old_invoice_id: renewal.row.invoice_id }),
    },
  );

  return createResult.record;
}

async function resolveCheckoutInvoiceAmount(input: {
  context: OpenReceiveServiceContext;
  input: OpenReceiveCreateCheckoutRequest | undefined;
  renewal: StoredRecord | undefined;
  now: number;
}): Promise<ResolvedCreateAmount> {
  if (input.renewal === undefined) {
    return await resolveCreateAmount({
      body: createAmountRequest(requiredValue(input.input).amount),
      now: input.now,
      priceProviders: input.context.priceProviders,
      priceCurrencies: input.context.priceCurrencies,
    });
  }

  const amountSpec = readStoredAmountSpec(input.renewal.row);
  if (amountSpec !== undefined && "fiat" in amountSpec) {
    return await resolveCreateAmount({
      body: { fiat: amountSpec.fiat },
      now: input.now,
      priceProviders: input.context.priceProviders,
      priceCurrencies: input.context.priceCurrencies,
    });
  }

  return {
    amount_msats: input.renewal.row.amount_msats,
    amount_source: "amount_msats",
    fiat_quote: null,
  };
}

function checkoutDescriptionFields(
  input: OpenReceiveCreateCheckoutRequest | undefined,
  renewal: StoredRecord | undefined,
): {
  readonly description?: string;
  readonly description_hash?: string;
} {
  if (renewal === undefined) {
    return getCreateDescriptionFields({
      memo: requiredValue(input).memo,
      descriptionHash: requiredValue(input).descriptionHash,
    });
  }
  return getCreateDescriptionFields({
    ...(optionalString(renewal.row.metadata.memo) === undefined
      ? {}
      : { memo: optionalString(renewal.row.metadata.memo) }),
    ...(optionalString(renewal.row.metadata.description_hash) === undefined
      ? {}
      : { descriptionHash: optionalString(renewal.row.metadata.description_hash) }),
  });
}

function checkoutExpiry(
  input: OpenReceiveCreateCheckoutRequest | undefined,
  renewal: StoredRecord | undefined,
): number | undefined {
  if (renewal === undefined) {
    return optionalSafeInteger(requiredValue(input).expiresInSeconds);
  }
  return optionalSafeInteger(renewal.row.metadata.expires_in_seconds);
}

function checkoutMetadata(
  input: OpenReceiveCreateCheckoutRequest | undefined,
  orderId: string,
  checkoutId: string,
  renewal: StoredRecord | undefined,
): Record<string, unknown> {
  const amountSpec =
    renewal === undefined
      ? structuredClone(requiredValue(input).amount)
      : (readStoredAmountSpec(renewal.row) ?? { msats: renewal.row.amount_msats });
  const memo =
    renewal === undefined ? requiredValue(input).memo : optionalString(renewal.row.metadata.memo);
  const descriptionHash =
    renewal === undefined
      ? requiredValue(input).descriptionHash
      : optionalString(renewal.row.metadata.description_hash);
  const expiresInSeconds =
    renewal === undefined
      ? requiredValue(input).expiresInSeconds
      : renewal.row.metadata.expires_in_seconds;

  return {
    order_id: orderId,
    checkout_id: checkoutId,
    amount_spec: structuredClone(amountSpec),
    ...(memo === undefined ? {} : { memo }),
    ...(descriptionHash === undefined ? {} : { description_hash: descriptionHash }),
    ...(expiresInSeconds === undefined ? {} : { expires_in_seconds: expiresInSeconds }),
  };
}

function createRenewalRequestHashBody(
  checkoutId: string,
  afterInvoiceId: string,
): Record<string, unknown> {
  return {
    checkoutId,
    after: afterInvoiceId,
  };
}

async function amountMatches(
  context: OpenReceiveServiceContext,
  amount: OpenReceiveCreateInvoiceAmount,
  checkout: OpenReceiveCheckout,
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

function readStoredAmountSpec(row: InvoiceStorageRow): OpenReceiveCreateInvoiceAmount | undefined {
  const value = row.metadata.amount_spec;
  if (!isRecord(value)) return undefined;
  if (isRecord(value.btc)) {
    return {
      btc: value.btc as unknown as OpenReceiveBitcoinAmount,
    };
  }
  if (value.sats !== undefined) {
    return {
      sats: value.sats as number | string,
    };
  }
  if (value.msats !== undefined) {
    return {
      msats: value.msats as number | string,
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

function createAmountRequest(amount: OpenReceiveCreateInvoiceAmount): Record<string, unknown> {
  return {
    ...("btc" in amount ? { amount: amount.btc } : {}),
    ...("sats" in amount ? { amount_sats: amount.sats } : {}),
    ...("msats" in amount ? { amount_msats: amount.msats } : {}),
    ...("fiat" in amount ? { fiat: amount.fiat } : {}),
  };
}

function createCheckoutRequestHashBody(input: OpenReceiveCreateCheckoutRequest): Record<string, unknown> {
  return {
    orderId: input.orderId,
    amount: structuredClone(input.amount),
    ...(input.memo === undefined ? {} : { memo: input.memo }),
    ...(input.descriptionHash === undefined ? {} : { descriptionHash: input.descriptionHash }),
    ...(input.expiresInSeconds === undefined ? {} : { expiresInSeconds: input.expiresInSeconds }),
  };
}

function amountKeyFromCreateAmount(amount: OpenReceiveCreateInvoiceAmount): string {
  if ("fiat" in amount) {
    return `fiat:${amount.fiat.currency}:${amount.fiat.value}`;
  }
  if ("sats" in amount) {
    return `sats:${String(amount.sats)}`;
  }
  if ("msats" in amount) {
    return `msats:${String(amount.msats)}`;
  }
  return `btc:${amount.btc.currency}:${amount.btc.value}`;
}

function scanlessOrderMeta(): Pick<
  OpenReceiveOrder,
  "walletScanPerformed" | "transactionsChecked"
> {
  return {
    walletScanPerformed: false,
    transactionsChecked: 0,
  };
}

function buildOrder(
  records: readonly StoredRecord[],
  scanMeta: Pick<OpenReceiveOrder, "walletScanPerformed" | "transactionsChecked">,
  now: number,
): OpenReceiveOrder {
  if (records.length === 0) {
    throw serviceError(500, "INTERNAL", "Order has no invoices.");
  }
  const checkouts = groupCheckouts(records, now);
  const paidCheckout = checkouts.find((checkout) => checkout.status === "paid");
  const activeCheckout = currentOpenCheckout(checkouts);
  const paid = paidCheckout !== undefined;
  const status: OpenReceiveOrder["status"] = paid
    ? "paid"
    : activeCheckout !== undefined
      ? "pending"
      : "expired";

  return {
    orderId: readStoredOrderId(records[0].row),
    status,
    paid,
    ...(paidCheckout?.paidAt === undefined ? {} : { paidAt: paidCheckout.paidAt }),
    ...(paidCheckout === undefined ? {} : { paidCheckout }),
    ...(activeCheckout === undefined ? {} : { activeCheckout }),
    checkouts,
    walletScanPerformed: scanMeta.walletScanPerformed,
    transactionsChecked: scanMeta.transactionsChecked,
  };
}

function groupCheckouts(records: readonly StoredRecord[], now: number): OpenReceiveCheckout[] {
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
): OpenReceiveCheckout {
  const sortedRecords = [...records].sort((left, right) =>
    left.row.created_at === right.row.created_at
      ? right.row.invoice_id.localeCompare(left.row.invoice_id)
      : right.row.created_at - left.row.created_at,
  );
  const invoices = sortedRecords.map((record) => serializeInvoice(record.row));
  const paidInvoice = invoices.find((invoice) => invoice.status === "settled");
  const superseded = sortedRecords.some((record) => record.row.metadata.superseded === true);
  const status: OpenReceiveCheckout["status"] =
    paidInvoice !== undefined
      ? "paid"
      : superseded
        ? "superseded"
        : invoices.every((invoice) => invoice.status === "expired" || invoice.status === "failed")
          ? "expired"
          : "open";
  const active =
    status === "open"
      ? invoices.find((invoice) => invoice.status === "pending" && invoice.expiresAt > now)
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
  checkouts: readonly OpenReceiveCheckout[],
): OpenReceiveCheckout | undefined {
  return checkouts.find((checkout) => checkout.status === "open");
}

function requireCheckout(
  checkouts: readonly OpenReceiveCheckout[],
  checkoutId: string,
): OpenReceiveCheckout {
  const checkout = checkouts.find((candidate) => candidate.checkoutId === checkoutId);
  if (checkout === undefined) {
    throw serviceError(500, "INTERNAL", "Created checkout was not readable.");
  }
  return checkout;
}

async function supersedeCheckout(
  context: OpenReceiveServiceContext,
  checkout: OpenReceiveCheckout,
): Promise<void> {
  const records = await context.store.listByCheckoutId(checkout.checkoutId);
  for (const record of records) {
    const superseded: StoredRecord = {
      rev: record.rev + 1,
      row: {
        ...record.row,
        transaction_state:
          record.row.transaction_state === "settled" ? record.row.transaction_state : "expired",
        workflow_state:
          record.row.transaction_state === "settled"
            ? record.row.workflow_state
            : "expiry_pending_verification",
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

async function listRates(
  context: OpenReceiveServiceContext,
): Promise<OpenReceiveBtcFiatRateMapWithSource["rates"]> {
  try {
    const rates = await getBtcFiatRatesForProviders({
      currencies: context.priceCurrencies,
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
    });
  } catch (error) {
    if (error instanceof OpenReceiveConfigError) throw error;
    throw new OpenReceiveConfigError({
      code: "INVALID_NWC",
      message: "OpenReceive NWC configuration is invalid.",
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
    transactionScanTimeoutMs:
      context.options.transactionScanTimeoutMs ??
      readPositiveIntegerEnv("OPENRECEIVE_TRANSACTION_SCAN_TIMEOUT_MS"),
    settlementAction: async (input: OpenReceiveSettlementActionInput) => {
      // Delivered after backend-verified settlement, at least once. Apps must
      // dedupe fulfillment by invoice.payment_hash or their own order id.
      await context.options.onPaid?.({
        invoice: input.invoice,
        orderId: readStoredOrderId(input.invoice),
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

function serializeInvoice(row: InvoiceStorageRow): OpenReceiveInvoice {
  return {
    invoiceId: row.invoice_id,
    type: "incoming",
    status: deriveInvoiceStatus(row),
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
  };
}

function deriveInvoiceStatus(row: InvoiceStorageRow): OpenReceiveInvoice["status"] {
  if (row.settled_at !== undefined || row.transaction_state === "settled") {
    return "settled";
  }
  if (row.transaction_state === "expired" || row.workflow_state === "expired_closed") {
    return "expired";
  }
  if (row.transaction_state === "failed" || row.workflow_state === "failed_closed") {
    return "failed";
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
  if (options.onEvent === undefined && options.logger === undefined) return;

  const sanitized = sanitizeOpenReceiveEvent({
    level,
    event,
    message,
    ...fields,
  });

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
  const hasAmountSats = body.amount_sats !== undefined;
  const hasAmountMsats = body.amount_msats !== undefined;
  const hasFiat = body.fiat !== undefined;
  const sourceCount = [hasAmount, hasAmountSats, hasAmountMsats, hasFiat].filter(Boolean).length;

  if (sourceCount !== 1) {
    throw serviceError(
      400,
      "INVALID_REQUEST",
      "Create checkout request requires exactly one of amount.btc, amount.sats, amount.msats, or amount.fiat.",
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

  if (hasAmountSats) {
    const amountSats = optionalSafeInteger(body.amount_sats);
    if (amountSats === undefined) {
      throw serviceError(400, "INVALID_REQUEST", "amount.sats must be a safe integer.");
    }
    const amountMsats = amountSats * 1000;
    if (!Number.isSafeInteger(amountMsats)) {
      throw serviceError(
        400,
        "INVALID_REQUEST",
        "amount.sats is outside the safe integer boundary.",
      );
    }
    return {
      amount_msats: amountMsats,
      amount_source: "amount_sats",
      fiat_quote: null,
    };
  }

  if (hasAmountMsats) {
    const amountMsats = optionalSafeInteger(body.amount_msats);
    if (amountMsats === undefined) {
      throw serviceError(400, "INVALID_REQUEST", "amount.msats must be a safe integer.");
    }
    return {
      amount_msats: amountMsats,
      amount_source: "amount_msats",
      fiat_quote: null,
    };
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

// Refuses to boot when a configured live price feed cannot answer. Internal
// tests can pass explicit non-health-checking providers.
async function assertPriceFeedBootHealthy(context: OpenReceiveServiceContext): Promise<void> {
  for (const provider of context.priceProviders) {
    if (!isHealthCheckablePriceFeed(provider)) continue;
    try {
      await provider.healthCheck(context.priceCurrencies);
    } catch (error) {
      throw new OpenReceiveConfigError({
        code: "UNHEALTHY_PRICE_DATA",
        message: "OpenReceive refuses to boot because live price data is unhealthy.",
        hint: "Ensure the primary or fallback BTC fiat price feed can refresh, or configure explicit internal test priceProviders.",
        cause: error,
      });
    }
  }
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

function parseCreateCheckoutOrderId(input: OpenReceiveCreateCheckoutRequest): string {
  const body = asRecord(input);
  const orderId = optionalString(body.orderId);
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
  const checkoutId = optionalString(body.checkoutId);
  if (checkoutId === undefined) {
    throw serviceError(400, "INVALID_REQUEST", "checkoutId is required.");
  }
  if (checkoutId.length > 200) {
    throw serviceError(400, "INVALID_REQUEST", "checkoutId must be 200 characters or fewer.");
  }
  return checkoutId;
}

function parseGetOrderId(input: OpenReceiveGetOrderRequest): string {
  const body = asRecord(input);
  const orderId = optionalString(body.orderId);
  if (orderId === undefined) {
    throw serviceError(400, "INVALID_REQUEST", "orderId is required.");
  }
  if (orderId.length > 200) {
    throw serviceError(400, "INVALID_REQUEST", "orderId must be 200 characters or fewer.");
  }
  return orderId;
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

function optionalSafeInteger(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(numberValue) ? numberValue : undefined;
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

function createInvoiceId(): string {
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
