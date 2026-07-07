import {
  createIdempotencyRequestHash,
  getIdempotentRecord,
  type OpenReceiveIdempotencyScope,
  putCreatedInvoiceRecord,
  type StoredRecord,
  sweepPendingInvoicesOnce,
} from "@openreceive/core";
import {
  createCheckoutId,
  createStoredInvoiceId,
  parseOptionalRecord,
  readOpenReceiveNamespace,
  serviceError,
  toSafeInteger,
} from "./core-utils.ts";
import { emitLog, invoiceLogFields } from "./logging.ts";
import {
  buildOrder,
  currentOpenCheckout,
  groupCheckouts,
  readStoredCheckoutId,
  requireCheckout,
  retryBaseCheckout,
} from "./models.ts";
import { resolveCreateAmount } from "./pricing.ts";
import { reconcileOptions } from "./reconcile.ts";
import {
  amountKeyFromCreateAmount,
  createAmountRequest,
  getCreateDescriptionFields,
  normalizeCreateCheckoutRequest,
  parseGetCheckoutId,
  parseGetOrderId,
  readCreateAmountKind,
} from "./requests.ts";
import { advanceSwapsForOrder, advanceSwapsForRecords } from "./swaps.ts";
import type {
  NormalizedCreateCheckoutRequest,
  OpenReceiveCheckoutModel,
  OpenReceiveCreateCheckoutAmount,
  OpenReceiveCreateCheckoutRequest,
  OpenReceiveGetCheckoutRequest,
  OpenReceiveGetOrderRequest,
  OpenReceiveOrderModel,
  OpenReceiveServiceContext,
} from "./types.ts";

export const OPENRECEIVE_INVOICE_EXPIRY_SECONDS = 600;

export const RESERVED_CHECKOUT_METADATA_KEYS = new Set([
  "order_id",
  "checkout_id",
  "superseded",
  "amount_spec",
  "memo",
  "description_hash",
  "rail",
  "swap",
  "swap_private",
  "swap_attempt_key",
]);

export async function createCheckout(
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

export async function getOrder(
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

export async function getCheckout(
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

export async function mintInvoiceForCheckout(
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

export function checkoutMetadata(
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

export function checkoutPassthroughMetadata(
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

export async function amountMatches(
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

export function createCheckoutRequestHashBody(
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

export async function supersedeCheckout(
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

export function scheduleBestEffortSweep(context: OpenReceiveServiceContext): void {
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
