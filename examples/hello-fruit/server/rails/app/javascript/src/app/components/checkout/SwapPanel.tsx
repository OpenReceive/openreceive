/**
 * The ONE hand-ported swap panel: the focused deposit flow for a single pay-in
 * coin, driven entirely by CheckoutFlow (MobX Keystone) state.
 *
 * Everything inside the panel — QR, deposit address, memo, countdown, refund
 * form — is the packaged `renderSwapDepositPanel` from @openreceive/react. What
 * is ported here is only the shell the store owns: the breadcrumb back to the
 * grid, and the preparing/failed states of a swap start. Together with
 * MethodGrid.tsx this is the whole demo-owned checkout markup; see that file's
 * header for why the port exists at all.
 */
import {
  type CheckoutSnapshot,
  formatOpenReceiveSwapLimit,
  type OpenReceiveCheckoutPaymentMethod,
  openReceiveCheckoutLabels,
  orClasses,
} from "@openreceive/browser/headless";
import { renderSwapDepositPanel, WaitingState } from "@openreceive/react";
import { observer } from "mobx-react";
import type React from "react";
import type { CheckoutFlow } from "../../stores/CheckoutFlow.ts";

// swapOptionLimitMessage and swapGroupLimitOption below are the demo's copies of
// the packaged openReceiveSwapOptionLimitMessage / openReceiveSwapGroupLimitOption.
// Those are only reachable through the package-private subpath that examples are
// forbidden to import (tools/validate/check-example-imports.mjs) and are not on
// the curated /headless surface yet. Promote them there and these two go away —
// until then the grid cannot say WHY a coin is disabled without them.

/**
 * Short reason to show for an out-of-range swap asset. Prefers a fiat figure
 * ("Minimum amount $10.00") converted from the invoice-side limit using the
 * checkout's own rate, falling back to the provider's generic message.
 */
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
 * The focused swap flow: it replaces the method grid once a pay-in coin is
 * chosen, so the payer sees exactly one payment target at a time.
 */
export const FocusedSwapFlow: React.FC<{ checkout: CheckoutFlow }> = observer(({ checkout }) => {
  const focusedAsset = checkout.focusedSwapAsset;
  if (focusedAsset === null) return null;
  const option = checkout.focusedSwapOption;
  const activeSwap = checkout.activeSwapForFocusedAsset;
  const label = option?.label ?? "this coin";

  return (
    <div className={orClasses.wizard}>
      <div className={orClasses.wizardBody}>
        <div className={orClasses.breadcrumbs}>
          <ul>
            <li>
              <button
                className="link link-hover"
                onClick={() => checkout.clearSwapFocus()}
                type="button"
              >
                {openReceiveCheckoutLabels.switchPaymentMethod}
              </button>
            </li>
            <li>
              <span className={orClasses.breadcrumbCurrent}>
                {option === undefined ? label : `${option.label} · ${option.network_label}`}
              </span>
            </li>
          </ul>
        </div>
        <div className={orClasses.wizardResults}>
          {checkout.swapStartError !== null && activeSwap === undefined ? (
            <SwapStartError
              message={checkout.swapStartError}
              onRetry={() => void checkout.startSwap(focusedAsset)}
            />
          ) : activeSwap === undefined ? (
            <SwapPreparing label={label} />
          ) : (
            renderSwapDepositPanel({
              invoice: activeSwap,
              checkout: checkout.snapshot?.data,
              now: checkout.nowSeconds,
              onRefund: async (attemptId, refundAddress, refundNonce, confirm) => {
                await checkout.refundSwap(attemptId, refundAddress, refundNonce, confirm);
              },
              onBackToLightning: () => void checkout.dismissSwapToLightning(),
            })
          )}
        </div>
      </div>
    </div>
  );
});

/** Inline swap-start failure with retry — never an endless preparing spinner. */
const SwapStartError: React.FC<{ message: string; onRetry: () => void }> = ({
  message,
  onRetry,
}) => (
  <section className={orClasses.swapPanel}>
    <div role="alert">
      <strong className={orClasses.swapHeadingTitle}>Could not prepare the payment address</strong>
      <p className={orClasses.swapWarning}>{message}</p>
      <button className={orClasses.btn} type="button" onClick={onRetry}>
        Try again
      </button>
    </div>
  </section>
);

const SwapPreparing: React.FC<{ label: string }> = ({ label }) => (
  <section className={orClasses.swapPanel}>
    <WaitingState
      waiting={true}
      statusTitle="Preparing payment address"
      statusDetail={`Getting your ${label} payment address…`}
    />
  </section>
);
