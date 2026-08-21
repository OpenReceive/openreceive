// Everything that talks to the mounted OpenReceive routes: the request error
// type, the JSON response reader, prepare/create calls, the status fetcher and
// its polling merge, URL resolution from the route prefix, and the parsers
// that turn a response body into a CheckoutSnapshot.

import { isRecord, nonEmptyString } from "@openreceive/core";
import { openReceiveRoutePrefix } from "./routes.ts";
import {
  type CheckoutInvoiceSnapshot,
  type CheckoutSnapshot,
  type CheckoutStatusRefresh,
  type CreateOpenReceiveStatusFetcherOptions,
  OPENRECEIVE_REFUND_REVIEW_NONCE,
  type OpenReceiveCheckoutPaymentMethod,
  type RequestCheckoutOptions,
} from "./ui.ts";
import {
  assertOpenReceiveBrowserPayloadSafe,
  assertOpenReceiveDisplayInvoice,
} from "./checkout-invoice.ts";
import {
  asRecord,
  optionalRecord,
  optionalSafeInteger,
  requiredSafeInteger,
  requiredString,
} from "./checkout-read.ts";
import { isTerminalSwapProviderState } from "./checkout-swap-view.ts";

/**
 * Typed transport error for OpenReceive browser requests. Carries the server's
 * error semantics (status, shared error code, retryable hint, Retry-After) so
 * callers can back off instead of blind fixed-interval retries — and so hosts
 * can distinguish "retry" from "bug".
 */
export class OpenReceiveBrowserRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly retryable?: boolean;
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    options: {
      readonly status: number;
      readonly code?: string;
      readonly retryable?: boolean;
      readonly retryAfterSeconds?: number;
    },
  ) {
    super(message);
    this.name = "OpenReceiveBrowserRequestError";
    this.status = options.status;
    if (options.code !== undefined) this.code = options.code;
    if (options.retryable !== undefined) this.retryable = options.retryable;
    if (options.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/**
 * Read a fetch Response as JSON with error semantics preserved: non-OK
 * responses throw OpenReceiveBrowserRequestError (even when the body is not
 * JSON — a proxy's HTML 502 must not surface as a SyntaxError), and the
 * Retry-After header is captured when present.
 */
export async function readOpenReceiveJsonResponse(
  response: {
    readonly ok: boolean;
    readonly status: number;
    readonly headers?: { get(name: string): string | null };
    json(): Promise<unknown>;
  },
  fallbackMessage: string,
): Promise<unknown> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const record =
      body !== null && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
    const retryAfterRaw = Number(response.headers?.get?.("retry-after") ?? Number.NaN);
    throw new OpenReceiveBrowserRequestError(
      typeof record?.message === "string" ? record.message : fallbackMessage,
      {
        status: response.status,
        ...(typeof record?.code === "string" ? { code: record.code } : {}),
        ...(typeof record?.retryable === "boolean" ? { retryable: record.retryable } : {}),
        ...(Number.isFinite(retryAfterRaw) && retryAfterRaw > 0
          ? { retryAfterSeconds: retryAfterRaw }
          : {}),
      },
    );
  }
  return body;
}

interface NormalizedRequestCheckoutOptions {
  readonly checkoutUrl: string | ((orderId: string) => string);
  readonly orderId: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly memo?: string;
  readonly metadata?: Record<string, unknown>;
}

function normalizeRequestCheckoutOptions(
  options: RequestCheckoutOptions,
): NormalizedRequestCheckoutOptions {
  const record = options as RequestCheckoutOptions & Record<string, unknown>;
  const orderId = nonEmptyString(record.orderId ?? record.order_id);
  const metadata = optionalRecord(record.metadata);
  return {
    checkoutUrl: resolveRequestCheckoutTarget(options),
    orderId: orderId ?? "",
    fetch: options.fetch,
    headers: options.headers,
    ...(options.memo === undefined ? {} : { memo: options.memo }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

/**
 * Resolve where a checkout is created. An explicit `checkoutUrl` always wins; otherwise a
 * `prefix` (the base path the shipped router is mounted at) derives `${prefix}/checkouts`.
 * This is what lets a developer pass `prefix: "/openreceive"` and never spell out routes.
 */
function resolveRequestCheckoutTarget(
  options: RequestCheckoutOptions,
): string | ((orderId: string) => string) {
  if (options.checkoutUrl !== undefined) return options.checkoutUrl;
  const prefix = nonEmptyString(options.prefix);
  if (prefix !== undefined) {
    return `${prefix.replace(/\/+$/, "")}/checkouts`;
  }
  throw new Error("OpenReceive checkout creation requires checkoutUrl or prefix.");
}

/** Derive the payment-check URL from the base path the shipped router is mounted at. */
export function resolveOrderUrlFromPrefix(prefix: string): string {
  return `${prefix.replace(/\/+$/, "")}/payments/check`;
}

export async function requestCheckout(options: RequestCheckoutOptions): Promise<CheckoutSnapshot> {
  const request = normalizeRequestCheckoutOptions(options);
  if (request.orderId.length === 0) {
    throw new Error("OpenReceive checkout creation requires orderId.");
  }

  const fetcher = request.fetch ?? globalThis.fetch;
  if (fetcher === undefined) {
    throw new Error("OpenReceive checkout creation requires fetch.");
  }

  if (request.memo !== undefined && request.memo.length > 500) {
    throw new Error("OpenReceive memo must be 500 characters or fewer.");
  }

  const requestBody = {
    order_id: request.orderId,
    ...(request.memo === undefined ? {} : { memo: request.memo }),
    ...(request.metadata === undefined ? {} : { metadata: structuredClone(request.metadata) }),
  };
  assertOpenReceiveBrowserPayloadSafe(requestBody);

  const headers = request.headers === undefined ? {} : request.headers;
  const response = await fetcher(resolveCheckoutUrl(request.checkoutUrl, request.orderId), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(requestBody),
  });
  const body = (await readOpenReceiveJsonResponse(response, "Could not create checkout.")) as
    | Record<string, unknown>
    | undefined;

  const snapshot = checkoutSnapshotFromResponseBody(body);
  const responseInvoice = snapshot.active;
  if (isRecord(responseInvoice) && typeof responseInvoice.invoice === "string") {
    assertOpenReceiveDisplayInvoice(responseInvoice.invoice);
  }

  return snapshot;
}

/**
 * Lock the host order amount and load payment methods without minting Lightning.
 * Bitcoin selection later calls {@link requestCheckout} to mint (or reuse) a bolt11.
 */
export async function prepareCheckout(options: RequestCheckoutOptions): Promise<CheckoutSnapshot> {
  const request = normalizeRequestCheckoutOptions(options);
  if (request.orderId.length === 0) {
    throw new Error("OpenReceive checkout prepare requires orderId.");
  }

  const fetcher = request.fetch ?? globalThis.fetch;
  if (fetcher === undefined) {
    throw new Error("OpenReceive checkout prepare requires fetch.");
  }

  const headers = request.headers === undefined ? {} : request.headers;
  const prepareUrl = resolveCheckoutPrepareUrl(request.checkoutUrl, request.orderId);
  const response = await fetcher(prepareUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify({ order_id: request.orderId }),
  });
  const body = await readOpenReceiveJsonResponse(response, "Could not prepare checkout.");

  return checkoutLockSnapshotFromPrepareBody(body, request.orderId);
}

export function createOpenReceiveStatusFetcher(
  options: CreateOpenReceiveStatusFetcherOptions,
): CheckoutStatusRefresh {
  // Track the latest refreshed snapshot so repeated calls on the same fetcher
  // (headless polling loops) see current swap state, not the creation snapshot —
  // otherwise the terminal-state guard below never fires and every tick keeps
  // hitting /swaps/status after the provider is already terminal.
  let snapshot = options.snapshot;
  return async (order_id) => {
    if (order_id.length === 0) {
      throw new Error("OpenReceive status refresh requires order_id.");
    }

    const fetcher = options.fetch ?? globalThis.fetch;
    if (fetcher === undefined) {
      throw new Error("OpenReceive status refresh requires fetch.");
    }

    const headers = options.headers === undefined ? {} : options.headers;
    const activePaymentHash =
      nonEmptyString(snapshot.active?.payment_hash) ??
      (snapshot.active?.rail === "checkout_lock"
        ? undefined
        : nonEmptyString(snapshot.active?.invoice_id));
    // Deferred checkout_lock has no attempt yet — skip wallet status until Lightning or swap.
    if (activePaymentHash === undefined || !/^[0-9a-f]{64}$/i.test(activePaymentHash)) {
      return snapshot;
    }
    const response = await fetcher(options.orderUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify({
        order_id,
        payment_hash: activePaymentHash,
      }),
    });
    const body = await readOpenReceiveJsonResponse(response, "Could not refresh invoice status.");

    const payment = asRecord(body);
    const next = structuredClone(snapshot);
    if (next.active === undefined) return next;
    const state = nonEmptyString(payment.status) ?? "pending";
    let active = {
      ...next.active,
      transaction_state: state === "not_found" ? "pending" : state,
      ...(optionalSafeInteger(payment.paid_at) === undefined
        ? {}
        : { settled_at: optionalSafeInteger(payment.paid_at) }),
    };
    // A live swap needs the provider's state too: "confirming"/"exchanging"
    // progress, expiry, and critically refund_required can only come from
    // /swaps/status — /payments/check sees only the shadow invoice.
    if (
      active.rail === "swap" &&
      active.swap !== undefined &&
      state !== "settled" &&
      // A terminal provider state is final; re-reading it only adds provider load.
      !isTerminalSwapProviderState(nonEmptyString(active.swap.provider_state))
    ) {
      try {
        const swapStatusUrl = `${openReceiveRoutePrefix(options.orderUrl)}/swaps/status`;
        const swapResponse = await fetcher(swapStatusUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...headers,
          },
          body: JSON.stringify({ order_id, payment_hash: activePaymentHash }),
        });
        const swapBody = asRecord(
          await readOpenReceiveJsonResponse(swapResponse, "Could not refresh swap status."),
        );
        active = mergeSwapStatusIntoInvoice(active, swapBody);
      } catch {
        // Live swap state is an enrichment; the shadow-invoice status above
        // still lands even when the provider read fails this tick.
      }
    }
    const paymentMethods = normalizePaymentMethods(payment.payment_methods);
    // Sibling attempts stay in the snapshot: an order can hold a live swap next
    // to a still-valid Lightning invoice, and dropping the sibling forced a
    // fresh POST /checkouts when the payer switched back to Lightning.
    const others = next.invoices.filter(
      (entry) => entry.invoice_id !== active.invoice_id && entry.rail !== "checkout_lock",
    );
    snapshot = {
      ...next,
      active,
      invoices: [active, ...others],
      status:
        state === "settled"
          ? "paid"
          : state === "expired" || state === "failed"
            ? "expired"
            : "open",
      ...(paymentMethods === undefined ? {} : { payment_methods: paymentMethods }),
    };
    return snapshot;
  };
}

/** Fold a bare PublicSwap status body into the invoice's swap snapshot. */
function mergeSwapStatusIntoInvoice<
  Invoice extends Pick<CheckoutInvoiceSnapshot, "swap" | "expires_at">,
>(invoice: Invoice, status: Record<string, unknown>): Invoice {
  const swap = invoice.swap;
  if (swap === undefined) return invoice;
  const merged: Record<string, unknown> = { ...swap };
  const providerState = nonEmptyString(status.provider_state);
  if (providerState !== undefined) merged.provider_state = providerState;
  const providerExpiresAt = optionalSafeInteger(status.provider_expires_at);
  if (providerExpiresAt !== undefined) merged.provider_expires_at = providerExpiresAt;
  for (const key of [
    "deposit_tx_id",
    "payout_tx_id",
    "refund_tx_id",
    "refund_reason",
    "refund_amount",
    "deposit_received_amount",
    "refund_address",
    "refund_nonce",
    "attention_reason",
  ]) {
    if (typeof status[key] === "string") merged[key] = status[key];
  }
  if (typeof status.attention === "boolean") merged.attention = status.attention;
  if (
    (providerState === "refund_required" || merged.provider_state === "refund_required") &&
    merged.refund_nonce === undefined
  ) {
    merged.refund_nonce = OPENRECEIVE_REFUND_REVIEW_NONCE;
  }
  return {
    ...invoice,
    swap: merged as unknown as NonNullable<CheckoutInvoiceSnapshot["swap"]>,
    ...(providerExpiresAt === undefined ? {} : { expires_at: providerExpiresAt }),
  };
}

function resolveCheckoutUrl(
  checkoutUrl: string | ((orderId: string) => string),
  orderId: string,
): string {
  const url = typeof checkoutUrl === "function" ? checkoutUrl(orderId) : checkoutUrl;
  if (url.includes("{orderId}")) {
    return url.replaceAll("{orderId}", encodeURIComponent(orderId));
  }
  return url.includes("{order_id}")
    ? url.replaceAll("{order_id}", encodeURIComponent(orderId))
    : url;
}

function resolveCheckoutPrepareUrl(
  checkoutUrl: string | ((orderId: string) => string),
  orderId: string,
): string {
  const minted = resolveCheckoutUrl(checkoutUrl, orderId);
  if (minted.endsWith("/checkouts")) return `${minted}/prepare`;
  if (minted.includes("/checkouts?")) {
    return minted.replace("/checkouts?", "/checkouts/prepare?");
  }
  // Silently falling back to the default prefix would split prepare and
  // create across DIFFERENT endpoints — fail loudly instead.
  throw new Error(
    "OpenReceive cannot derive the prepare URL from this checkoutUrl (it does not end in " +
      "/checkouts). Pass `prefix` instead, or point checkoutUrl at the mounted /checkouts route.",
  );
}

function checkoutLockSnapshotFromPrepareBody(
  body: unknown,
  fallbackOrderId: string,
): CheckoutSnapshot {
  const record = asRecord(body);
  const orderId = nonEmptyString(record.order_id) ?? fallbackOrderId;
  const amountMsats = requiredSafeInteger(record.amount_msats, "amount_msats");
  const lockId = `lock:${orderId}`;
  const lockInvoice: CheckoutInvoiceSnapshot = {
    invoice_id: lockId,
    rail: "checkout_lock",
    amount_msats: amountMsats,
    transaction_state: "pending",
    workflow_state: "invoice_created",
  };
  const fiatQuote = record.fiat_quote;
  const fiat =
    isRecord(fiatQuote) && isRecord(fiatQuote.fiat)
      ? {
          currency: String(fiatQuote.fiat.currency ?? ""),
          value: String(fiatQuote.fiat.value ?? ""),
        }
      : undefined;
  const paymentMethods = normalizePaymentMethods(record.payment_methods);
  return {
    checkout_id: lockId,
    order_id: orderId,
    status: "open",
    amount_msats: amountMsats,
    ...(fiat !== undefined && fiat.currency.length > 0 ? { fiat } : {}),
    active: lockInvoice,
    invoices: [lockInvoice],
    ...(paymentMethods === undefined ? {} : { payment_methods: paymentMethods }),
  };
}

function checkoutSnapshotFromResponseBody(body: unknown): CheckoutSnapshot {
  const record = asRecord(body);
  const wrapped = asRecord(record.checkout);
  return checkoutSnapshot(wrapped);
}

function checkoutSnapshot(checkout: Record<string, unknown>): CheckoutSnapshot {
  const paymentHash = requiredString(checkout.payment_hash, "payment_hash");
  const orderId = requiredString(checkout.order_id, "order_id");
  const amountMsats = requiredSafeInteger(checkout.amount_msats, "amount_msats");
  const invoice: CheckoutInvoiceSnapshot = {
    invoice_id: paymentHash,
    rail: "lightning",
    invoice: requiredString(checkout.bolt11, "bolt11"),
    payment_hash: paymentHash,
    amount_msats: amountMsats,
    transaction_state: "pending",
    workflow_state: "invoice_created",
    expires_at: requiredSafeInteger(checkout.expires_at, "expires_at"),
    ...(isRecord(checkout.fiat_quote) || checkout.fiat_quote === null
      ? { fiat_quote: checkout.fiat_quote as CheckoutInvoiceSnapshot["fiat_quote"] }
      : {}),
  };
  return {
    checkout_id: paymentHash,
    order_id: orderId,
    status: "open",
    amount_msats: amountMsats,
    active: invoice,
    invoices: [invoice],
  };
}

function normalizePaymentMethods(
  value: unknown,
): readonly OpenReceiveCheckoutPaymentMethod[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map(normalizePaymentMethod)
    .filter((method): method is OpenReceiveCheckoutPaymentMethod => method !== undefined);
}

function normalizePaymentMethod(input: unknown): OpenReceiveCheckoutPaymentMethod | undefined {
  const record = asRecord(input);
  const payInAsset = nonEmptyString(record.pay_in_asset);
  const label = nonEmptyString(record.label);
  const networkLabel = nonEmptyString(record.network_label);
  // Empty provider means the asset is known but no LSC provider offered it.
  const provider = typeof record.provider === "string" ? record.provider : undefined;
  if (
    payInAsset === undefined ||
    label === undefined ||
    networkLabel === undefined ||
    provider === undefined
  ) {
    return undefined;
  }
  return {
    pay_in_asset: payInAsset,
    label,
    network_label: networkLabel,
    provider,
    available: record.available === true,
    ...(nonEmptyString(record.unavailable_reason) === undefined
      ? {}
      : { unavailable_reason: nonEmptyString(record.unavailable_reason) }),
    ...(nonEmptyString(record.unavailable_message) === undefined
      ? {}
      : { unavailable_message: nonEmptyString(record.unavailable_message) }),
    ...(nonEmptyString(record.pay_amount) === undefined
      ? {}
      : { pay_amount: nonEmptyString(record.pay_amount) }),
    ...(nonEmptyString(record.minimum_pay_amount) === undefined
      ? {}
      : { minimum_pay_amount: nonEmptyString(record.minimum_pay_amount) }),
    ...(nonEmptyString(record.maximum_pay_amount) === undefined
      ? {}
      : { maximum_pay_amount: nonEmptyString(record.maximum_pay_amount) }),
    ...(optionalSafeInteger(record.minimum_invoice_amount_msats) === undefined
      ? {}
      : { minimum_invoice_amount_msats: optionalSafeInteger(record.minimum_invoice_amount_msats) }),
    ...(optionalSafeInteger(record.maximum_invoice_amount_msats) === undefined
      ? {}
      : { maximum_invoice_amount_msats: optionalSafeInteger(record.maximum_invoice_amount_msats) }),
  };
}
