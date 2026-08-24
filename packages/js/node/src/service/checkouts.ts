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
  Checkout,
  CreateCheckoutAmount,
  CreateCheckoutRequest,
  RateQuote,
  ServiceContext,
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
  readonly fiatQuote: RateQuote | null;
}

/** Resolve the host order amount to msats without minting a Lightning invoice. */
export async function prepareCheckout(
  context: ServiceContext,
  input: { readonly amount: CreateCheckoutAmount },
): Promise<PrepareCheckoutResult> {
  const resolved = await resolveCreateAmount({
    body: createAmountRequest(normalizeCreateCheckoutAmount(input.amount)),
    now: context.clock(),
    priceProviders: context.priceProviders,
    priceCurrencies: context.priceCurrencies,
  });
  return {
    amountMsats: resolved.amountMsats,
    fiatQuote: resolved.fiatQuote,
  };
}

export async function createCheckout(
  context: ServiceContext,
  request: CreateCheckoutRequest,
): Promise<Checkout> {
  const input = normalizeCreateCheckoutRequest(request);
  const now = context.clock();
  const resolved = await resolveCreateAmount({
    body: createAmountRequest(input.amount),
    now,
    priceProviders: context.priceProviders,
    priceCurrencies: context.priceCurrencies,
  });
  const expiry = input.expirySeconds ?? OPENRECEIVE_INVOICE_EXPIRY_SECONDS;
  // reference is spread last so caller metadata can never override it
  // (matches the Ruby server's merge precedence).
  const metadata = {
    ...(input.metadata ?? {}),
    reference: input.reference,
  };
  if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > OPENRECEIVE_NWC_METADATA_MAX_BYTES) {
    throw serviceError(400, "INVALID_REQUEST", "metadata is too large for NIP-47.");
  }
  const walletInvoice = await context.options.client.makeInvoice({
    amount_msats: BigInt(resolved.amountMsats),
    ...getCreateDescriptionFields({
      memo: input.memo,
      descriptionHash: input.descriptionHash,
    }),
    expiry,
    metadata,
  });
  // The wallet is trusted to mint what we asked for: the amount it reports is
  // the amount recorded on the checkout, so the ledger row always matches the
  // invoice the payer is shown (the Ruby engine does the same).
  const createdAt = walletInvoice.created_at ?? now;
  // The ledger row stores the wallet's OWN expires_at, so reuse buffering,
  // reconciliation, and the expiry+grace close rule all stay consistent with
  // the real invoice even when the wallet clamps expiry to its own min/max. A
  // deviation is therefore a warning on the plain checkout path, not a refusal
  // — refusing would lock every such wallet out of checkouts entirely.
  //
  // A caller-supplied `expirySeconds` is different: it is a FLOOR. Only the
  // swap path sets it, from provider.invoiceExpirySeconds, because the shadow
  // invoice must outlive the provider order — an invoice that dies first
  // strands a deposit the payer has already sent. A short invoice fails there.
  const requestedExpiresAt = createdAt + expiry;
  const expiresAt = walletInvoice.expires_at ?? requestedExpiresAt;
  const shortfall = requestedExpiresAt - expiresAt;
  if (Math.abs(expiresAt - requestedExpiresAt) > OPENRECEIVE_INVOICE_EXPIRY_TOLERANCE_SECONDS) {
    const requiredFloor =
      input.expirySeconds !== undefined && shortfall > OPENRECEIVE_INVOICE_EXPIRY_TOLERANCE_SECONDS;
    emitLog(
      context.options,
      requiredFloor ? "error" : "warn",
      requiredFloor ? "checkout.invoice_expiry.rejected" : "checkout.invoice_expiry.adjusted",
      requiredFloor
        ? `The wallet did not honor the required invoice expiry (required ${expiry}s, got ${expiresAt - createdAt}s). Use a wallet whose make_invoice honors expiry.`
        : `The wallet clamped the requested invoice expiry (requested ${expiry}s, got ${expiresAt - createdAt}s); the wallet's own expiry is recorded on the attempt.`,
      {
        reference: input.reference,
        payment_hash: walletInvoice.payment_hash.toLowerCase(),
        requested_expiry_seconds: expiry,
        actual_expiry_seconds: expiresAt - createdAt,
        tolerance_seconds: OPENRECEIVE_INVOICE_EXPIRY_TOLERANCE_SECONDS,
      },
    );
    if (requiredFloor) {
      throw serviceError(
        502,
        "UNSUPPORTED_METHOD",
        "Error with the backing NWC wallet: it did not honor the requested invoice expiry.",
      );
    }
  }
  return {
    reference: input.reference,
    paymentHash: walletInvoice.payment_hash.toLowerCase(),
    bolt11: walletInvoice.invoice,
    amountMsats: toSafeInteger(walletInvoice.amount_msats, "amount_msats"),
    createdAt,
    expiresAt,
    fiatQuote: resolved.fiatQuote,
  };
}

function toSafeInteger(value: bigint, field: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw serviceError(502, "INTERNAL", `${field} is outside the JSON safe integer range.`);
  }
  return Number(value);
}
