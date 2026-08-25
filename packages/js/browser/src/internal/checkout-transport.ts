// Everything that talks to the mounted OpenReceive routes: the request error
// type, the JSON response reader, prepare/create calls, the status fetcher and
// its polling merge, and the parsers that turn a response body into a
// CheckoutSnapshot. Every URL comes from ./routes.ts, derived from the caller's
// `prefix` — this module never accepts a route of its own.

import { isRecord, nonEmptyString, recordOrEmpty } from "@openreceive/core";
import { assertDisplayInvoice } from "./checkout-invoice.ts";
import { mergeMintedCheckout } from "./checkout-merge.ts";
import {
  optionalRecord,
  optionalSafeInteger,
  requiredSafeInteger,
  requiredString,
} from "./checkout-read.ts";
import { isTerminalSwapProviderState } from "./checkout-swap-view.ts";
import { requestHeaders } from "./request-headers.ts";
import { checkoutRoutes, type Routes } from "./routes.ts";
import type {
  CheckoutInvoiceSnapshot,
  CheckoutPaymentMethod,
  CheckoutSnapshot,
  CheckoutStatusRefresh,
  CreateOpenReceiveStatusFetcherOptions,
  PrepareCheckoutOptions,
  RequestCheckoutOptions,
} from "./ui.ts";

/**
 * Typed transport error for OpenReceive browser requests. Carries the server's
 * error semantics (status, shared error code, retryable hint, Retry-After) so
 * callers can back off instead of blind fixed-interval retries — and so hosts
 * can distinguish "retry" from "bug".
 */
/**
 * Consecutive /swaps/status failures before the swap panel says so. One or two
 * blips are ordinary; a run of them means the payer is looking at frozen
 * provider state.
 */
const SWAP_STATUS_FAILURE_LIMIT = 3 as const;

export class BrowserRequestError extends Error {
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
    this.name = "BrowserRequestError";
    this.status = options.status;
    if (options.code !== undefined) this.code = options.code;
    if (options.retryable !== undefined) this.retryable = options.retryable;
    if (options.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/**
 * Read a fetch Response as JSON with error semantics preserved: non-OK
 * responses throw BrowserRequestError (even when the body is not
 * JSON — a proxy's HTML 502 must not surface as a SyntaxError), and the
 * Retry-After header is captured when present.
 */
export async function readJsonResponse(
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
    // Only a NON-OK body may be non-JSON: that is the proxy HTML 502 case this
    // tolerance exists for. An OK response from our own server that is not JSON
    // is a real failure, and swallowing it here resurfaced downstream as a
    // mislabeled "checkout response requires payment_hash".
    if (response.ok) {
      throw new BrowserRequestError(`${fallbackMessage} The server returned a non-JSON body.`, {
        status: response.status,
        retryable: false,
      });
    }
    body = undefined;
  }
  if (!response.ok) {
    const record =
      body !== null && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
    const retryAfterRaw = Number(response.headers?.get?.("retry-after") ?? Number.NaN);
    throw new BrowserRequestError(
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
  readonly routes: Routes;
  readonly reference: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly memo?: string;
  readonly metadata?: Record<string, unknown>;
}

function normalizeRequestCheckoutOptions(
  options: RequestCheckoutOptions,
): NormalizedRequestCheckoutOptions {
  const reference = nonEmptyString(options.reference);
  const metadata = optionalRecord(options.metadata);
  return {
    routes: checkoutRoutes(options.prefix),
    reference: reference ?? "",
    fetch: options.fetch,
    headers: options.headers,
    ...(options.memo === undefined ? {} : { memo: options.memo }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

export async function requestCheckout(options: RequestCheckoutOptions): Promise<CheckoutSnapshot> {
  const request = normalizeRequestCheckoutOptions(options);
  if (request.reference.length === 0) {
    throw new Error("OpenReceive checkout creation requires reference.");
  }

  const fetcher = request.fetch ?? globalThis.fetch;
  if (fetcher === undefined) {
    throw new Error("OpenReceive checkout creation requires fetch.");
  }

  if (request.memo !== undefined && request.memo.length > 500) {
    throw new Error("OpenReceive memo must be 500 characters or fewer.");
  }

  const requestBody = {
    reference: request.reference,
    ...(request.memo === undefined ? {} : { memo: request.memo }),
    ...(request.metadata === undefined ? {} : { metadata: structuredClone(request.metadata) }),
  };

  const headers = request.headers === undefined ? {} : request.headers;
  const response = await fetcher(request.routes.checkouts, {
    method: "POST",
    headers: requestHeaders(headers),
    body: JSON.stringify(requestBody),
  });
  const body = (await readJsonResponse(response, "Could not create checkout.")) as
    | Record<string, unknown>
    | undefined;

  const snapshot = checkoutSnapshotFromResponseBody(body);
  const responseInvoice = snapshot.active;
  if (isRecord(responseInvoice) && typeof responseInvoice.invoice === "string") {
    assertDisplayInvoice(responseInvoice.invoice);
  }

  // The mint response carries the bolt11 and nothing else. Folding it into the
  // snapshot the caller already had is what keeps `payment_methods` (and any
  // sibling swap attempt) alive across the mint — see `previous` on
  // RequestCheckoutOptions. With no `previous`, this is the bare snapshot.
  return options.previous === undefined
    ? snapshot
    : mergeMintedCheckout(snapshot, options.previous);
}

/**
 * Lock the host order amount and load payment methods without minting Lightning.
 * Bitcoin selection later calls {@link requestCheckout} to mint (or reuse) a bolt11.
 */
export async function prepareCheckout(options: PrepareCheckoutOptions): Promise<CheckoutSnapshot> {
  const request = normalizeRequestCheckoutOptions(options);
  if (request.reference.length === 0) {
    throw new Error("OpenReceive checkout prepare requires reference.");
  }

  const fetcher = request.fetch ?? globalThis.fetch;
  if (fetcher === undefined) {
    throw new Error("OpenReceive checkout prepare requires fetch.");
  }

  const headers = request.headers === undefined ? {} : request.headers;
  const response = await fetcher(request.routes.checkoutsPrepare, {
    method: "POST",
    headers: requestHeaders(headers),
    body: JSON.stringify({ reference: request.reference }),
  });
  const body = await readJsonResponse(response, "Could not prepare checkout.");

  return checkoutLockSnapshotFromPrepareBody(body, request.reference);
}

export function createStatusFetcher(
  options: CreateOpenReceiveStatusFetcherOptions,
): CheckoutStatusRefresh {
  // Track the latest refreshed snapshot so repeated calls on the same fetcher
  // (headless polling loops) see current swap state, not the creation snapshot —
  // otherwise the terminal-state guard below never fires and every tick keeps
  // hitting /swaps/status after the provider is already terminal.
  let snapshot = options.snapshot;
  // Consecutive /swaps/status failures on this fetcher. Reset by any success.
  let swapStatusFailures = 0;
  const routes = checkoutRoutes(options.prefix);
  return async (reference) => {
    if (reference.length === 0) {
      throw new Error("OpenReceive status refresh requires reference.");
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
    const response = await fetcher(routes.paymentsCheck, {
      method: "POST",
      headers: requestHeaders(headers),
      body: JSON.stringify({
        reference,
        payment_hash: activePaymentHash,
      }),
    });
    const body = await readJsonResponse(response, "Could not refresh invoice status.");

    const payment = recordOrEmpty(body);
    const next = structuredClone(snapshot);
    if (next.active === undefined) return next;
    const state = nonEmptyString(payment.status) ?? "pending";
    const paidAt = optionalSafeInteger(payment.paid_at, "paid_at");
    let active = {
      ...next.active,
      transaction_state: state === "not_found" ? "pending" : state,
      ...(paidAt === undefined ? {} : { settled_at: paidAt }),
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
        const swapResponse = await fetcher(routes.swapsStatus, {
          method: "POST",
          headers: requestHeaders(headers),
          body: JSON.stringify({ reference, payment_hash: activePaymentHash }),
        });
        const swapBody = recordOrEmpty(
          await readJsonResponse(swapResponse, "Could not refresh swap status."),
        );
        active = mergeSwapStatusIntoInvoice(active, swapBody);
        swapStatusFailures = 0;
      } catch (error) {
        // Live swap state is an enrichment: one blip must not break the tick,
        // and the shadow-invoice status above still lands. But /swaps/status is
        // the ONLY source of refund_required (see the comment above), so a
        // persistent failure would freeze the panel on a stale
        // awaiting_deposit forever and never show a refund the payer must act
        // on. Surface a definitive failure at once and a repeated one after
        // SWAP_STATUS_FAILURE_LIMIT ticks.
        swapStatusFailures += 1;
        const definitive = error instanceof BrowserRequestError && error.retryable === false;
        const swap = active.swap;
        if (swap !== undefined && (definitive || swapStatusFailures >= SWAP_STATUS_FAILURE_LIMIT)) {
          active = {
            ...active,
            swap: { ...swap, attention: true, attention_reason: "swap_status_unavailable" },
          };
        }
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
  const providerExpiresAt = optionalSafeInteger(status.provider_expires_at, "provider_expires_at");
  if (providerExpiresAt !== undefined) merged.provider_expires_at = providerExpiresAt;
  for (const key of [
    "deposit_tx_id",
    "payout_tx_id",
    "refund_tx_id",
    "refund_reason",
    "refund_amount",
    "deposit_received_amount",
    "refund_address",
    "attention_reason",
  ]) {
    if (typeof status[key] === "string") merged[key] = status[key];
  }
  if (typeof status.attention === "boolean") merged.attention = status.attention;
  return {
    ...invoice,
    swap: merged as unknown as NonNullable<CheckoutInvoiceSnapshot["swap"]>,
    ...(providerExpiresAt === undefined ? {} : { expires_at: providerExpiresAt }),
  };
}

function checkoutLockSnapshotFromPrepareBody(
  body: unknown,
  fallbackReference: string,
): CheckoutSnapshot {
  const record = recordOrEmpty(body);
  // One reader style for one response from our own server: the prepare body's
  // own reference is authoritative, and the caller's value is the fallback only
  // when the server omitted it entirely.
  const reference = requiredString(record.reference ?? fallbackReference, "reference");
  const amountMsats = requiredSafeInteger(record.amount_msats, "amount_msats");
  const lockId = `lock:${reference}`;
  const lockInvoice: CheckoutInvoiceSnapshot = {
    invoice_id: lockId,
    rail: "checkout_lock",
    amount_msats: amountMsats,
    transaction_state: "pending",
    workflow_state: "invoice_created",
  };
  // No String() coercion of our own wire fields: the pair is included only when
  // BOTH halves are really there, so a malformed quote cannot paper itself over
  // as an empty-string currency that the spread below then silently drops.
  const fiatQuote = record.fiat_quote;
  const fiatRecord = isRecord(fiatQuote) && isRecord(fiatQuote.fiat) ? fiatQuote.fiat : undefined;
  const fiatCurrency = nonEmptyString(fiatRecord?.currency);
  const fiatValue = nonEmptyString(fiatRecord?.value);
  const fiat =
    fiatCurrency === undefined || fiatValue === undefined
      ? undefined
      : { currency: fiatCurrency, value: fiatValue };
  const paymentMethods = normalizePaymentMethods(record.payment_methods);
  return {
    checkout_id: lockId,
    reference: reference,
    status: "open",
    amount_msats: amountMsats,
    ...(fiat === undefined ? {} : { fiat }),
    active: lockInvoice,
    invoices: [lockInvoice],
    ...(paymentMethods === undefined ? {} : { payment_methods: paymentMethods }),
  };
}

function checkoutSnapshotFromResponseBody(body: unknown): CheckoutSnapshot {
  const record = recordOrEmpty(body);
  const wrapped = recordOrEmpty(record.checkout);
  // `payment_methods` is a SIBLING of `checkout` in the create response, the
  // way it is in prepare and payments/check. Reading it here is what lets a
  // mint carry the pay-in catalog on its own; `previous` then only has to
  // carry snapshot continuity (sibling attempts), not rescue the catalog.
  const paymentMethods = normalizePaymentMethods(record.payment_methods);
  return {
    ...checkoutSnapshot(wrapped),
    ...(paymentMethods === undefined ? {} : { payment_methods: paymentMethods }),
  };
}

function checkoutSnapshot(checkout: Record<string, unknown>): CheckoutSnapshot {
  const paymentHash = requiredString(checkout.payment_hash, "payment_hash");
  const reference = requiredString(checkout.reference, "reference");
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
    reference: reference,
    status: "open",
    amount_msats: amountMsats,
    active: invoice,
    invoices: [invoice],
  };
}

function normalizePaymentMethods(value: unknown): readonly CheckoutPaymentMethod[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(normalizePaymentMethod);
}

/**
 * One payment-methods entry from our own server. A method missing a required
 * field THROWS rather than vanishing from the grid: a silently dropped method
 * is a payment route the payer never sees and nobody ever hears about, which is
 * exactly the failure the trust model says to surface instead of swallow.
 */
function normalizePaymentMethod(input: unknown): CheckoutPaymentMethod {
  const record = recordOrEmpty(input);
  // Empty provider means the asset is known but no LSC provider offered it, so
  // this one is required-but-possibly-empty rather than required-non-empty.
  const provider = record.provider;
  if (typeof provider !== "string") {
    throw new TypeError("payment method provider must be a string");
  }
  const unavailableReason = nonEmptyString(record.unavailable_reason);
  const unavailableMessage = nonEmptyString(record.unavailable_message);
  const payAmount = nonEmptyString(record.pay_amount);
  const minimumPayAmount = nonEmptyString(record.minimum_pay_amount);
  const maximumPayAmount = nonEmptyString(record.maximum_pay_amount);
  const minimumInvoiceAmountMsats = optionalSafeInteger(
    record.minimum_invoice_amount_msats,
    "minimum_invoice_amount_msats",
  );
  const maximumInvoiceAmountMsats = optionalSafeInteger(
    record.maximum_invoice_amount_msats,
    "maximum_invoice_amount_msats",
  );
  return {
    pay_in_asset: requiredString(record.pay_in_asset, "pay_in_asset"),
    label: requiredString(record.label, "label"),
    network_label: requiredString(record.network_label, "network_label"),
    provider,
    available: record.available === true,
    ...(unavailableReason === undefined ? {} : { unavailable_reason: unavailableReason }),
    ...(unavailableMessage === undefined ? {} : { unavailable_message: unavailableMessage }),
    ...(payAmount === undefined ? {} : { pay_amount: payAmount }),
    ...(minimumPayAmount === undefined ? {} : { minimum_pay_amount: minimumPayAmount }),
    ...(maximumPayAmount === undefined ? {} : { maximum_pay_amount: maximumPayAmount }),
    ...(minimumInvoiceAmountMsats === undefined
      ? {}
      : { minimum_invoice_amount_msats: minimumInvoiceAmountMsats }),
    ...(maximumInvoiceAmountMsats === undefined
      ? {}
      : { maximum_invoice_amount_msats: maximumInvoiceAmountMsats }),
  };
}
