import { OPENRECEIVE_NWC_METADATA_MAX_BYTES } from "@openreceive/core";
import {
  getCreateDescriptionFields,
  createAmountRequest,
  normalizeCreateCheckoutAmount,
  normalizeCreateCheckoutRequest,
} from "./requests.ts";
import { resolveCreateAmount } from "./pricing.ts";
import { serviceError } from "./core-utils.ts";
import { emitLog } from "./logging.ts";
import type {
  CheckoutInvoice,
  CreateCheckoutAmount,
  CreateCheckoutRequest,
  OpenReceiveRateQuote,
  OpenReceiveServiceContext,
} from "./types.ts";

export const OPENRECEIVE_INVOICE_EXPIRY_SECONDS = 10 * 60;

/**
 * Maximum seconds the wallet's returned invoice expiry may deviate from the
 * requested expiry. A wallet that ignores the requested expiry would leave
 * OpenReceive tracking an invoice whose real payable window differs from its
 * ledger row, so checkout creation fails closed instead.
 */
export const OPENRECEIVE_INVOICE_EXPIRY_TOLERANCE_SECONDS = 60;

export interface PrepareCheckoutResult {
  readonly amountMsats: number;
  readonly fiatQuote: OpenReceiveRateQuote | null;
}

/** Resolve the host order amount to msats without minting a Lightning invoice. */
export async function prepareCheckout(
  context: OpenReceiveServiceContext,
  input: { readonly amount: CreateCheckoutAmount },
): Promise<PrepareCheckoutResult> {
  const resolved = await resolveCreateAmount({
    body: createAmountRequest(normalizeCreateCheckoutAmount(input.amount)),
    now: context.clock(),
    priceProviders: context.priceProviders,
    priceCurrencies: context.priceCurrencies,
  });
  return {
    amountMsats: resolved.amount_msats,
    fiatQuote: resolved.fiat_quote,
  };
}

export async function createCheckout(
  context: OpenReceiveServiceContext,
  request: CreateCheckoutRequest,
): Promise<CheckoutInvoice> {
  const input = normalizeCreateCheckoutRequest(request);
  const now = context.clock();
  const resolved = await resolveCreateAmount({
    body: createAmountRequest(input.amount),
    now,
    priceProviders: context.priceProviders,
    priceCurrencies: context.priceCurrencies,
  });
  const expiry = input.expiry_seconds ?? OPENRECEIVE_INVOICE_EXPIRY_SECONDS;
  // order_id is spread last so caller metadata can never override it
  // (matches the Ruby server's merge precedence).
  const metadata = {
    ...(input.metadata ?? {}),
    order_id: input.order_id,
  };
  if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > OPENRECEIVE_NWC_METADATA_MAX_BYTES) {
    throw serviceError(400, "INVALID_REQUEST", "metadata is too large for NIP-47.");
  }
  const walletInvoice = await context.options.client.makeInvoice({
    amount_msats: BigInt(resolved.amount_msats),
    ...getCreateDescriptionFields({
      memo: input.memo,
      descriptionHash: input.description_hash,
    }),
    expiry,
    metadata,
  });
  // The wallet is trusted to mint what we asked for: the amount it reports is
  // the amount recorded on the checkout, so the ledger row always matches the
  // invoice the payer is shown (the Ruby engine does the same).
  const createdAt = walletInvoice.created_at ?? now;
  // The wallet must honor the requested expiry. An invoice whose real payable
  // window differs from our ledger row would either die under the payer early
  // or stay payable after reconciliation closed the attempt, so a wallet that
  // ignores `expiry` (beyond a small tolerance) fails checkout creation.
  const requestedExpiresAt = createdAt + expiry;
  const expiresAt = walletInvoice.expires_at ?? requestedExpiresAt;
  if (Math.abs(expiresAt - requestedExpiresAt) > OPENRECEIVE_INVOICE_EXPIRY_TOLERANCE_SECONDS) {
    emitLog(
      context.options,
      "error",
      "checkout.invoice_expiry.rejected",
      `The wallet did not honor the requested invoice expiry (requested ${expiry}s, got ${expiresAt - createdAt}s). Use a wallet whose make_invoice honors expiry.`,
      {
        order_id: input.order_id,
        payment_hash: walletInvoice.payment_hash.toLowerCase(),
        requested_expiry_seconds: expiry,
        actual_expiry_seconds: expiresAt - createdAt,
        tolerance_seconds: OPENRECEIVE_INVOICE_EXPIRY_TOLERANCE_SECONDS,
      },
    );
    throw serviceError(
      502,
      "UNSUPPORTED_METHOD",
      "Error with the backing NWC wallet: it did not honor the requested invoice expiry.",
    );
  }
  return {
    orderId: input.order_id,
    paymentHash: walletInvoice.payment_hash.toLowerCase(),
    bolt11: walletInvoice.invoice,
    amountMsats: toSafeInteger(walletInvoice.amount_msats, "amount_msats"),
    createdAt,
    expiresAt,
    fiatQuote: resolved.fiat_quote,
  };
}

function toSafeInteger(value: bigint, field: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw serviceError(502, "INTERNAL", `${field} is outside the JSON safe integer range.`);
  }
  return Number(value);
}
