// One checkout state, derived: snapshot -> display data -> CheckoutState, the
// phase machine that decides settled/terminal/paid, the status model the UI
// renders, and the conversions back to a snapshot the swap re-key needs.

import { unixSeconds } from "@openreceive/core";
import {
  type CheckoutDisplayData,
  type CheckoutDisplayModel,
  type CheckoutInvoiceSnapshot,
  type CheckoutPhase,
  type CheckoutSnapshot,
  type CheckoutState,
  type CheckoutStatusModel,
  type CheckoutStatusModelInput,
  type CreateCheckoutStateOptions,
  OPENRECEIVE_LIGHTNING_REUSE_BUFFER_SECONDS,
  openReceiveCheckoutLabels,
} from "./ui.ts";
import { getOpenReceivePaymentStatusText } from "./wizard.ts";
import {
  formatOpenReceiveCountdown,
  formatOpenReceiveFiatAmount,
  formatOpenReceiveMsats,
  formatOpenReceivePaymentHashLabel,
} from "./checkout-format.ts";
import { createLightningUri } from "./checkout-invoice.ts";
import { requiredInvoiceRail, requiredString } from "./checkout-read.ts";
import { isTerminalSwapProviderState } from "./checkout-swap-view.ts";
import { checkoutLogFields, emitBrowserLog, emitBrowserSwapTransition } from "./checkout-log.ts";

export function createCheckoutDisplayModel(data: CheckoutDisplayData): CheckoutDisplayModel {
  return {
    ...data,
    // Deferred checkout (checkout_lock) has no bolt11 yet — use empty URI as placeholder.
    lightning_uri:
      data.rail === "checkout_lock" || !data.invoice ? "" : createLightningUri(data.invoice),
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

/**
 * Choose the invoice the checkout UI should treat as primary.
 *
 * Prefers the active payable invoice; otherwise a bolt11-bearing invoice (Lightning),
 * preferring one that has settled. After a swap settles alongside a Lightning invoice,
 * the newest entry is often the settled swap shadow (rail "swap", no public bolt11) —
 * fall back to the payable Lightning invoice for QR/copy display.
 *
 * When Lightning was never minted (deferred create + swap-only), return the swap invoice
 * so settlement still drives paid/`onSettled` UI even though bolt11 is omitted.
 *
 * `checkout_lock` rails are deferred placeholders and are skipped. Returns `undefined`
 * only when the checkout still has only a checkout_lock (or no invoices).
 */
export function selectCheckoutDisplayInvoice(
  snapshot: CheckoutSnapshot,
): CheckoutInvoiceSnapshot | undefined {
  // Skip checkout_lock (deferred placeholder) — it has no bolt11 to display.
  if (snapshot.active !== undefined && snapshot.active.rail !== "checkout_lock") {
    return snapshot.active;
  }
  const nonLock = snapshot.invoices.filter((invoice) => invoice.rail !== "checkout_lock");
  const withBolt11 = nonLock.filter(
    (invoice) => typeof invoice.invoice === "string" && invoice.invoice.length > 0,
  );
  const settledBolt11 = withBolt11.find(
    (invoice) => invoice.transaction_state === "settled" || invoice.settled_at !== undefined,
  );
  if (settledBolt11 !== undefined) return settledBolt11;
  // Prefer a payable Lightning invoice for QR/copy when one exists (even next to a
  // settled swap shadow).
  if (withBolt11[0] !== undefined) return withBolt11[0];
  // Swap-only checkout: surface the swap invoice (null bolt11) so settlement is visible.
  const settledSwap = nonLock.find(
    (invoice) => invoice.transaction_state === "settled" || invoice.settled_at !== undefined,
  );
  return settledSwap ?? nonLock[0];
}

export function checkoutInvoiceFromOrderSnapshot(
  snapshot: CheckoutSnapshot,
): CheckoutInvoiceSnapshot {
  const invoice = selectCheckoutDisplayInvoice(snapshot);
  if (invoice === undefined) {
    throw new TypeError("OpenReceive order snapshot requires active or invoices[0].");
  }
  return invoice;
}

export function isPaidCheckoutSnapshot(snapshot: CheckoutSnapshot): boolean {
  return snapshot.status === "paid";
}

/**
 * True when the given Lightning invoice has more than {@link OPENRECEIVE_LIGHTNING_REUSE_BUFFER_SECONDS}
 * seconds remaining. Pass an optional `now` (Unix seconds) for deterministic tests; defaults to the
 * current clock.
 */
export function isReusableLightningInvoice(expiresAt: number, now?: number): boolean {
  return expiresAt - (now ?? unixSeconds()) > OPENRECEIVE_LIGHTNING_REUSE_BUFFER_SECONDS;
}

export function createCheckoutState(
  snapshot: CheckoutSnapshot,
  options: CreateCheckoutStateOptions = {},
): CheckoutState {
  const invoiceRecord = selectCheckoutDisplayInvoice(snapshot);

  if (invoiceRecord === undefined) {
    // Deferred checkout — no bolt11 minted yet. Return a minimal open/pending state so
    // callers (useCheckout, CheckoutWatcher) don't throw. The invoice fields are empty
    // strings; callers MUST gate any bolt11-dependent UI on the lightning pane being shown.
    return {
      checkout_id: snapshot.checkout_id,
      order_id: snapshot.order_id,
      invoice_id: "",
      invoice: "",
      rail: "checkout_lock",
      lightning_uri: "",
      ...(snapshot.amount_msats === undefined ? {} : { amount_msats: snapshot.amount_msats }),
      ...(snapshot.fiat !== undefined ? { fiat_quote: { fiat: snapshot.fiat } } : {}),
      transaction_state: "pending",
      workflow_state: "invoice_created",
      phase: "invoice_created",
      settled: false,
      terminal: false,
      paid: false,
    };
  }

  const invoice = invoiceRecord;
  // Swap shadows intentionally omit bolt11 from public payloads; checkout_lock has none yet.
  const bolt11 =
    typeof invoice.invoice === "string" && invoice.invoice.length > 0
      ? invoice.invoice
      : invoice.rail === "swap" || invoice.rail === "checkout_lock"
        ? ""
        : requiredString(invoice.invoice, "invoice");
  const paid = isPaidCheckoutSnapshot(snapshot);
  const settledAt = snapshot.paid_at ?? invoice.settled_at;
  const transactionState = paid ? "settled" : (invoice.transaction_state ?? "pending");
  const workflowState = paid ? "paid" : (invoice.workflow_state ?? "invoice_created");

  const state = normalizeCheckoutState(
    {
      checkout_id: snapshot.checkout_id,
      order_id: snapshot.order_id,
      invoice_id: invoice.invoice_id,
      invoice: bolt11,
      rail: invoice.rail,
      lightning_uri:
        invoice.rail === "checkout_lock" || invoice.rail === "swap" || bolt11 === ""
          ? ""
          : createLightningUri(bolt11),
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
    options.now ?? unixSeconds(),
  );
  const source = options.source ?? "create";
  if (source === "create") {
    emitBrowserLog(
      options.logger,
      "info",
      "checkout.state.created",
      "Created checkout state from order snapshot.",
      checkoutLogFields(state),
    );
  } else if (source === "refresh") {
    emitBrowserLog(
      options.logger,
      "debug",
      "checkout.state.refreshed",
      "Refreshed checkout state from order status.",
      checkoutLogFields(state),
    );
    emitBrowserSwapTransition(options.logger, options.previousState, state);
  }
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
  return createCheckoutState(snapshotFromCheckoutState(state), {
    ...options,
    source: options.source ?? "countdown",
    previousState: options.previousState ?? state,
  });
}

export function shouldCheckoutShowWaiting(
  state: CheckoutState,
  options: { readonly now?: number } = {},
): boolean {
  if (state.terminal || state.settled) return false;
  if (state.expires_at === undefined) return true;
  return state.expires_at > (options.now ?? unixSeconds());
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
    // No countdown once settled — the invoice's remaining lifetime is meaningless
    // to a payer whose payment already landed.
    ...(expiresInSeconds === undefined || displayPhase === "expired" || displayPhase === "settled"
      ? {}
      : {
          expires_in_seconds: expiresInSeconds,
          countdownLabel: formatOpenReceiveCountdown(expiresInSeconds),
        }),
  };
}

export function normalizeCheckoutState(
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

  const settled = base.paid || base.transaction_state === "settled";

  return {
    ...base,
    phase,
    settled,
    // A swap that expired, refunded, failed, or needs support review is over:
    // the shadow invoice behind it will not be paid, so watchers stop polling
    // both /payments/check and the provider instead of asking forever.
    terminal:
      isTerminalPhase(phase) ||
      (!settled && isTerminalSwapProviderState(base.swap?.provider_state)),
    ...(expiresInSeconds === undefined ? {} : { expires_in_seconds: expiresInSeconds }),
  };
}

function getCheckoutPhase(transactionState: string, workflowState: string): CheckoutPhase {
  if (workflowState === "cancelled") return "cancelled";
  if (transactionState === "settled") return "settled";
  if (transactionState === "expired" || workflowState === "expired") {
    return "expired";
  }
  if (transactionState === "failed" || workflowState === "failed") {
    return "failed";
  }
  if (workflowState === "verifying") {
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
