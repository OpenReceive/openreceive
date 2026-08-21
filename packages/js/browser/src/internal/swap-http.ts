import { nonEmptyString, recordOrEmpty } from "@openreceive/core";
import { readOpenReceiveJsonResponse } from "./checkout-transport.ts";
import { resolveOpenReceiveBrowserLogger, sanitizeBrowserLogEntry } from "./console-logger.ts";
import { openReceiveRoutePrefix as routePrefix } from "./routes.ts";
import {
  type CheckoutInvoiceSnapshot,
  OPENRECEIVE_REFUND_REVIEW_NONCE,
  type OpenReceiveBrowserLoggerOption,
  type OpenReceiveBrowserLogLevel,
} from "./ui.ts";

export interface PostOpenReceiveJsonOptions {
  readonly logger?: OpenReceiveBrowserLoggerOption;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * POST JSON through the mounted swap route set (see {@link openReceiveRoutePrefix}:
 * `url` is the checkout status endpoint every other route is derived from).
 *
 * `action` selects the route client-side and is never sent: the shipped schemas
 * are `additionalProperties: false`, so an extra key is a 400.
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
    const result =
      action === "swap_quote"
        ? await requestJson(
            fetcher,
            `${routePrefix(url)}/swaps/quote`,
            {
              order_id: orderId,
              pay_in_asset: body.pay_in_asset,
            },
            options,
          )
        : action === "refund_swap"
          ? await refundRequest(fetcher, url, body, orderId, options)
          : await requestJson(fetcher, url, withoutAction(body), options);
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
  const outer = recordOrEmpty(body);
  const swap = recordOrEmpty(outer.swap ?? body);
  const checkout = recordOrEmpty(swap.checkout);
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
      provider_state: swap.provider_state as NonNullable<
        CheckoutInvoiceSnapshot["swap"]
      >["provider_state"],
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

/**
 * Review-or-confirm a swap refund for one attempt: locates the attempt's
 * payment hash among the known invoices, posts the refund action, and returns
 * the normalized swap invoice (with the staged refund address/nonce on review).
 */
export async function requestOpenReceiveSwapRefund(
  fetcher: typeof globalThis.fetch,
  url: string,
  options: {
    readonly orderId?: string;
    readonly invoices: readonly (CheckoutInvoiceSnapshot | null | undefined)[];
    readonly attemptId: string;
    readonly refundAddress: string;
    readonly refundNonce: string;
    readonly confirm: boolean;
    readonly logger?: OpenReceiveBrowserLoggerOption;
  },
): Promise<CheckoutInvoiceSnapshot> {
  const payment = options.invoices.find(
    (invoice) =>
      invoice != null && (invoice.swap?.attempt_id ?? invoice.invoice_id) === options.attemptId,
  );
  if (payment?.payment_hash === undefined) {
    throw new Error("Swap refund requires the original payment hash.");
  }
  const body = await postOpenReceiveJson(
    fetcher,
    url,
    {
      ...(options.orderId === undefined ? {} : { order_id: options.orderId }),
      payment_hash: payment.payment_hash,
      action: "refund_swap",
      attempt_id: options.attemptId,
      refund_address: options.refundAddress,
      refund_nonce: options.refundNonce,
      confirm: options.confirm,
    },
    { logger: options.logger },
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
    const status = recordOrEmpty(
      await requestJson(
        fetcher,
        `${prefix}/swaps/refunds`,
        {
          order_id: orderId,
          payment_hash: paymentHash,
          refund_address: refundAddress,
        },
        options,
      ),
    );
    return { swap: status };
  }
  const status = recordOrEmpty(
    await requestJson(
      fetcher,
      `${prefix}/swaps/status`,
      {
        order_id: orderId,
        payment_hash: paymentHash,
      },
      options,
    ),
  );
  return {
    swap: {
      ...status,
      refund_address: refundAddress,
      // Confirmation is a browser UX step. Authorization and provider-state refresh
      // happen on the host when the confirmed refund request is submitted.
      refund_nonce: OPENRECEIVE_REFUND_REVIEW_NONCE,
    },
  };
}

function withoutAction(body: Record<string, unknown>): Record<string, unknown> {
  const { action: _action, ...rest } = body;
  return rest;
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
  return readOpenReceiveJsonResponse(response, "OpenReceive request failed.");
}

function copyOptionalSwapFields(
  swap: Record<string, unknown>,
): Partial<NonNullable<CheckoutInvoiceSnapshot["swap"]>> {
  const output: Record<string, unknown> = {};
  for (const key of [
    "deposit_memo",
    "deposit_tx_id",
    "payout_tx_id",
    "refund_tx_id",
    "refund_reason",
    "refund_amount",
    "attention",
    "attempt_id",
    "provider_order_id",
    "refund_address",
    "refund_nonce",
    "refund_nonce_expires_at",
    "attention_reason",
    "deposit_received_amount",
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
  // A bare headers record is all string values, while an options object carries
  // only `logger`/`headers` keys with non-string values — so a header literally
  // named "logger" or "headers" still parses as a header.
  const isOptions = Object.entries(value).every(
    ([key, entry]) => (key === "logger" || key === "headers") && typeof entry !== "string",
  );
  if (isOptions) return value as PostOpenReceiveJsonOptions;
  return { headers: value as Readonly<Record<string, string>> };
}

function emitSwapActionLog(
  logger: OpenReceiveBrowserLoggerOption | undefined,
  outcome: "requested" | "succeeded" | "failed",
  body: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): void {
  const sink = resolveOpenReceiveBrowserLogger(logger);
  if (sink === undefined) return;
  const action = nonEmptyString(body.action);
  if (action !== "start_swap" && action !== "refund_swap") return;
  const event = action === "start_swap" ? `swap.start.${outcome}` : `swap.refund.${outcome}`;
  const level: OpenReceiveBrowserLogLevel =
    outcome === "failed" ? "warn" : outcome === "requested" ? "debug" : "info";
  try {
    sink(
      sanitizeBrowserLogEntry({
        level,
        event,
        message: `${action === "start_swap" ? "Swap start" : "Swap refund"} ${outcome}.`,
        order_id: nonEmptyString(body.order_id),
        pay_in_asset: nonEmptyString(body.pay_in_asset),
        ...(action === "refund_swap" ? { confirm: body.confirm === true } : {}),
        ...extra,
      }),
    );
  } catch {
    // Diagnostics never affect payer actions.
  }
}

function swapActionResultFields(body: unknown): Record<string, unknown> {
  const swap = recordOrEmpty(recordOrEmpty(body).swap ?? body);
  return {
    payment_hash: nonEmptyString(swap.payment_hash),
    provider_state: nonEmptyString(swap.provider_state),
    attention: typeof swap.attention === "boolean" ? swap.attention : undefined,
  };
}
