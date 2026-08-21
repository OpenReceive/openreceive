import {
  type CheckoutInvoiceSnapshot,
  type CheckoutSnapshot,
  formatOpenReceiveSwapLimit,
  type OpenReceiveCheckoutPaymentMethod,
  orClasses,
} from "@openreceive/browser/headless";
import { renderSwapDepositPanel, WaitingState } from "@openreceive/react";
import type React from "react";

// Short reason to show for an out-of-range swap asset. Prefers a fiat figure
// ("Minimum amount $10.00") converted from the invoice-side limit using the
// checkout's own rate, falling back to the provider's generic message.
export function swapOptionLimitMessage(
  option: OpenReceiveCheckoutPaymentMethod,
  checkout: CheckoutSnapshot | undefined,
): string | undefined {
  if (option.available !== false) return undefined;
  // Prefer a fiat figure ("Minimum amount $10.00"); fall back to the pay-in asset's
  // own units ("Minimum 5 USDT") when the provider only reports pay-side limits.
  if (option.unavailable_reason === "amount_too_small") {
    const fiat =
      checkout === undefined
        ? undefined
        : formatOpenReceiveSwapLimit(checkout, option.minimum_invoice_amount_msats, "ceil");
    if (fiat !== undefined) return `Minimum amount ${fiat}`;
    if (option.minimum_pay_amount !== undefined) {
      return `Minimum ${option.minimum_pay_amount} ${option.label}`;
    }
  }
  if (option.unavailable_reason === "amount_too_large") {
    const fiat =
      checkout === undefined
        ? undefined
        : formatOpenReceiveSwapLimit(checkout, option.maximum_invoice_amount_msats, "floor");
    if (fiat !== undefined) return `Maximum amount ${fiat}`;
    if (option.maximum_pay_amount !== undefined) {
      return `Maximum ${option.maximum_pay_amount} ${option.label}`;
    }
  }
  return option.unavailable_message;
}

/** Prefer the lowest invoice-side floor when every network in a group is unavailable. */
export function swapGroupLimitOption<
  T extends {
    readonly available?: boolean;
    readonly unavailable_reason?: string;
    readonly minimum_invoice_amount_msats?: number;
  },
>(options: readonly T[]): T | undefined {
  if (options.length === 0) return undefined;
  const unavailable = options.filter((option) => option.available === false);
  const pool =
    unavailable.length === 0
      ? options
      : unavailable.filter((option) => option.unavailable_reason === "amount_too_small");
  const candidates = pool.length > 0 ? pool : unavailable.length > 0 ? unavailable : options;
  let best = candidates[0];
  for (const option of candidates) {
    if (best === undefined) {
      best = option;
      continue;
    }
    const bestMin = best.minimum_invoice_amount_msats;
    const optionMin = option.minimum_invoice_amount_msats;
    if (optionMin === undefined) continue;
    if (bestMin === undefined || optionMin < bestMin) best = option;
  }
  return best;
}

/**
 * Swap start buttons for one route. Port of the widget's renderSwapActions;
 * start/busy state comes from the CheckoutFlow store via props.
 */
export const SwapActions: React.FC<{
  options: readonly OpenReceiveCheckoutPaymentMethod[];
  enabled: boolean;
  startingAsset: string | null;
  onStart: (payInAsset: string) => void;
  checkout: CheckoutSnapshot | undefined;
}> = ({ options, enabled, startingAsset, onStart, checkout }) => {
  // Out-of-range assets are kept in the list but rendered as a disabled button
  // with the limit reason, instead of being hidden.
  const shown = options.filter((option) => option.provider.length > 0);
  if (!enabled || shown.length === 0) return null;

  return (
    <div className={orClasses.swapActions}>
      {shown.map((option) => {
        const disabled = option.available === false;
        const limitMessage = swapOptionLimitMessage(option, checkout);
        return (
          <div className={orClasses.swapAction} key={option.pay_in_asset}>
            {disabled ? (
              limitMessage === undefined ? null : (
                <p className={orClasses.swapWarning}>{limitMessage}</p>
              )
            ) : option.pay_amount === undefined ? null : (
              <p className={orClasses.swapEstimate}>
                {`Estimated ${option.pay_amount} ${option.label} to settle this checkout.`}
              </p>
            )}
            <button
              className={orClasses.swapStart}
              disabled={disabled || startingAsset !== null}
              onClick={
                disabled
                  ? undefined
                  : () => {
                      onStart(option.pay_in_asset);
                    }
              }
              type="button"
            >
              {startingAsset === option.pay_in_asset
                ? "Preparing..."
                : `Create ${option.label} (${option.network_label}) payment address`}
            </button>
          </div>
        );
      })}
    </div>
  );
};

/** Inline swap-start failure with retry — never an endless preparing spinner. */
export const SwapStartError: React.FC<{ message: string; onRetry?: () => void }> = ({
  message,
  onRetry,
}) => (
  <section className={orClasses.swapPanel}>
    <div role="alert">
      <strong className={orClasses.swapHeadingTitle}>Could not prepare the payment address</strong>
      <p className={orClasses.swapWarning}>{message}</p>
      {onRetry === undefined ? null : (
        <button className={orClasses.btn} type="button" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  </section>
);

export const SwapPreparing: React.FC<{ label: string }> = ({ label }) => (
  <section className={orClasses.swapPanel}>
    <WaitingState
      waiting={true}
      statusTitle="Preparing payment address"
      statusDetail={`Getting your ${label} payment address…`}
    />
  </section>
);

export const SwapUnavailable: React.FC<{
  quote: OpenReceiveCheckoutPaymentMethod;
  checkout: CheckoutSnapshot | undefined;
}> = ({ quote, checkout }) => {
  const detail =
    swapOptionLimitMessage(quote, checkout) ??
    quote.unavailable_message ??
    `${quote.label} is not available for this amount.`;
  const range =
    quote.minimum_pay_amount === undefined
      ? undefined
      : quote.maximum_pay_amount === undefined
        ? `Minimum ${quote.minimum_pay_amount} ${quote.label}.`
        : `Accepted range: ${quote.minimum_pay_amount}–${quote.maximum_pay_amount} ${quote.label}.`;
  return (
    <section className={orClasses.swapPanel}>
      <div className={orClasses.swapHeading}>
        <strong className={orClasses.swapHeadingTitle}>{`${quote.label} unavailable`}</strong>
      </div>
      <p className={orClasses.swapWarning}>{detail}</p>
      {range === undefined ? null : <p className={orClasses.swapWarning}>{range}</p>}
      <p className={orClasses.swapProgress}>
        Choose another asset above, or pay the Lightning invoice at the top of this page.
      </p>
    </section>
  );
};

/**
 * Thin wrapper over the package's public renderSwapDepositPanel: identical
 * deposit-panel markup, with the CheckoutFlow store owning the refund/back
 * actions and the ticking clock (`now`). Encoder/clipboard/logger stay on
 * their defaults.
 */
export const SwapDepositPanel: React.FC<{
  invoice: CheckoutInvoiceSnapshot;
  checkout: CheckoutSnapshot | undefined;
  now: number;
  onRefund: (
    attemptId: string,
    refundAddress: string,
    refundNonce: string,
    confirm: boolean,
  ) => void;
  onBackToLightning: () => void;
}> = ({ invoice, checkout, now, onRefund, onBackToLightning }) =>
  renderSwapDepositPanel({
    invoice,
    checkout,
    now,
    onRefund: async (attemptId, refundAddress, refundNonce, confirm) => {
      onRefund(attemptId, refundAddress, refundNonce, confirm);
    },
    onBackToLightning,
  });
