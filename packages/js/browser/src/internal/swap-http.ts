import { nonEmptyString, recordOrEmpty } from "@openreceive/core";
import { optionalSafeInteger } from "./checkout-read.ts";
import { readJsonResponse } from "./checkout-transport.ts";
import { resolveBrowserLogger, sanitizeBrowserLogEntry } from "./console-logger.ts";
import { requestHeaders } from "./request-headers.ts";
import { checkoutRoutes, type Routes } from "./routes.ts";
import type { BrowserLoggerOption, BrowserLogLevel, CheckoutInvoiceSnapshot } from "./ui.ts";

/**
 * What every swap call needs: the fetch to use, and the mount `prefix` its
 * route is derived from (see {@link checkoutRoutes}). `prefix` is the only
 * URL input — no call in this module takes a route of its own.
 */
export interface SwapRequestOptions {
  readonly fetch: typeof globalThis.fetch;
  readonly prefix: string;
  readonly logger?: BrowserLoggerOption;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * POST JSON through the mounted swap route set.
 *
 * `action` selects the route client-side and is never sent: the shipped schemas
 * are `additionalProperties: false`, so an extra key is a 400. Only the actions
 * listed here are routed — an unrecognized one throws rather than silently
 * posting to `${prefix}/payments/check`. Swap starts go through
 * `startSwapRequest`, which owns the /swaps route and its audit events.
 */
export async function postJson(
  options: SwapRequestOptions & { readonly body: Record<string, unknown> },
): Promise<unknown> {
  const { body } = options;
  const routes = checkoutRoutes(options.prefix);
  const reference = nonEmptyString(body.reference);
  const action = nonEmptyString(body.action);
  if (action !== undefined && action !== "swap_quote" && action !== "refund_swap") {
    throw new Error(`Unrecognized checkout action ${action}.`);
  }
  emitSwapActionLog(options.logger, "requested", body);

  try {
    const result =
      action === "swap_quote"
        ? await requestJson(options, routes.swapsQuote, {
            reference: reference,
            pay_in_asset: body.pay_in_asset,
          })
        : action === "refund_swap"
          ? await refundRequest(options, routes, body, reference)
          : await requestJson(options, routes.paymentsCheck, withoutAction(body));
    if (action === "refund_swap") {
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
  // Optional echo of the checkout's own amount, which the client already knows.
  const amountMsats = optionalSafeInteger(checkout.amount_msats, "amount_msats");
  return {
    invoice_id: paymentHash,
    rail: "swap",
    payment_hash: paymentHash,
    ...(amountMsats === undefined ? {} : { amount_msats: amountMsats }),
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

/**
 * Start a swap on the mounted /swaps route. This is the only swap-start path,
 * so the swap.start.* audit events are emitted here — routing it through
 * postJson would log a start while posting somewhere else.
 */
export async function startSwapRequest(
  options: SwapRequestOptions & {
    readonly reference: string;
    readonly payInAsset: string;
  },
): Promise<CheckoutInvoiceSnapshot> {
  const logBody = {
    action: "start_swap",
    reference: options.reference,
    pay_in_asset: options.payInAsset,
  };
  emitSwapActionLog(options.logger, "requested", logBody);
  try {
    const body = await requestJson(options, checkoutRoutes(options.prefix).swaps, {
      reference: options.reference,
      pay_in_asset: options.payInAsset,
    });
    emitSwapActionLog(options.logger, "succeeded", logBody, swapActionResultFields(body));
    return normalizeSwapStartInvoice(body);
  } catch (error) {
    emitSwapActionLog(options.logger, "failed", logBody, {
      error_message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Review-or-confirm a swap refund for one attempt: locates the attempt's
 * payment hash among the known invoices, posts the refund action, and returns
 * the normalized swap invoice (with the staged refund address on review).
 */
export async function requestSwapRefund(
  options: SwapRequestOptions & {
    readonly reference?: string;
    readonly invoices: readonly (CheckoutInvoiceSnapshot | null | undefined)[];
    readonly attemptId: string;
    readonly refundAddress: string;
    readonly confirm: boolean;
  },
): Promise<CheckoutInvoiceSnapshot> {
  const payment = options.invoices.find(
    (invoice) =>
      invoice != null && (invoice.swap?.attempt_id ?? invoice.invoice_id) === options.attemptId,
  );
  if (payment?.payment_hash === undefined) {
    throw new Error("Swap refund requires the original payment hash.");
  }
  const body = await postJson({
    fetch: options.fetch,
    prefix: options.prefix,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    body: {
      ...(options.reference === undefined ? {} : { reference: options.reference }),
      payment_hash: payment.payment_hash,
      action: "refund_swap",
      attempt_id: options.attemptId,
      refund_address: options.refundAddress,
      confirm: options.confirm,
    },
  });
  return normalizeSwapStartInvoice(body);
}

async function refundRequest(
  options: SwapRequestOptions,
  routes: Routes,
  body: Record<string, unknown>,
  reference: string | undefined,
): Promise<unknown> {
  if (reference === undefined) throw new Error("Swap refund requires reference.");
  const refundAddress = nonEmptyString(body.refund_address);
  if (refundAddress === undefined) throw new Error("Swap refund requires refund_address.");
  const paymentHash = nonEmptyString(body.payment_hash);
  if (paymentHash === undefined) throw new Error("Swap refund requires payment_hash.");
  if (body.confirm === true) {
    const status = recordOrEmpty(
      await requestJson(options, routes.swapsRefunds, {
        reference: reference,
        payment_hash: paymentHash,
        refund_address: refundAddress,
      }),
    );
    return { swap: status };
  }
  const status = recordOrEmpty(
    await requestJson(options, routes.swapsStatus, {
      reference: reference,
      payment_hash: paymentHash,
    }),
  );
  // Review, not submit: the staged address rides back on the snapshot so the
  // panel can show it for confirmation. Confirmation is a browser UX step —
  // authorization and provider-state refresh happen on the host when the
  // confirmed refund request is submitted.
  return { swap: { ...status, refund_address: refundAddress } };
}

function withoutAction(body: Record<string, unknown>): Record<string, unknown> {
  const { action: _action, ...rest } = body;
  return rest;
}

async function requestJson(
  options: SwapRequestOptions,
  url: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  // Bare call on a local, never `options.fetch(...)`: invoking window.fetch as
  // a method of the options object rebinds `this` and the browser throws
  // "Illegal invocation".
  const fetcher = options.fetch;
  const response = await fetcher(url, {
    method: "POST",
    headers: requestHeaders(options.headers),
    body: JSON.stringify(body),
  });
  return readJsonResponse(response, "OpenReceive request failed.");
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
    "attention_reason",
    "deposit_received_amount",
    "fee",
  ]) {
    if (swap[key] !== undefined) output[key] = swap[key];
  }
  return output as Partial<NonNullable<CheckoutInvoiceSnapshot["swap"]>>;
}

function emitSwapActionLog(
  logger: BrowserLoggerOption | undefined,
  outcome: "requested" | "succeeded" | "failed",
  body: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): void {
  const sink = resolveBrowserLogger(logger);
  if (sink === undefined) return;
  const action = nonEmptyString(body.action);
  if (action !== "start_swap" && action !== "refund_swap") return;
  const event = action === "start_swap" ? `swap.start.${outcome}` : `swap.refund.${outcome}`;
  const level: BrowserLogLevel =
    outcome === "failed" ? "warn" : outcome === "requested" ? "debug" : "info";
  try {
    sink(
      sanitizeBrowserLogEntry({
        level,
        event,
        message: `${action === "start_swap" ? "Swap start" : "Swap refund"} ${outcome}.`,
        reference: nonEmptyString(body.reference),
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
