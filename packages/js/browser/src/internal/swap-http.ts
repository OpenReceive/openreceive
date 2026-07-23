import { sanitizeBrowserLogEntry } from "./checkout.ts";
import type {
  CheckoutInvoiceSnapshot,
  OpenReceiveBrowserLogger,
  OpenReceiveBrowserLogLevel,
} from "./ui.ts";

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export interface PostOpenReceiveJsonOptions {
  readonly logger?: OpenReceiveBrowserLogger;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * POST JSON through the mounted swap route set. Legacy UI action names are translated
 * internally so framework packages do not expose the old order multiplexer on the wire.
 */
export async function postOpenReceiveJson(
  fetcher: typeof globalThis.fetch,
  url: string,
  body: Record<string, unknown>,
  headersOrOptions?: Readonly<Record<string, string>> | PostOpenReceiveJsonOptions,
): Promise<unknown> {
  const options = normalizePostOptions(headersOrOptions);
  const orderId = nonEmptyString(body.order_id);
  const action = nonEmptyString(body.action);
  emitSwapActionLog(options.logger, "requested", body);

  try {
    const result = action === "swap_quote"
        ? await requestJson(fetcher, `${routePrefix(url)}/swaps/quote`, {
          order_id: orderId,
          pay_in_asset: body.pay_in_asset,
        }, options)
      : action === "refund_swap"
        ? await refundRequest(fetcher, url, body, orderId, options)
        : await requestJson(fetcher, url, body, options);
    if (action === "start_swap" || action === "refund_swap") {
      emitSwapActionLog(options.logger, "succeeded", body, swapActionResultFields(result));
    }
    return result;
  } catch (error) {
    emitSwapActionLog(options.logger, "failed", body, {
      error_message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export function normalizeSwapStartInvoice(body: unknown): CheckoutInvoiceSnapshot {
  const outer = asRecord(body);
  const swap = asRecord(outer.swap ?? body);
  const checkout = asRecord(swap.checkout);
  const paymentHash = nonEmptyString(swap.payment_hash ?? checkout.payment_hash);
  if (
    paymentHash === undefined ||
    nonEmptyString(swap.provider) === undefined ||
    nonEmptyString(swap.pay_in_asset) === undefined ||
    nonEmptyString(swap.deposit_address) === undefined ||
    nonEmptyString(swap.deposit_amount) === undefined ||
    nonEmptyString(swap.provider_state) === undefined ||
    typeof swap.provider_expires_at !== "number"
  ) {
    throw new Error("Swap response did not include provider instructions.");
  }
  return {
    invoice_id: paymentHash,
    rail: "swap",
    payment_hash: paymentHash,
    ...(typeof checkout.amount_msats === "number" ? { amount_msats: checkout.amount_msats } : {}),
    transaction_state: "pending",
    workflow_state: "invoice_created",
    expires_at: swap.provider_expires_at,
    swap: {
      provider: swap.provider as string,
      pay_in_asset: swap.pay_in_asset as string,
      deposit_address: swap.deposit_address as string,
      deposit_amount: swap.deposit_amount as string,
      provider_state: swap.provider_state as NonNullable<CheckoutInvoiceSnapshot["swap"]>["provider_state"],
      provider_expires_at: swap.provider_expires_at,
      ...copyOptionalSwapFields(swap),
    },
  };
}

export const OPENRECEIVE_SWAP_ADDRESS_PREPARING_MESSAGE =
  "Swap payment address is still being prepared. Retry this swap start shortly.";

export function isOpenReceiveSwapAddressPreparingError(error: unknown): boolean {
  return (error instanceof Error ? error.message : String(error)).includes("still being prepared");
}

export async function startOpenReceiveSwapRequest(
  fetcher: typeof globalThis.fetch,
  url: string,
  orderId: string,
  payInAsset: string,
  options?: PostOpenReceiveJsonOptions,
): Promise<CheckoutInvoiceSnapshot> {
  const body = await requestJson(
    fetcher,
    `${routePrefix(url)}/swaps`,
    { order_id: orderId, pay_in_asset: payInAsset },
    options ?? {},
  );
  return normalizeSwapStartInvoice(body);
}

async function refundRequest(
  fetcher: typeof globalThis.fetch,
  url: string,
  body: Record<string, unknown>,
  orderId: string | undefined,
  options: PostOpenReceiveJsonOptions,
): Promise<unknown> {
  if (orderId === undefined) throw new Error("Swap refund requires order_id.");
  const refundAddress = nonEmptyString(body.refund_address);
  if (refundAddress === undefined) throw new Error("Swap refund requires refund_address.");
  const paymentHash = nonEmptyString(body.payment_hash);
  if (paymentHash === undefined) throw new Error("Swap refund requires payment_hash.");
  const prefix = routePrefix(url);
  if (body.confirm === true) {
    const status = asRecord(await requestJson(fetcher, `${prefix}/swaps/refunds`, {
      order_id: orderId,
      payment_hash: paymentHash,
      refund_address: refundAddress,
    }, options));
    return { swap: status };
  }
  const status = asRecord(await requestJson(fetcher, `${prefix}/swaps/status`, {
    order_id: orderId,
    payment_hash: paymentHash,
  }, options));
  return {
    swap: {
      ...status,
      // Confirmation is a browser UX step. Authorization and provider-state refresh
      // happen on the host when the confirmed refund request is submitted.
      refund_nonce: "confirm",
    },
  };
}

async function requestJson(
  fetcher: typeof globalThis.fetch,
  url: string,
  body: Record<string, unknown>,
  options: PostOpenReceiveJsonOptions,
): Promise<unknown> {
  const response = await fetcher(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
    body: JSON.stringify(body),
  });
  const parsed = await response.json();
  if (!response.ok) {
    const message = nonEmptyString(asRecord(parsed).message) ?? "OpenReceive request failed.";
    throw new Error(message);
  }
  return parsed;
}

function routePrefix(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  return trimmed.endsWith("/payments/check")
    ? trimmed.slice(0, -"/payments/check".length)
    : trimmed;
}

function copyOptionalSwapFields(swap: Record<string, unknown>): Partial<NonNullable<CheckoutInvoiceSnapshot["swap"]>> {
  const output: Record<string, unknown> = {};
  for (const key of [
    "deposit_memo", "deposit_tx_id", "payout_tx_id", "refund_tx_id", "refund_reason",
    "refund_amount", "attention", "attempt_id", "provider_order_id", "refund_address",
    "refund_nonce", "refund_nonce_expires_at", "attention_reason", "deposit_received_amount",
    "fee",
  ]) {
    if (swap[key] !== undefined) output[key] = swap[key];
  }
  return output as Partial<NonNullable<CheckoutInvoiceSnapshot["swap"]>>;
}

function normalizePostOptions(
  value: Readonly<Record<string, string>> | PostOpenReceiveJsonOptions | undefined,
): PostOpenReceiveJsonOptions {
  if (value === undefined) return {};
  if ("logger" in value || "headers" in value) return value as PostOpenReceiveJsonOptions;
  return { headers: value as Readonly<Record<string, string>> };
}

function emitSwapActionLog(
  logger: OpenReceiveBrowserLogger | undefined,
  outcome: "requested" | "succeeded" | "failed",
  body: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): void {
  if (logger === undefined) return;
  const action = nonEmptyString(body.action);
  if (action !== "start_swap" && action !== "refund_swap") return;
  const event = action === "start_swap" ? `swap.start.${outcome}` : `swap.refund.${outcome}`;
  const level: OpenReceiveBrowserLogLevel = outcome === "failed" ? "warn" : outcome === "requested" ? "debug" : "info";
  try {
    logger(sanitizeBrowserLogEntry({
      level,
      event,
      message: `${action === "start_swap" ? "Swap start" : "Swap refund"} ${outcome}.`,
      order_id: nonEmptyString(body.order_id),
      pay_in_asset: nonEmptyString(body.pay_in_asset),
      ...(action === "refund_swap" ? { confirm: body.confirm === true } : {}),
      ...extra,
    }));
  } catch {
    // Diagnostics never affect payer actions.
  }
}

function swapActionResultFields(body: unknown): Record<string, unknown> {
  const swap = asRecord(asRecord(body).swap ?? body);
  return {
    payment_hash: nonEmptyString(swap.payment_hash),
    provider_state: nonEmptyString(swap.provider_state),
    attention: typeof swap.attention === "boolean" ? swap.attention : undefined,
  };
}
