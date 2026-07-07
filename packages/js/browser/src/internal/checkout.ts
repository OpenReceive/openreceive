/// <reference path="../qrcode.d.ts" />

import { getCountries, type FiatRailId } from "@openreceive/provider-data";
import * as defaultQrEncoder from "qrcode";
import { status as deriveStatus } from "../status.ts";
import { applyOpenReceiveThemeAttributes, createOpenReceiveStoredThemeModel } from "./theme.ts";
import { getOpenReceivePaymentStatusText } from "./wizard.ts";
import {
  OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES,
  OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS,
  OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME,
  OPENRECEIVE_COPY_FEEDBACK_MS,
  OPENRECEIVE_DEFAULT_POLL_INTERVAL_MS,
  OPENRECEIVE_QR_DARK_COLOR,
  OPENRECEIVE_QR_ERROR_CORRECTION,
  OPENRECEIVE_QR_LIGHT_COLOR,
  OPENRECEIVE_QR_QUIET_ZONE_MODULES,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME,
  openReceiveCheckoutLabels,
  type CheckoutController,
  type CheckoutControllerOptions,
  type CheckoutDisplayData,
  type CheckoutDisplayModel,
  type CheckoutElementAttributeOptions,
  type CheckoutElementAttributes,
  type CheckoutElementEventHandlers,
  type CheckoutElementListeners,
  type CheckoutElementTarget,
  type CheckoutInvoiceSnapshot,
  type CheckoutPhase,
  type CheckoutShellElements,
  type CheckoutShellModel,
  type CheckoutShellOptions,
  type CheckoutSnapshot,
  type CheckoutState,
  type CheckoutStatusModel,
  type CheckoutStatusModelInput,
  type CheckoutStatusRefresh,
  type CheckoutWatcherOptions,
  type CopyInvoiceOptions,
  type CreateCheckoutElementOptions,
  type CreateCheckoutShellOptions,
  type CreateCheckoutStateOptions,
  type CreateOpenReceiveStatusFetcherOptions,
  type CreateOpenReceiveThemeToggleElementOptions,
  type OpenReceiveBrowserLogEntry,
  type OpenReceiveBrowserLogLevel,
  type OpenReceiveBrowserLogger,
  type OpenReceiveCheckoutPaymentMethod,
  type OpenReceiveCheckoutShellProps,
  type OpenReceivePaymentMethod,
  type OpenReceiveQrEncoder,
  type OpenReceiveQrOptions,
  type OpenReceiveSwapDisplayModel,
  type OpenReceiveThemeAttributeTarget,
  type OpenReceiveThemeToggleElementAttributeOptions,
  type OpenReceiveThemeToggleElementAttributes,
  type OpenReceiveTransientFeedbackController,
  type OpenReceiveTransientFeedbackOptions,
  type OpenReceiveTickingValueController,
  type OpenReceiveTickingValueOptions,
  type OpenWalletOptions,
  type RequestCheckoutAmount,
  type RequestCheckoutOptions,
} from "./ui.ts";

export function createOpenReceiveTransientFeedbackController<T>(
  options: OpenReceiveTransientFeedbackOptions<T>,
): OpenReceiveTransientFeedbackController<T> {
  const delayMs = options.delayMs ?? OPENRECEIVE_COPY_FEEDBACK_MS;
  const setTimeoutFn = options.setTimeout ?? globalThis.setTimeout;
  const clearTimeoutFn = options.clearTimeout ?? globalThis.clearTimeout;
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;

  const clear = (): void => {
    if (timeout === undefined) return;
    clearTimeoutFn(timeout);
    timeout = undefined;
  };

  return {
    show(value: T): void {
      clear();
      options.onValue(value);
      timeout = setTimeoutFn(() => {
        timeout = undefined;
        options.onValue(options.resetValue);
      }, delayMs);
    },
    clear,
  };
}

export function createOpenReceiveTickingValueController(
  options: OpenReceiveTickingValueOptions,
): OpenReceiveTickingValueController {
  const intervalMs = options.intervalMs ?? 1000;
  const now = options.now ?? currentUnixSeconds;
  const setIntervalFn = options.setInterval ?? globalThis.setInterval;
  const clearIntervalFn = options.clearInterval ?? globalThis.clearInterval;
  let timer: ReturnType<typeof globalThis.setInterval> | undefined;

  const refresh = (): void => {
    options.onValue(now());
  };

  const stop = (): void => {
    if (timer === undefined) return;
    clearIntervalFn(timer);
    timer = undefined;
  };

  return {
    start(): void {
      stop();
      if (options.active === false) return;
      refresh();
      timer = setIntervalFn(refresh, intervalMs);
    },
    stop,
    refresh,
  };
}

export function formatOpenReceiveCountdown(seconds: number): string {
  const safeSeconds = Math.max(0, Math.trunc(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainderSeconds = safeSeconds % 60;
  return `${minutes}:${remainderSeconds.toString().padStart(2, "0")}`;
}

export function createOpenReceiveSwapDisplayModel(
  invoice: CheckoutInvoiceSnapshot,
  options: { readonly now?: number } = {},
): OpenReceiveSwapDisplayModel | undefined {
  const swap = invoice.swap;
  if (swap === undefined) return undefined;
  const expiresAt = Math.min(swap.provider_expires_at, invoice.expires_at ?? swap.provider_expires_at);
  const expiresInSeconds = Math.max(0, expiresAt - (options.now ?? currentUnixSeconds()));
  const asset = getOpenReceiveSwapAssetDisplay(swap.pay_in_asset);

  return {
    provider: swap.provider,
    attemptId: swap.attempt_id ?? invoice.invoice_id,
    payInAsset: swap.pay_in_asset,
    assetLabel: asset.assetLabel,
    networkLabel: asset.networkLabel,
    networkWarning: `Only send ${asset.assetLabel} on ${asset.networkLabel} to this address.`,
    depositAddress: swap.deposit_address,
    ...(swap.deposit_memo === undefined ? {} : { depositMemo: swap.deposit_memo }),
    depositAmount: swap.deposit_amount,
    providerStateLabel: getOpenReceiveSwapProviderStateLabel(swap.provider_state),
    providerStateDetail: getOpenReceiveSwapProviderStateDetail(swap.provider_state),
    state: getOpenReceiveSwapPanelState(swap.provider_state),
    expiresInSeconds,
    countdownLabel: formatOpenReceiveCountdown(expiresInSeconds),
    qrPayload: createOpenReceiveSwapQrPayload(swap),
    ...(swap.deposit_tx_id === undefined ? {} : { depositTxId: swap.deposit_tx_id }),
    ...(swap.payout_tx_id === undefined ? {} : { payoutTxId: swap.payout_tx_id }),
    ...(swap.refund_address === undefined ? {} : { refundAddress: swap.refund_address }),
    ...(swap.refund_nonce === undefined ? {} : { refundNonce: swap.refund_nonce }),
    ...(swap.refund_tx_id === undefined ? {} : { refundTxId: swap.refund_tx_id }),
    ...(swap.provider_order_id === undefined ? {} : { providerOrderId: swap.provider_order_id }),
  };
}

export function openReceiveSwapAssetMatchesRoute(
  routeKey: string,
  payInAsset: string | undefined,
): boolean {
  if (payInAsset === undefined) return false;
  const route = routeKey.includes(":") ? routeKey.split(":").at(-1) ?? routeKey : routeKey;
  if (route === "usdt") return payInAsset.startsWith("USDT_");
  if (route === "usdc") return payInAsset.startsWith("USDC_");
  if (route === "eth") return payInAsset === "ETH_ETH";
  if (route === "sol") return payInAsset === "SOL_SOL";
  return false;
}

function getOpenReceiveSwapProviderStateLabel(state: string): string {
  if (state === "creating_provider_order") return "Preparing payment address";
  if (state === "awaiting_deposit") return "Waiting for your payment";
  if (state === "confirming") return "Confirming payment";
  if (state === "exchanging") return "Converting payment";
  if (state === "paying_invoice") return "Finalizing checkout";
  if (state === "completed") return "Finalizing checkout";
  if (state === "expired") return "Expired";
  if (state === "refund_required") return "Refund needed";
  if (state === "refund_pending") return "Refund pending";
  if (state === "refunded") return "Refunded";
  if (state === "attention") return "Needs attention";
  if (state === "failed") return "Failed";
  return state;
}

function getOpenReceiveSwapProviderStateDetail(state: string): string {
  if (state === "creating_provider_order") return "Creating a payment address.";
  if (state === "awaiting_deposit") return "Send exactly the amount shown below.";
  if (state === "confirming") return "Your payment was detected and is confirming.";
  if (state === "exchanging") return "Your payment is being converted.";
  if (state === "paying_invoice" || state === "completed") {
    return "The provider is sending the Lightning payment.";
  }
  if (state === "expired") return "No payment was received before the payment window closed.";
  if (state === "refund_required") return "Enter an address you control to request a refund.";
  if (state === "refund_pending") return "Your refund request has been sent.";
  if (state === "refunded") return "The provider reports the refund was sent.";
  if (state === "attention") return "This payment needs support review.";
  if (state === "failed") return "This payment address can no longer be used.";
  return state;
}

function getOpenReceiveSwapPanelState(
  state: string,
): OpenReceiveSwapDisplayModel["state"] {
  if (state === "creating_provider_order") return "creating";
  if (state === "awaiting_deposit") return "deposit";
  if (state === "confirming" || state === "exchanging" || state === "paying_invoice" || state === "completed") {
    return "progress";
  }
  if (state === "expired") return "expired";
  if (state === "refund_required") return "refund_required";
  if (state === "refund_pending") return "refund_pending";
  if (state === "refunded") return "refunded";
  if (state === "attention") return "attention";
  return "failed";
}

function getOpenReceiveSwapAssetDisplay(payInAsset: string): {
  readonly assetLabel: string;
  readonly networkLabel: string;
} {
  const [asset, network] = payInAsset.split("_");
  const networkLabel =
    network === "TRON"
      ? "Tron"
      : network === "SOL"
        ? "Solana"
        : network === "ETH"
          ? "Ethereum"
          : (network ?? payInAsset);
  return {
    assetLabel: asset ?? payInAsset,
    networkLabel,
  };
}

function createOpenReceiveSwapQrPayload(swap: NonNullable<CheckoutInvoiceSnapshot["swap"]>): string {
  if (swap.pay_in_asset === "ETH_ETH") {
    const wei = decimalAmountToIntegerString(swap.deposit_amount, 18);
    return wei === undefined
      ? swap.deposit_address
      : `ethereum:${swap.deposit_address}?value=${wei}`;
  }
  if (swap.pay_in_asset === "SOL_SOL") {
    return `solana:${swap.deposit_address}?amount=${encodeURIComponent(swap.deposit_amount)}`;
  }
  return swap.deposit_address;
}

function decimalAmountToIntegerString(amount: string, decimals: number): string | undefined {
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(amount)) return undefined;
  const [whole = "0", fraction = ""] = amount.split(".");
  if (fraction.length > decimals) return undefined;
  const combined = `${whole}${fraction.padEnd(decimals, "0")}`.replace(/^0+/, "");
  return combined.length === 0 ? "0" : combined;
}

export function escapeOpenReceiveHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function formatOpenReceiveMsats(amountMsats: number): string {
  if (!Number.isSafeInteger(amountMsats) || amountMsats < 0) {
    throw new RangeError("amount_msats must be a non-negative safe integer");
  }

  if (amountMsats % 1000 === 0) {
    const sats = amountMsats / 1000;
    return `${sats} ${sats === 1 ? "sat" : "sats"}`;
  }

  return `${amountMsats} msats`;
}

export function formatOpenReceiveFiatAmount(
  fiat:
    | {
        readonly currency?: string;
        readonly value?: string;
      }
    | null
    | undefined,
): string | undefined {
  if (fiat?.currency === undefined || fiat.value === undefined) return undefined;
  if (fiat.currency === "BTC") return `${fiat.value} BTC`;
  if (fiat.currency === "SATS") return `${fiat.value} sats`;
  return fiat.currency === "USD" ? `$${fiat.value}` : `${fiat.value} ${fiat.currency}`;
}

export function formatOpenReceivePaymentHashLabel(hash: string): string {
  return hash.length <= 16 ? hash : `${hash.slice(0, 8)}...${hash.slice(-8)}`;
}

export function assertOpenReceiveDisplayInvoice(invoice: string): void {
  assertInvoice(invoice);
}

export function createCheckoutDisplayModel(data: CheckoutDisplayData): CheckoutDisplayModel {
  return {
    ...data,
    lightning_uri: createLightningUri(data.invoice),
    ...(data.amount_msats === undefined
      ? {}
      : { amountLabel: formatOpenReceiveMsats(data.amount_msats) }),
    ...(formatOpenReceiveFiatAmount(data.fiat_quote?.fiat) === undefined
      ? {}
      : { fiatLabel: formatOpenReceiveFiatAmount(data.fiat_quote?.fiat) }),
    ...(data.payment_hash === undefined
      ? {}
      : { paymentHashLabel: formatOpenReceivePaymentHashLabel(data.payment_hash) }),
    ...(data.transaction_state === undefined
      ? {}
      : { transactionStateLabel: data.transaction_state }),
  };
}

export function createLightningUri(invoice: string): string {
  assertInvoice(invoice);
  return `lightning:${invoice}`;
}

interface NormalizedRequestCheckoutOptions {
  readonly checkoutUrl: string | ((orderId: string) => string);
  readonly orderId: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly amount: RequestCheckoutAmount;
  readonly memo?: string;
  readonly descriptionHash?: string;
  readonly metadata?: Record<string, unknown>;
}

function normalizeRequestCheckoutOptions(
  options: RequestCheckoutOptions,
): NormalizedRequestCheckoutOptions {
  const record = options as RequestCheckoutOptions & Record<string, unknown>;
  const orderId = optionalString(record.orderId ?? record.order_id);
  const descriptionHash = optionalString(record.descriptionHash ?? record.description_hash);
  const metadata = optionalRecord(record.metadata);

  return {
    checkoutUrl: options.checkoutUrl,
    orderId: orderId ?? "",
    fetch: options.fetch,
    headers: options.headers,
    amount: normalizeRequestCheckoutAmount(record),
    ...(options.memo === undefined ? {} : { memo: options.memo }),
    ...(descriptionHash === undefined ? {} : { descriptionHash }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function normalizeRequestCheckoutAmount(options: Record<string, unknown>): RequestCheckoutAmount {
  const sourceCount = [
    options.amount !== undefined,
    options.usd !== undefined,
    options.sats !== undefined,
  ].filter(Boolean).length;
  if (sourceCount !== 1) {
    throw new Error("OpenReceive checkout creation requires exactly one of amount, usd, or sats.");
  }

  if (options.amount !== undefined) {
    return normalizeExplicitRequestCheckoutAmount(options.amount);
  }

  if (options.usd !== undefined) {
    const value = optionalString(options.usd);
    if (
      value === undefined ||
      !/^[0-9]+(?:\.[0-9]+)?$/.test(value) ||
      /^0+(?:\.0+)?$/.test(value)
    ) {
      throw new Error("OpenReceive usd must be a positive decimal string.");
    }
    return {
      fiat: {
        currency: "USD",
        value,
      },
    };
  }

  return {
    btc: {
      currency: "SATS",
      value: normalizeRequestCheckoutSats(options.sats),
    },
  };
}

function normalizeExplicitRequestCheckoutAmount(value: unknown): RequestCheckoutAmount {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      "OpenReceive checkout creation requires exactly one of amount.btc or amount.fiat.",
    );
  }

  const amount = value as RequestCheckoutAmount & Record<string, unknown>;
  const unsupportedAmountKeys = Object.keys(amount).filter(
    (key) => key !== "btc" && key !== "fiat",
  );
  const amountSourceCount = ["btc" in amount, "fiat" in amount].filter(Boolean).length;
  if (unsupportedAmountKeys.length > 0 || amountSourceCount !== 1) {
    throw new Error(
      "OpenReceive checkout creation requires exactly one of amount.btc or amount.fiat.",
    );
  }
  return structuredClone(amount) as RequestCheckoutAmount;
}

function normalizeRequestCheckoutSats(value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error("OpenReceive sats must be a positive integer.");
    }
    return String(value);
  }

  if (typeof value === "string" && /^[0-9]+$/.test(value) && BigInt(value) > 0n) {
    return value;
  }

  throw new Error("OpenReceive sats must be a positive integer.");
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OpenReceive metadata must be an object.");
  }
  return value as Record<string, unknown>;
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
    amount: structuredClone(request.amount),
    ...(request.memo === undefined ? {} : { memo: request.memo }),
    ...(request.descriptionHash === undefined ? {} : { description_hash: request.descriptionHash }),
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
  const body = await response.json();

  if (!response.ok) {
    throw new Error(
      typeof body?.message === "string" ? body.message : "Could not create checkout.",
    );
  }

  const snapshot = checkoutSnapshotFromResponseBody(body);
  const responseInvoice = snapshot.active;
  if (isRecord(responseInvoice) && typeof responseInvoice.invoice === "string") {
    assertOpenReceiveDisplayInvoice(responseInvoice.invoice);
  }

  return snapshot;
}

export function createOpenReceiveStatusFetcher(
  options: CreateOpenReceiveStatusFetcherOptions,
): CheckoutStatusRefresh {
  return async (order_id) => {
    if (order_id.length === 0) {
      throw new Error("OpenReceive status refresh requires order_id.");
    }

    const fetcher = options.fetch ?? globalThis.fetch;
    if (fetcher === undefined) {
      throw new Error("OpenReceive status refresh requires fetch.");
    }

    const headers = options.headers === undefined ? {} : options.headers;
    const response = await fetcher(resolveOrderUrl(options.orderUrl, order_id), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify({
        order_id,
      }),
    });
    const body = await response.json();

    if (!response.ok) {
      throw new Error(
        typeof body?.message === "string" ? body.message : "Could not refresh invoice status.",
      );
    }

    return checkoutSnapshotFromStatusBody(body);
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

function resolveOrderUrl(orderUrl: string, orderId: string): string {
  if (orderUrl.includes("{orderId}")) {
    return orderUrl.replaceAll("{orderId}", encodeURIComponent(orderId));
  }
  return orderUrl.includes("{order_id}")
    ? orderUrl.replaceAll("{order_id}", encodeURIComponent(orderId))
    : orderUrl;
}

function checkoutSnapshotFromResponseBody(body: unknown): CheckoutSnapshot {
  const record = asRecord(body);
  const wrapped = asRecord(record.checkout);
  const candidate = typeof wrapped.checkout_id === "string" ? wrapped : record;
  return normalizeCheckoutSnapshot(candidate);
}

function checkoutSnapshotFromStatusBody(body: unknown): CheckoutSnapshot | null {
  const record = asRecord(body);
  const snapshot = extractCheckoutSnapshotFromStatusBody(record);
  if (snapshot === null) return null;
  // Payable assets ride on the order object itself (payment_methods), so the
  // element lists methods without a second call.
  const paymentMethods = normalizePaymentMethods(record.payment_methods);
  return paymentMethods === undefined ? snapshot : { ...snapshot, payment_methods: paymentMethods };
}

function extractCheckoutSnapshotFromStatusBody(
  record: Record<string, unknown>,
): CheckoutSnapshot | null {
  if (typeof record.checkout_id === "string") {
    return normalizeCheckoutSnapshot(record);
  }

  const displayCheckout = asRecord(record.display_checkout);
  if (typeof displayCheckout.checkout_id === "string") {
    return normalizeCheckoutSnapshot(displayCheckout);
  }

  const paidCheckout = asRecord(record.paid_checkout);
  if (typeof paidCheckout.checkout_id === "string") {
    return normalizeCheckoutSnapshot(paidCheckout);
  }

  const activeCheckout = asRecord(record.active_checkout);
  if (typeof activeCheckout.checkout_id === "string") {
    return normalizeCheckoutSnapshot(activeCheckout);
  }

  if (Array.isArray(record.checkouts)) {
    const first = asRecord(record.checkouts[0]);
    if (typeof first.checkout_id === "string") {
      return normalizeCheckoutSnapshot(first);
    }
  }

  return null;
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
  const payInAsset = optionalString(record.pay_in_asset);
  const label = optionalString(record.label);
  const networkLabel = optionalString(record.network_label);
  const provider = optionalString(record.provider);
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
    ...(optionalString(record.unavailable_reason) === undefined
      ? {}
      : { unavailable_reason: optionalString(record.unavailable_reason) }),
    ...(optionalString(record.unavailable_message) === undefined
      ? {}
      : { unavailable_message: optionalString(record.unavailable_message) }),
    ...(optionalString(record.pay_amount) === undefined
      ? {}
      : { pay_amount: optionalString(record.pay_amount) }),
    ...(optionalString(record.minimum_pay_amount) === undefined
      ? {}
      : { minimum_pay_amount: optionalString(record.minimum_pay_amount) }),
    ...(optionalString(record.maximum_pay_amount) === undefined
      ? {}
      : { maximum_pay_amount: optionalString(record.maximum_pay_amount) }),
  };
}

function normalizeCheckoutSnapshot(input: unknown): CheckoutSnapshot {
  const record = asRecord(input);
  const active =
    record.active === undefined ? undefined : normalizeCheckoutInvoiceSnapshot(record.active);
  const rawInvoices = Array.isArray(record.invoices) ? record.invoices : [];
  const invoices = rawInvoices.map(normalizeCheckoutInvoiceSnapshot);
  const checkoutId = requiredString(record.checkout_id, "checkout_id");
  const orderId = requiredString(record.order_id, "order_id");
  const amountMsats = requiredSafeInteger(record.amount_msats, "amount_msats");
  const status = requiredCheckoutStatus(record.status);

  return {
    checkout_id: checkoutId,
    order_id: orderId,
    status,
    ...(optionalSafeInteger(record.paid_at) === undefined
      ? {}
      : { paid_at: optionalSafeInteger(record.paid_at) }),
    amount_msats: amountMsats,
    ...(normalizeFiat(record.fiat) === undefined ? {} : { fiat: normalizeFiat(record.fiat) }),
    ...(active === undefined ? {} : { active }),
    invoices,
    ...(optionalBoolean(record.wallet_scan_performed) === undefined
      ? {}
      : { wallet_scan_performed: optionalBoolean(record.wallet_scan_performed) }),
    ...(optionalSafeInteger(record.transactions_checked) === undefined
      ? {}
      : { transactions_checked: optionalSafeInteger(record.transactions_checked) }),
  };
}

function normalizeCheckoutInvoiceSnapshot(input: unknown): CheckoutInvoiceSnapshot {
  const record = asRecord(input);
  const rail = requiredInvoiceRail(record.rail);
  const invoice = optionalString(record.invoice);
  if (rail !== "swap" && invoice === undefined) {
    throw new TypeError("OpenReceive checkout response requires invoice.");
  }
  const swap = normalizeCheckoutInvoiceSwapSnapshot(record.swap);
  return {
    invoice_id: requiredString(record.invoice_id, "invoice_id"),
    rail,
    ...(invoice === undefined ? {} : { invoice }),
    ...(optionalString(record.payment_hash) === undefined
      ? {}
      : { payment_hash: optionalString(record.payment_hash) }),
    ...(optionalSafeInteger(record.amount_msats) === undefined
      ? {}
      : { amount_msats: optionalSafeInteger(record.amount_msats) }),
    ...(isRecord(record.fiat_quote) || record.fiat_quote === null
      ? { fiat_quote: record.fiat_quote as CheckoutInvoiceSnapshot["fiat_quote"] }
      : {}),
    ...(optionalString(record.transaction_state) === undefined
      ? {}
      : { transaction_state: optionalString(record.transaction_state) }),
    ...(optionalString(record.workflow_state) === undefined
      ? {}
      : { workflow_state: optionalString(record.workflow_state) }),
    ...(optionalSafeInteger(record.expires_at) === undefined
      ? {}
      : { expires_at: optionalSafeInteger(record.expires_at) }),
    ...(optionalSafeInteger(record.settled_at) === undefined
      ? {}
      : { settled_at: optionalSafeInteger(record.settled_at) }),
    ...(swap === undefined ? {} : { swap }),
  };
}

function requiredInvoiceRail(value: unknown): CheckoutInvoiceSnapshot["rail"] {
  if (value === "lightning" || value === "swap") return value;
  throw new TypeError("OpenReceive invoice rail must be lightning or swap.");
}

function normalizeCheckoutInvoiceSwapSnapshot(
  input: unknown,
): CheckoutInvoiceSnapshot["swap"] | undefined {
  if (!isRecord(input)) return undefined;
  const provider = optionalString(input.provider);
  const payInAsset = optionalString(input.pay_in_asset);
  const depositAddress = optionalString(input.deposit_address);
  const depositAmount = optionalString(input.deposit_amount);
  const providerState = optionalString(input.provider_state) as
    | NonNullable<CheckoutInvoiceSnapshot["swap"]>["provider_state"]
    | undefined;
  const providerExpiresAt = optionalSafeInteger(input.provider_expires_at);
  if (
    provider === undefined ||
    payInAsset === undefined ||
    depositAddress === undefined ||
    depositAmount === undefined ||
    providerState === undefined ||
    providerExpiresAt === undefined
  ) {
    return undefined;
  }

  return {
    ...(optionalString(input.attempt_id) === undefined
      ? {}
      : { attempt_id: optionalString(input.attempt_id) }),
    provider,
    ...(optionalString(input.provider_order_id) === undefined
      ? {}
      : { provider_order_id: optionalString(input.provider_order_id) }),
    pay_in_asset: payInAsset,
    deposit_address: depositAddress,
    ...(optionalString(input.deposit_memo) === undefined
      ? {}
      : { deposit_memo: optionalString(input.deposit_memo) }),
    deposit_amount: depositAmount,
    provider_state: providerState,
    provider_expires_at: providerExpiresAt,
    ...(optionalString(input.deposit_tx_id) === undefined
      ? {}
      : { deposit_tx_id: optionalString(input.deposit_tx_id) }),
    ...(optionalString(input.payout_tx_id) === undefined
      ? {}
      : { payout_tx_id: optionalString(input.payout_tx_id) }),
    ...(optionalString(input.refund_address) === undefined
      ? {}
      : { refund_address: optionalString(input.refund_address) }),
    ...(optionalString(input.refund_nonce) === undefined
      ? {}
      : { refund_nonce: optionalString(input.refund_nonce) }),
    ...(optionalString(input.refund_tx_id) === undefined
      ? {}
      : { refund_tx_id: optionalString(input.refund_tx_id) }),
    ...(optionalBoolean(input.attention) === undefined
      ? {}
      : { attention: optionalBoolean(input.attention) }),
  };
}

function checkoutInvoiceFromOrderSnapshot(snapshot: CheckoutSnapshot): CheckoutInvoiceSnapshot {
  const invoice = snapshot.active ?? snapshot.invoices[0];
  if (invoice === undefined) {
    throw new TypeError("OpenReceive order snapshot requires active or invoices[0].");
  }
  return invoice;
}

function isPaidCheckoutSnapshot(snapshot: CheckoutSnapshot): boolean {
  return snapshot.status === "paid";
}

export function createCheckoutState(
  snapshot: CheckoutSnapshot,
  options: CreateCheckoutStateOptions = {},
): CheckoutState {
  const invoice = checkoutInvoiceFromOrderSnapshot(snapshot);
  const bolt11 = requiredString(invoice.invoice, "invoice");
  const paid = isPaidCheckoutSnapshot(snapshot);
  const settledAt = snapshot.paid_at ?? invoice.settled_at;
  const transactionState = paid ? "settled" : (invoice.transaction_state ?? "pending");
  const workflowState = paid
    ? "settlement_action_completed"
    : (invoice.workflow_state ?? "invoice_created");

  const state = normalizeCheckoutState(
    {
      checkout_id: snapshot.checkout_id,
      order_id: snapshot.order_id,
      invoice_id: invoice.invoice_id,
      invoice: bolt11,
      rail: invoice.rail,
      lightning_uri: createLightningUri(bolt11),
      ...(invoice.payment_hash === undefined ? {} : { payment_hash: invoice.payment_hash }),
      amount_msats: invoice.amount_msats ?? snapshot.amount_msats,
      ...(invoice.fiat_quote === undefined ? {} : { fiat_quote: invoice.fiat_quote }),
      transaction_state: transactionState,
      workflow_state: workflowState,
      ...(invoice.expires_at === undefined ? {} : { expires_at: invoice.expires_at }),
      ...(settledAt === undefined ? {} : { settled_at: settledAt }),
      ...(invoice.swap === undefined ? {} : { swap: invoice.swap }),
      paid,
    },
    options.now ?? currentUnixSeconds(),
  );
  emitBrowserLog(
    options.logger,
    "info",
    "checkout.state.created",
    "Created checkout state from order snapshot.",
    checkoutLogFields(state),
  );
  return state;
}

export function createCheckoutSnapshotFromDisplayData(data: CheckoutDisplayData): CheckoutSnapshot {
  const rail = requiredInvoiceRail(data.rail);
  const invoiceId = requiredString(data.invoice_id, "invoice_id");
  const invoice: CheckoutInvoiceSnapshot = {
    invoice_id: invoiceId,
    invoice: data.invoice,
    rail,
    ...(data.payment_hash === undefined ? {} : { payment_hash: data.payment_hash }),
    ...(data.amount_msats === undefined ? {} : { amount_msats: data.amount_msats }),
    ...(data.fiat_quote === undefined ? {} : { fiat_quote: data.fiat_quote }),
    ...(data.transaction_state === undefined ? {} : { transaction_state: data.transaction_state }),
    ...(data.workflow_state === undefined ? {} : { workflow_state: data.workflow_state }),
    ...(data.expires_at === undefined ? {} : { expires_at: data.expires_at }),
    ...(data.settled_at === undefined ? {} : { settled_at: data.settled_at }),
    ...(data.swap === undefined ? {} : { swap: data.swap }),
  };
  const paid = data.settled_at !== undefined || data.transaction_state === "settled";
  const checkoutId = data.checkout_id ?? invoiceId;
  return {
    checkout_id: checkoutId,
    order_id: data.order_id ?? invoiceId,
    status: paid ? "paid" : "open",
    ...(data.settled_at === undefined ? {} : { paid_at: data.settled_at }),
    amount_msats: data.amount_msats ?? 0,
    active: paid ? undefined : invoice,
    invoices: [invoice],
  };
}

export function createCheckoutStateFromDisplayData(
  data: CheckoutDisplayData,
  options: CreateCheckoutStateOptions = {},
): CheckoutState {
  return createCheckoutState(createCheckoutSnapshotFromDisplayData(data), options);
}

export function refreshCheckoutState(
  state: CheckoutState,
  options: CreateCheckoutStateOptions = {},
): CheckoutState {
  return createCheckoutState(snapshotFromCheckoutState(state), options);
}

export function mergeCheckoutSnapshot(
  current: CheckoutState,
  next: Partial<CheckoutSnapshot>,
): CheckoutSnapshot {
  const currentSnapshot = snapshotFromCheckoutState(current);
  return {
    ...currentSnapshot,
    ...next,
    checkout_id: next.checkout_id ?? currentSnapshot.checkout_id,
    order_id: next.order_id ?? currentSnapshot.order_id,
    status: next.status ?? currentSnapshot.status,
    amount_msats: next.amount_msats ?? currentSnapshot.amount_msats,
    active: next.active ?? currentSnapshot.active,
    invoices: next.invoices ?? currentSnapshot.invoices,
  };
}

export function shouldCheckoutShowWaiting(
  state: CheckoutState,
  options: { readonly now?: number } = {},
): boolean {
  if (state.terminal || state.settled) return false;
  if (state.expires_at === undefined) return true;
  return state.expires_at > (options.now ?? currentUnixSeconds());
}

export function createCheckoutStatusModel(
  source?: CheckoutState | CheckoutStatusModelInput,
  options: { readonly now?: number } = {},
): CheckoutStatusModel {
  const isCheckoutState = source !== undefined && "invoice_id" in source && "invoice" in source;
  const phase = source?.phase ?? "invoice_created";
  const expiresInSeconds = source?.expires_in_seconds;
  const displayPhase =
    phase !== "settled" && phase !== "failed" && phase !== "cancelled" && expiresInSeconds === 0
      ? "expired"
      : phase;
  const statusText = getOpenReceivePaymentStatusText(displayPhase);

  return {
    phase: displayPhase,
    waiting:
      displayPhase === "expired"
        ? false
        : source === undefined
          ? false
          : isCheckoutState
            ? shouldCheckoutShowWaiting(source, options)
            : (source.waiting ?? false),
    title: statusText.title,
    detail: statusText.detail,
    countdownPrefix: openReceiveCheckoutLabels.countdownPrefix,
    ...(expiresInSeconds === undefined || displayPhase === "expired"
      ? {}
      : {
          expires_in_seconds: expiresInSeconds,
          countdownLabel: formatOpenReceiveCountdown(expiresInSeconds),
        }),
  };
}

export class CheckoutWatcher {
  private options: CheckoutWatcherOptions;
  private state: CheckoutState | undefined;
  private countdownTimer: ReturnType<typeof globalThis.setInterval> | undefined;
  private pollTimer: ReturnType<typeof globalThis.setInterval> | undefined;
  private running = false;

  constructor(options: CheckoutWatcherOptions) {
    this.options = options;
  }

  start(): CheckoutState {
    this.stop();
    this.running = true;
    this.options.onSnapshot?.(this.options.snapshot);
    const state = createCheckoutState(this.options.snapshot, {
      now: this.now(),
      logger: this.options.logger,
    });
    this.applyState(state);
    return state;
  }

  update(options: CheckoutWatcherOptions): CheckoutState {
    this.options = options;
    return this.start();
  }

  stop(): void {
    this.running = false;
    this.stopCountdown();
    this.stopPolling();
  }

  getState(): CheckoutState | undefined {
    return this.state;
  }

  async reloadState(): Promise<CheckoutState> {
    const current =
      this.state ??
      createCheckoutState(this.options.snapshot, {
        now: this.now(),
        logger: this.options.logger,
      });
    const refreshStatus = this.options.refreshStatus;
    if (refreshStatus === undefined || current.order_id.length === 0) {
      return current;
    }

    try {
      const next = await refreshStatus(current.order_id);
      if (next === null) return current;
      this.options.onSnapshot?.(next);
      const nextState = createCheckoutState(next, {
        now: this.now(),
        logger: this.options.logger,
      });
      if (this.running) {
        this.applyState(nextState);
      } else {
        this.state = nextState;
      }
      return nextState;
    } catch (error) {
      this.options.onError?.(error);
      throw error;
    }
  }

  private applyState(state: CheckoutState): void {
    if (!this.running) return;
    this.state = state;
    this.options.onState(state);
    this.syncWatchers();
  }

  private syncWatchers(): void {
    const state = this.state;
    if (state === undefined || !this.running) return;

    if (state.terminal) {
      this.stop();
      return;
    }

    if (state.settled || state.expires_at === undefined) {
      this.stopCountdown();
    } else if (this.countdownTimer === undefined) {
      this.countdownTimer = this.setInterval()(() => {
        const current = this.state;
        if (current === undefined) return;
        this.applyState(
          refreshCheckoutState(current, {
            now: this.now(),
            logger: this.options.logger,
          }),
        );
      }, 1000);
    }

    if (state.settled || this.options.refreshStatus === undefined || state.order_id.length === 0) {
      this.stopPolling();
    } else if (this.pollTimer === undefined) {
      this.pollTimer = this.setInterval()(() => {
        void this.poll();
      }, this.options.pollIntervalMs ?? OPENRECEIVE_DEFAULT_POLL_INTERVAL_MS);
    }
  }

  private async poll(): Promise<void> {
    const refreshStatus = this.options.refreshStatus;
    const current = this.state;
    if (!this.running || refreshStatus === undefined || current === undefined) return;
    if (current.terminal || current.settled) {
      this.stopPolling();
      return;
    }

    try {
      const next = await refreshStatus(current.order_id);
      if (next === null) return;
      this.options.onSnapshot?.(next);
      if (!this.running || this.state === undefined) return;
      this.applyState(
        createCheckoutState(next, {
          now: this.now(),
          logger: this.options.logger,
        }),
      );
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  private stopCountdown(): void {
    if (this.countdownTimer === undefined) return;
    this.clearInterval()(this.countdownTimer);
    this.countdownTimer = undefined;
  }

  private stopPolling(): void {
    if (this.pollTimer === undefined) return;
    this.clearInterval()(this.pollTimer);
    this.pollTimer = undefined;
  }

  private now(): number {
    return this.options.now?.() ?? currentUnixSeconds();
  }

  private setInterval(): typeof globalThis.setInterval {
    return this.options.setInterval ?? globalThis.setInterval;
  }

  private clearInterval(): typeof globalThis.clearInterval {
    return this.options.clearInterval ?? globalThis.clearInterval;
  }
}

export class OpenReceiveBrowserCheckoutController implements CheckoutController {
  private options: CheckoutControllerOptions;
  private watcher: CheckoutWatcher;
  private state: CheckoutState | undefined;

  constructor(options: CheckoutControllerOptions) {
    this.options = options;
    this.watcher = this.createWatcher(options);
  }

  start(): CheckoutState {
    this.state = this.watcher.start();
    return this.state;
  }

  update(options: CheckoutControllerOptions): CheckoutState {
    this.options = options;
    this.watcher.stop();
    this.watcher = this.createWatcher(options);
    return this.start();
  }

  stop(): void {
    this.watcher.stop();
  }

  getState(): CheckoutState | undefined {
    return this.state ?? this.watcher.getState();
  }

  async copyInvoice(): Promise<void> {
    const state = this.currentState();
    await copyInvoice({
      invoice: state.invoice,
      clipboard: this.options.clipboard,
      logger: this.options.logger,
      logContext: checkoutLogFields(state),
    });
  }

  openWallet(): string {
    const state = this.currentState();
    return openWallet({
      invoice: state.invoice,
      open: this.options.open,
      logger: this.options.logger,
      logContext: checkoutLogFields(state),
    });
  }

  async reloadState(): Promise<CheckoutState> {
    return this.watcher.reloadState();
  }

  async retry(): Promise<CheckoutState> {
    return this.reloadState();
  }

  cancel(): CheckoutState {
    this.stop();
    this.state = this.currentState();
    emitBrowserLog(
      this.options.logger,
      "info",
      "checkout.cancelled",
      "Stopped checkout watcher after cancel action.",
      checkoutLogFields(this.state),
    );
    return this.state;
  }

  private createWatcher(options: CheckoutControllerOptions): CheckoutWatcher {
    const refreshStatus =
      options.refreshStatus ??
      (options.orderUrl === undefined
        ? undefined
        : createOpenReceiveStatusFetcher({
            orderUrl: options.orderUrl,
            fetch: options.fetch,
            headers: options.statusHeaders,
          }));

    return new CheckoutWatcher({
      ...options,
      ...(refreshStatus === undefined ? {} : { refreshStatus }),
      onState: (state) => {
        this.state = state;
        options.onState?.(state);
      },
      ...(options.onSnapshot === undefined ? {} : { onSnapshot: options.onSnapshot }),
    });
  }

  private currentState(): CheckoutState {
    return (
      this.getState() ??
      createCheckoutState(this.options.snapshot, {
        now: this.options.now?.(),
        logger: this.options.logger,
      })
    );
  }
}

export function createCheckoutController(options: CheckoutControllerOptions): CheckoutController {
  return new OpenReceiveBrowserCheckoutController(options);
}

export async function createQrSvg(
  invoice: string,
  options: OpenReceiveQrOptions = {},
): Promise<string> {
  return await createQrPayloadSvg(createLightningUri(invoice), options);
}

export async function createQrPayloadSvg(
  payload: string,
  options: OpenReceiveQrOptions = {},
): Promise<string> {
  const encoder = await getQrEncoder(options.encoder);
  const svg = await encoder.toString(payload, {
    type: "svg",
    errorCorrectionLevel: OPENRECEIVE_QR_ERROR_CORRECTION,
    margin: OPENRECEIVE_QR_QUIET_ZONE_MODULES,
    width: options.width,
    color: {
      dark: OPENRECEIVE_QR_DARK_COLOR,
      light: OPENRECEIVE_QR_LIGHT_COLOR,
    },
  });

  return String(svg);
}

export async function createQrPngDataUrl(
  invoice: string,
  options: OpenReceiveQrOptions = {},
): Promise<string> {
  const encoder = await getQrEncoder(options.encoder);

  if (encoder.toDataURL === undefined) {
    throw new Error("QR encoder does not support PNG data URL output.");
  }

  const png = await encoder.toDataURL(createLightningUri(invoice), {
    type: "image/png",
    errorCorrectionLevel: OPENRECEIVE_QR_ERROR_CORRECTION,
    margin: OPENRECEIVE_QR_QUIET_ZONE_MODULES,
    width: options.width,
    color: {
      dark: OPENRECEIVE_QR_DARK_COLOR,
      light: OPENRECEIVE_QR_LIGHT_COLOR,
    },
  });

  return String(png);
}

// Spec-named alias for the canonical QR helper trio
// (createQrSvg / createQrPng / createLightningUri). createQrPng returns a
// PNG data URL using the same safe quiet-zone, contrast, and payload defaults.
export const createQrPng = createQrPngDataUrl;

export async function copyInvoice(options: CopyInvoiceOptions): Promise<void> {
  assertInvoice(options.invoice);
  const clipboard = options.clipboard ?? globalThis.navigator?.clipboard;

  if (clipboard === undefined) {
    throw new Error("Clipboard API is unavailable.");
  }

  await clipboard.writeText(options.invoice);
  emitBrowserLog(
    options.logger,
    "info",
    "checkout.invoice.copied",
    "Copied Lightning invoice to clipboard.",
    options.logContext,
  );
}

export function openWallet(options: OpenWalletOptions): string {
  const uri = createLightningUri(options.invoice);

  if (options.open !== undefined) {
    options.open(uri);
    emitBrowserLog(
      options.logger,
      "info",
      "checkout.wallet.opened",
      "Opened Lightning invoice URI.",
      options.logContext,
    );
    return uri;
  }

  const location = globalThis.window?.location;
  if (location === undefined) {
    throw new Error("window.location is unavailable.");
  }

  location.assign(uri);
  emitBrowserLog(
    options.logger,
    "info",
    "checkout.wallet.opened",
    "Opened Lightning invoice URI.",
    options.logContext,
  );
  return uri;
}

async function getQrEncoder(
  encoder: OpenReceiveQrEncoder | undefined,
): Promise<OpenReceiveQrEncoder> {
  if (encoder !== undefined) return encoder;
  if (isQrEncoder(defaultQrEncoder)) return defaultQrEncoder;

  const dynamicImport = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<unknown>;
  const imported = asRecord(await dynamicImport("qrcode"));
  const candidate = (imported.default ?? imported) as unknown;

  if (isQrEncoder(candidate)) return candidate;

  throw new Error("qrcode package did not expose a compatible encoder.");
}

function isQrEncoder(value: unknown): value is OpenReceiveQrEncoder {
  const record = asRecord(value);
  return typeof record.toString === "function";
}

function assertInvoice(invoice: string): void {
  if (typeof invoice !== "string" || invoice.length === 0) {
    throw new TypeError("invoice must be a non-empty BOLT11 string");
  }

  if (invoice.startsWith("nostr+walletconnect://")) {
    throw new TypeError("invoice must not be an NWC connection string");
  }
}

function assertOpenReceiveBrowserPayloadSafe(value: unknown): void {
  if (typeof value === "string") {
    if (value.startsWith("nostr+walletconnect://")) {
      throw new TypeError("OpenReceive browser payload must not include an NWC connection string");
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) assertOpenReceiveBrowserPayloadSafe(item);
    return;
  }

  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) {
      assertOpenReceiveBrowserPayloadSafe(item);
    }
  }
}

function normalizeCheckoutState(
  state: Omit<CheckoutState, "phase" | "settled" | "terminal" | "expires_in_seconds"> &
    Partial<Pick<CheckoutState, "phase" | "settled" | "terminal" | "expires_in_seconds">>,
  now?: number,
): CheckoutState {
  const {
    phase: _phase,
    settled: _settled,
    terminal: _terminal,
    expires_in_seconds: _expiresInSeconds,
    ...base
  } = state;
  const statePhase = getCheckoutPhase(state.transaction_state, state.workflow_state);
  const expiresInSeconds =
    base.expires_at === undefined || now === undefined
      ? undefined
      : Math.max(0, base.expires_at - now);
  const phase =
    statePhase === "invoice_created" || statePhase === "verifying"
      ? expiresInSeconds === 0
        ? "expired"
        : statePhase
      : statePhase;

  return {
    ...base,
    phase,
    settled: base.paid || base.transaction_state === "settled",
    terminal: isTerminalPhase(phase),
    ...(expiresInSeconds === undefined ? {} : { expires_in_seconds: expiresInSeconds }),
  };
}

function getCheckoutPhase(transactionState: string, workflowState: string): CheckoutPhase {
  if (workflowState === "cancelled") return "cancelled";
  if (transactionState === "settled") return "settled";
  if (transactionState === "expired" || workflowState === "expired_closed") {
    return "expired";
  }
  if (transactionState === "failed" || workflowState === "failed_closed") {
    return "failed";
  }
  if (workflowState === "verifying" || workflowState === "expiry_pending_verification") {
    return "verifying";
  }
  return "invoice_created";
}

function isTerminalPhase(phase: CheckoutPhase): boolean {
  return phase === "expired" || phase === "failed" || phase === "cancelled";
}

function snapshotFromCheckoutState(state: CheckoutState): CheckoutSnapshot {
  const invoice: CheckoutInvoiceSnapshot = {
    invoice_id: state.invoice_id,
    invoice: state.invoice,
    rail: state.rail,
    ...(state.payment_hash === undefined ? {} : { payment_hash: state.payment_hash }),
    ...(state.amount_msats === undefined ? {} : { amount_msats: state.amount_msats }),
    ...(state.fiat_quote === undefined ? {} : { fiat_quote: state.fiat_quote }),
    transaction_state: state.transaction_state,
    workflow_state: state.workflow_state,
    ...(state.expires_at === undefined ? {} : { expires_at: state.expires_at }),
    ...(state.settled_at === undefined ? {} : { settled_at: state.settled_at }),
    ...(state.swap === undefined ? {} : { swap: state.swap }),
  };
  return {
    checkout_id: state.checkout_id,
    order_id: state.order_id,
    status: state.paid ? "paid" : state.terminal ? "expired" : "open",
    ...(state.settled_at === undefined ? {} : { paid_at: state.settled_at }),
    amount_msats: state.amount_msats ?? 0,
    active: state.paid ? undefined : invoice,
    invoices: [invoice],
  };
}

function currentUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function getRailForPaymentMethod(method: OpenReceivePaymentMethod | null): FiatRailId | null {
  if (method === "bank") return "bank";
  if (method === "card") return "card";
  return null;
}

function isKnownCountryCode(countryCode: string): boolean {
  return getCountries().some((country) => country.code === countryCode);
}

function readStorageValue(storage: Storage | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorageValue(storage: Storage | undefined, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // Browser storage is convenience only; checkout must keep working without it.
  }
}

function getBrowserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function checkoutLogFields(state: {
  readonly checkout_id?: string;
  readonly order_id?: string;
  readonly invoice_id?: string;
  readonly payment_hash?: string;
  readonly amount_msats?: number;
  readonly transaction_state?: string;
  readonly workflow_state?: string;
  readonly phase?: string;
  readonly expires_in_seconds?: number;
}): Record<string, unknown> {
  return {
    ...(state.checkout_id === undefined ? {} : { checkout_id: state.checkout_id }),
    ...(state.order_id === undefined ? {} : { order_id: state.order_id }),
    ...(state.invoice_id === undefined ? {} : { invoice_id: state.invoice_id }),
    ...(state.payment_hash === undefined ? {} : { payment_hash: state.payment_hash }),
    ...(state.amount_msats === undefined ? {} : { amount_msats: state.amount_msats }),
    ...(state.transaction_state === undefined
      ? {}
      : { transaction_state: state.transaction_state }),
    ...(state.workflow_state === undefined ? {} : { workflow_state: state.workflow_state }),
    ...(state.phase === undefined ? {} : { phase: state.phase }),
    ...(state.expires_in_seconds === undefined
      ? {}
      : { expires_in_seconds: state.expires_in_seconds }),
  };
}

function emitBrowserLog(
  logger: OpenReceiveBrowserLogger | undefined,
  level: OpenReceiveBrowserLogLevel,
  event: string,
  message: string,
  fields: Record<string, unknown> = {},
): void {
  if (logger === undefined) return;

  try {
    logger(
      sanitizeBrowserLogEntry({
        level,
        event,
        message,
        ...fields,
      }),
    );
  } catch {
    // Checkout logs are diagnostic only and must not affect user actions.
  }
}

function sanitizeBrowserLogEntry(entry: OpenReceiveBrowserLogEntry): OpenReceiveBrowserLogEntry {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (/secret|token|authorization|cookie|nwc/i.test(key)) {
      clean[key] = "[REDACTED]";
    } else {
      clean[key] = sanitizeBrowserLogValue(value);
    }
  }
  return clean as OpenReceiveBrowserLogEntry;
}

function sanitizeBrowserLogValue(value: unknown): unknown {
  if (typeof value === "string") return redactBrowserSecrets(value);
  if (Array.isArray(value)) return value.map(sanitizeBrowserLogValue);
  if (typeof value !== "object" || value === null) return value;

  const clean: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (/secret|token|authorization|cookie|nwc/i.test(key)) {
      clean[key] = "[REDACTED]";
    } else {
      clean[key] = sanitizeBrowserLogValue(nested);
    }
  }
  return clean;
}

function redactBrowserSecrets(value: string): string {
  return value
    .replace(/nostr\+walletconnect:\/\/[^\s"'`<>]+/g, "[REDACTED_NWC]")
    .replace(/([?&](?:_or_evt|token|secret)=)[^&\s"'`<>]+/gi, "$1[REDACTED]");
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) return {};
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredString(value: unknown, fieldName: string): string {
  const text = optionalString(value);
  if (text === undefined) {
    throw new TypeError(`OpenReceive checkout response requires ${fieldName}.`);
  }
  return text;
}

function optionalSafeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && typeof value === "number" ? value : undefined;
}

function requiredSafeInteger(value: unknown, fieldName: string): number {
  const integer = optionalSafeInteger(value);
  if (integer === undefined) {
    throw new TypeError(`OpenReceive checkout response requires ${fieldName}.`);
  }
  return integer;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function requiredCheckoutStatus(value: unknown): CheckoutSnapshot["status"] {
  if (value === "open" || value === "superseded" || value === "paid" || value === "expired") {
    return value;
  }
  throw new TypeError("OpenReceive checkout response requires status.");
}

function normalizeFiat(value: unknown): CheckoutSnapshot["fiat"] | undefined {
  const record = asRecord(value);
  const currency = optionalString(record.currency);
  const fiatValue = optionalString(record.value);
  if (currency === undefined || fiatValue === undefined) return undefined;
  return {
    currency,
    value: fiatValue,
  };
}
