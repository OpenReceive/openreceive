import { createHash } from "node:crypto";
import {
  createIdempotencyRequestHash,
  getIdempotentRecord,
  type OpenReceiveIdempotencyScope,
  putCreatedInvoiceRecord,
  type StoredRecord,
  sweepPendingInvoicesOnce,
  isOpenReceiveBitcoinAmountCurrency,
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
  Checkout,
  CreateCheckoutAmount,
  CreateCheckoutRequest,
  GetCheckoutRequest,
  GetOrderRequest,
  Order,
  OpenReceiveServiceContext,
} from "./types.ts";

export const OPENRECEIVE_INVOICE_EXPIRY_SECONDS = 600;

/** Reuse a payer Lightning invoice only when more than this many seconds remain. */
export const OPENRECEIVE_LIGHTNING_REUSE_BUFFER_SECONDS = 60;

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
  input: CreateCheckoutRequest,
): Promise<Checkout> {
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
    if (!createInput.mint_lightning) {
      return open;
    }
    if (open.active !== undefined && isReusableLightningInvoice(open.active.expiresAt, now)) {
      return open;
    }
    if (open.active === undefined) {
      const minted = await mintInvoiceForCheckout(context, {
        existingCheckout: {
          orderId,
          checkoutId: open.checkoutId,
          input: createInput,
        },
        now,
      });
      scheduleBestEffortSweep(context);
      return requireCheckout(
        groupCheckouts(await context.store.listByOrderId(orderId), now),
        readStoredCheckoutId(minted.row),
      );
    }
    // Active invoice is within the reuse buffer — supersede and mint a fresh one below.
  }

  const supersededId = open?.checkoutId ?? retryBaseCheckout(checkouts)?.checkoutId;
  if (open !== undefined) {
    await supersedeCheckout(context, open);
  }

  const checkoutId = createCheckoutId();
  const minted = createInput.mint_lightning
    ? await mintInvoiceForCheckout(context, {
        newCheckout: {
          orderId,
          checkoutId,
          input: createInput,
          supersededId,
        },
        now,
      })
    : await mintCheckoutLock(context, {
        orderId,
        checkoutId,
        input: createInput,
        supersededId,
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

export function isReusableLightningInvoice(expiresAt: number, now: number): boolean {
  return expiresAt - now > OPENRECEIVE_LIGHTNING_REUSE_BUFFER_SECONDS;
}

export async function getOrder(
  context: OpenReceiveServiceContext,
  input: GetOrderRequest,
): Promise<Order> {
  const orderId = parseGetOrderId(input);
  const records = await context.store.listByOrderId(orderId);
  if (records.length === 0) {
    throw serviceError(404, "NOT_FOUND", "No order found for the given order_id.");
  }
  emitLog(
    context.options,
    "debug",
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
  input: GetCheckoutRequest,
): Promise<Checkout> {
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
    readonly newCheckout?: {
      readonly orderId: string;
      readonly checkoutId: string;
      readonly input: NormalizedCreateCheckoutRequest;
      readonly supersededId?: string;
    };
    readonly existingCheckout?: {
      readonly orderId: string;
      readonly checkoutId: string;
      readonly input: NormalizedCreateCheckoutRequest;
    };
    readonly now: number;
  },
): Promise<StoredRecord> {
  const target = input.newCheckout ?? input.existingCheckout;
  if (target === undefined) {
    throw serviceError(500, "INTERNAL", "mintInvoiceForCheckout requires a checkout target.");
  }
  const createInput = target.input;
  const orderId = target.orderId;
  const checkoutId = target.checkoutId;
  const requestHashBody = {
    ...createCheckoutRequestHashBody(createInput),
    mint_lightning: true,
    checkout_id: checkoutId,
  };
  const operation = "invoice.create";
  const idempotencyKey =
    input.existingCheckout !== undefined
      ? `${orderId}:checkout:${checkoutId}:lightning:amt:${amountKeyFromCreateAmount(createInput.amount)}`
      : `${orderId}:super:${input.newCheckout?.supersededId ?? "none"}:amt:${amountKeyFromCreateAmount(createInput.amount)}`;
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

/**
 * Lock a checkout amount without minting a payer-facing Lightning invoice. Used so altcoin
 * swaps can start (and mint only their shadow bolt11) before the payer ever chooses Bitcoin.
 */
export async function mintCheckoutLock(
  context: OpenReceiveServiceContext,
  input: {
    readonly orderId: string;
    readonly checkoutId: string;
    readonly input: NormalizedCreateCheckoutRequest;
    readonly supersededId?: string;
    readonly now: number;
  },
): Promise<StoredRecord> {
  const createInput = input.input;
  const orderId = input.orderId;
  const checkoutId = input.checkoutId;
  const requestHashBody = {
    ...createCheckoutRequestHashBody(createInput),
    mint_lightning: false,
  };
  const operation = "checkout.lock";
  const idempotencyKey = `${orderId}:super:${input.supersededId ?? "none"}:lock:amt:${amountKeyFromCreateAmount(createInput.amount)}`;
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
      "checkout.lock.replayed",
      "Replayed existing checkout amount lock.",
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
  const createdAt = input.now;
  const expiresAt = createdAt + OPENRECEIVE_INVOICE_EXPIRY_SECONDS;
  const paymentHash = createHash("sha256")
    .update(`openreceive:checkout_lock:${checkoutId}`)
    .digest("hex");
  const lockInvoice = `openreceive:checkout_lock:${checkoutId}`;
  const metadata = {
    ...checkoutMetadata(createInput, orderId, checkoutId),
    rail: "checkout_lock",
  };
  emitLog(context.options, "info", "checkout.lock.requested", "Locking checkout amount without Lightning invoice.", {
    order_id: orderId,
    checkout_id: checkoutId,
    amount_msats: resolved.amount_msats,
  });
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
        payment_hash: paymentHash,
        invoice: lockInvoice,
        amount_msats: resolved.amount_msats,
        transaction_state: "pending",
        workflow_state: "invoice_created",
        settlement_action_state: "pending",
        created_at: createdAt,
        expires_at: expiresAt,
        metadata,
        fiat_quote: resolved.fiat_quote === null ? null : { ...resolved.fiat_quote },
      },
    },
  });
  emitLog(context.options, "info", "checkout.locked", "Locked checkout amount without Lightning invoice.", {
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
  amount: CreateCheckoutAmount,
  checkout: Checkout,
  now: number,
): Promise<boolean> {
  const fiat =
    "currency" in amount &&
    amount.currency !== undefined &&
    !isOpenReceiveBitcoinAmountCurrency(amount.currency)
      ? { currency: amount.currency, value: amount.value }
      : undefined;

  if (fiat !== undefined || checkout.fiat !== undefined) {
    return (
      fiat !== undefined &&
      checkout.fiat !== undefined &&
      fiat.currency === checkout.fiat.currency &&
      fiat.value === checkout.fiat.value
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
  checkout: Checkout,
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
