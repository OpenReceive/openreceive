import { sanitizeBrowserLogEntry } from "./checkout.ts";
import { orderAccessTokenHeaders } from "./order-token.ts";
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

function readResponseMessage(value: unknown): string | undefined {
  return nonEmptyString(asRecord(value).message);
}

export interface PostOpenReceiveJsonOptions {
  readonly logger?: OpenReceiveBrowserLogger;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * POST JSON to an OpenReceive endpoint and return the parsed body, throwing the
 * server-provided message on a non-2xx response. `fetcher` is injectable so React
 * can pass a test fetch while the custom element uses the global `fetch`.
 *
 * `headers` forwards caller-supplied headers (e.g. an order capability token as
 * `Authorization: Bearer <token>` or `X-OpenReceive-Order-Token`). This is the seam that
 * lets swap start/quote/refund reads carry the same token the create/status calls do —
 * previously this choke point sent no custom headers.
 *
 * When `logger` is provided, swap start/refund actions emit audit events
 * (`swap.start.requested` / `swap.refund.requested` and matching `.failed` / `.succeeded`).
 */
export async function postOpenReceiveJson(
  fetcher: typeof globalThis.fetch,
  url: string,
  body: Record<string, unknown>,
  headersOrOptions?: Readonly<Record<string, string>> | PostOpenReceiveJsonOptions,
): Promise<unknown> {
  const options = normalizePostOptions(headersOrOptions);
  // Auto-attach the per-order capability token so swap quote/start/refund carry it with no
  // caller change, keyed by the `order_id` already present in the body. Placed before the
  // caller-provided `headers` so an explicit override still wins; omitted when no token is
  // stored for this order.
  const orderId = typeof body.order_id === "string" ? body.order_id : undefined;
  const action = nonEmptyString(body.action);
  emitSwapActionLog(options.logger, "requested", body);

  const response = await fetcher(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...orderAccessTokenHeaders(orderId),
      ...options.headers,
    },
    body: JSON.stringify(body),
  });
  const parsed = await response.json();
  if (!response.ok) {
    const message = readResponseMessage(parsed) ?? "OpenReceive request failed.";
    emitSwapActionLog(options.logger, "failed", body, {
      http_status: response.status,
      error_message: message,
    });
    throw new Error(message);
  }
  if (action === "start_swap" || action === "refund_swap") {
    emitSwapActionLog(options.logger, "succeeded", body, swapActionResultFields(parsed));
  }
  return parsed;
}

/**
 * Normalize a swap start/refund response to the Lightning invoice snapshot the UI
 * renders. A swap start/refund returns `{ attempt }`; the backing invoice (which
 * carries the swap block) is `attempt.shadow_invoice`.
 */
export function normalizeSwapStartInvoice(body: unknown): CheckoutInvoiceSnapshot {
  const record = asRecord(body);
  const invoice = asRecord(asRecord(record.attempt).shadow_invoice ?? record.invoice ?? body);
  if (
    nonEmptyString(invoice.invoice_id) === undefined ||
    asRecord(invoice.swap).provider === undefined
  ) {
    throw new Error("Swap response did not include an attempt.");
  }
  return invoice as unknown as CheckoutInvoiceSnapshot;
}

/** Soft 409 while the provider order (deposit address) is still being created. */
export const OPENRECEIVE_SWAP_ADDRESS_PREPARING_MESSAGE =
  "Swap payment address is still being prepared. Retry this swap start shortly.";

const SWAP_START_PREPARING_RETRY_DELAYS_MS = [
  400, 800, 1_200, 1_600, 2_000, 2_000, 2_000, 2_000, 2_000, 2_000,
] as const;

export function isOpenReceiveSwapAddressPreparingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("still being prepared");
}

/**
 * Start a swap and silently retry the soft "address still being prepared" conflict
 * until the deposit address is ready. Avoids sticky host `onError` banners for a
 * condition the UI already shows as "Preparing payment address".
 */
export async function startOpenReceiveSwapRequest(
  fetcher: typeof globalThis.fetch,
  url: string,
  orderId: string,
  payInAsset: string,
  options?: PostOpenReceiveJsonOptions,
): Promise<CheckoutInvoiceSnapshot> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= SWAP_START_PREPARING_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const body = await postOpenReceiveJson(
        fetcher,
        url,
        {
          order_id: orderId,
          action: "start_swap",
          pay_in_asset: payInAsset,
        },
        options,
      );
      return normalizeSwapStartInvoice(body);
    } catch (error) {
      lastError = error;
      if (
        !isOpenReceiveSwapAddressPreparingError(error) ||
        attempt >= SWAP_START_PREPARING_RETRY_DELAYS_MS.length
      ) {
        throw error;
      }
      await sleepMs(SWAP_START_PREPARING_RETRY_DELAYS_MS[attempt] ?? 2_000);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

function normalizePostOptions(
  headersOrOptions: Readonly<Record<string, string>> | PostOpenReceiveJsonOptions | undefined,
): PostOpenReceiveJsonOptions {
  if (headersOrOptions === undefined) return {};
  if (isPostOpenReceiveJsonOptions(headersOrOptions)) {
    return headersOrOptions;
  }
  return { headers: headersOrOptions };
}

function isPostOpenReceiveJsonOptions(
  value: Readonly<Record<string, string>> | PostOpenReceiveJsonOptions,
): value is PostOpenReceiveJsonOptions {
  return (
    ("logger" in value && typeof (value as PostOpenReceiveJsonOptions).logger === "function") ||
    ("headers" in value &&
      typeof (value as PostOpenReceiveJsonOptions).headers === "object" &&
      (value as PostOpenReceiveJsonOptions).headers !== null)
  );
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

  const confirm = body.confirm === true;
  const event =
    action === "start_swap"
      ? `swap.start.${outcome}`
      : `swap.refund.${outcome}`;
  const level: OpenReceiveBrowserLogLevel =
    outcome === "failed" ? "warn" : outcome === "requested" ? "debug" : "info";
  const message =
    action === "start_swap"
      ? outcome === "failed"
        ? "Swap start request failed."
        : outcome === "succeeded"
          ? "Swap start request succeeded."
          : "Requesting swap start."
      : outcome === "failed"
        ? "Swap refund request failed."
        : outcome === "succeeded"
          ? confirm
            ? "Swap refund confirm succeeded."
            : "Swap refund address stage succeeded."
          : confirm
            ? "Requesting swap refund confirm."
            : "Requesting swap refund address stage.";

  try {
    logger(
      sanitizeBrowserLogEntry({
        level,
        event,
        message,
        order_id: nonEmptyString(body.order_id),
        ...(nonEmptyString(body.pay_in_asset) === undefined
          ? {}
          : { pay_in_asset: nonEmptyString(body.pay_in_asset) }),
        ...(nonEmptyString(body.attempt_id) === undefined
          ? {}
          : { attempt_id: nonEmptyString(body.attempt_id) }),
        ...(action === "refund_swap" ? { confirm } : {}),
        // Never log refund_address or refund_nonce — only presence.
        ...(action === "refund_swap"
          ? { refund_nonce_present: nonEmptyString(body.refund_nonce) !== undefined }
          : {}),
        ...extra,
      }),
    );
  } catch {
    // Checkout logs are diagnostic only and must not affect user actions.
  }
}

function swapActionResultFields(body: unknown): Record<string, unknown> {
  const record = asRecord(body);
  const attempt = asRecord(record.attempt);
  const invoice = asRecord(attempt.shadow_invoice ?? record.invoice ?? body);
  const swap = asRecord(invoice.swap);
  return {
    ...(nonEmptyString(invoice.invoice_id) === undefined
      ? {}
      : { invoice_id: nonEmptyString(invoice.invoice_id) }),
    ...(nonEmptyString(swap.provider_state) === undefined
      ? {}
      : { provider_state: nonEmptyString(swap.provider_state) }),
    ...(typeof swap.attention === "boolean" ? { attention: swap.attention } : {}),
    ...(nonEmptyString(swap.attention_reason) === undefined
      ? {}
      : { attention_reason: nonEmptyString(swap.attention_reason) }),
    refund_nonce_present: nonEmptyString(swap.refund_nonce) !== undefined,
  };
}
