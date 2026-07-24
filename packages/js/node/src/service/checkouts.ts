import { OPENRECEIVE_NWC_METADATA_MAX_BYTES } from "@openreceive/core";
import { getCreateDescriptionFields, createAmountRequest, normalizeCreateCheckoutRequest } from "./requests.ts";
import { resolveCreateAmount } from "./pricing.ts";
import { serviceError } from "./core-utils.ts";
import type {
  Checkout,
  CreateCheckoutRequest,
  OpenReceiveServiceContext,
} from "./types.ts";

export const OPENRECEIVE_INVOICE_EXPIRY_SECONDS = 10 * 60;

export async function createCheckout(
  context: OpenReceiveServiceContext,
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
  const expiry = input.expiry_seconds ?? OPENRECEIVE_INVOICE_EXPIRY_SECONDS;
  const metadata = {
    order_id: input.order_id,
    ...(input.metadata ?? {}),
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
  const createdAt = walletInvoice.created_at ?? now;
  const expiresAt = walletInvoice.expires_at ?? createdAt + expiry;
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
