import {
  type CheckoutInvoiceSnapshot,
  type CheckoutSnapshot,
  createOpenReceiveSwapDisplayModel,
  createQrPayloadSvg,
  formatOpenReceiveSwapLimit,
  type OpenReceiveBrowserLogger,
  type OpenReceiveQrEncoder,
} from "@openreceive/browser/internal";
import * as React from "react";
import { WaitingState } from "./components.ts";
import type { OpenReceiveSwapOptionDisplay } from "./types.ts";
import { copyOpenReceiveText } from "./utils.ts";

// Short reason to show for an out-of-range swap asset. Prefers a fiat figure
// ("Minimum payment $10.00") converted from the invoice-side limit using the
// checkout's own rate, falling back to the provider's generic message.
export function swapOptionLimitMessage(
  option: OpenReceiveSwapOptionDisplay,
  checkout: CheckoutSnapshot | undefined,
): string | undefined {
  if (option.available !== false) return undefined;
  // Prefer a fiat figure ("Minimum payment $10.00"); fall back to the pay-in asset's
  // own units ("Minimum 5 USDT") when the provider only reports pay-side limits.
  if (option.unavailable_reason === "amount_too_small") {
    const fiat =
      checkout === undefined
        ? undefined
        : formatOpenReceiveSwapLimit(checkout, option.minimum_invoice_amount_msats);
    if (fiat !== undefined) return `Minimum payment ${fiat}`;
    if (option.minimum_pay_amount !== undefined) {
      return `Minimum ${option.minimum_pay_amount} ${option.label}`;
    }
  }
  if (option.unavailable_reason === "amount_too_large") {
    const fiat =
      checkout === undefined
        ? undefined
        : formatOpenReceiveSwapLimit(checkout, option.maximum_invoice_amount_msats);
    if (fiat !== undefined) return `Maximum payment ${fiat}`;
    if (option.maximum_pay_amount !== undefined) {
      return `Maximum ${option.maximum_pay_amount} ${option.label}`;
    }
  }
  return option.unavailable_message;
}

export function renderSwapActions(options: {
  readonly enabled: boolean;
  readonly options: readonly OpenReceiveSwapOptionDisplay[];
  readonly startingAsset: string | null;
  readonly onStart: (payInAsset: string) => Promise<void>;
  readonly checkout?: CheckoutSnapshot;
}): React.ReactElement | null {
  // Out-of-range assets are kept in the list but rendered as a disabled button
  // with the limit reason, instead of being hidden.
  const shown = options.options.filter((option) => option.provider.length > 0);
  if (!options.enabled || shown.length === 0) return null;

  return React.createElement(
    "div",
    {
      className: "or-swap-actions",
    },
    shown.map((option) => {
      const disabled = option.available === false;
      const limitMessage = swapOptionLimitMessage(option, options.checkout);
      return React.createElement(
        "div",
        {
          className: "or-swap-action",
          key: option.pay_in_asset,
        },
        disabled
          ? limitMessage === undefined
            ? null
            : React.createElement("p", { className: "or-swap-warning" }, limitMessage)
          : option.pay_amount === undefined
            ? null
            : React.createElement(
                "p",
                {
                  className: "or-swap-estimate",
                },
                `Estimated ${option.pay_amount} ${option.label} to settle this checkout.`,
              ),
        React.createElement(
          "button",
          {
            className: "or-swap-start",
            disabled: disabled || options.startingAsset !== null,
            onClick: disabled
              ? undefined
              : () => {
                  void options.onStart(option.pay_in_asset);
                },
            type: "button",
          },
          options.startingAsset === option.pay_in_asset
            ? "Preparing..."
            : `Create ${option.label} (${option.network_label}) payment address`,
        ),
      );
    }),
  );
}

export function renderSwapPreparing(assetLabel: string): React.ReactElement {
  return React.createElement(
    "section",
    {
      className: "or-swap-panel",
    },
    React.createElement(
      "div",
      {
        className: "or-swap-heading",
      },
      React.createElement("strong", null, "Preparing payment address"),
      React.createElement("span", null, "One moment"),
    ),
    React.createElement(
      "p",
      {
        className: "or-swap-progress",
      },
      `Getting your ${assetLabel} payment address…`,
    ),
  );
}

export function renderSwapUnavailable(
  quote: OpenReceiveSwapOptionDisplay,
  checkout: CheckoutSnapshot | undefined,
): React.ReactElement {
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
  return React.createElement(
    "section",
    {
      className: "or-swap-panel",
    },
    React.createElement(
      "div",
      {
        className: "or-swap-heading",
      },
      React.createElement("strong", null, `${quote.label} unavailable`),
    ),
    React.createElement("p", { className: "or-swap-warning" }, detail),
    range === undefined ? null : React.createElement("p", { className: "or-swap-warning" }, range),
    React.createElement(
      "p",
      {
        className: "or-swap-progress",
      },
      "Choose another asset above, or pay the Lightning invoice at the top of this page.",
    ),
  );
}

export function renderSwapDepositPanel(options: {
  readonly invoice: CheckoutInvoiceSnapshot;
  readonly now?: number;
  readonly encoder?: OpenReceiveQrEncoder;
  readonly clipboard?: Pick<Clipboard, "writeText">;
  readonly logger?: OpenReceiveBrowserLogger;
  readonly onError?: (error: unknown) => void;
  readonly onRefund: (
    attemptId: string,
    refundAddress: string,
    refundNonce: string,
    confirm: boolean,
  ) => Promise<void>;
  readonly onBackToLightning: () => void;
}): React.ReactElement | null {
  const display = createOpenReceiveSwapDisplayModel(
    options.invoice,
    options.now === undefined ? {} : { now: options.now },
  );
  if (display === undefined) return null;
  const memo = display.depositMemo;
  const backButton = React.createElement(
    "button",
    {
      className: "or-swap-back",
      onClick: options.onBackToLightning,
      type: "button",
    },
    "Pay with Lightning instead",
  );
  const heading = React.createElement(
    "div",
    {
      className: "or-swap-heading",
    },
    React.createElement("strong", null, display.providerStateLabel),
    React.createElement("span", null, display.providerStateDetail),
  );
  // The "still waiting" states borrow the Lightning section's status card (spinner +
  // title + detail) so the swap panel that replaces it reads the same.
  const waitingCard = React.createElement(WaitingState, {
    waiting: true,
    statusTitle: display.providerStateLabel,
    statusDetail: display.providerStateDetail,
  });

  if (display.state === "creating") {
    return React.createElement(
      "section",
      {
        className: "or-swap-panel",
      },
      waitingCard,
      backButton,
    );
  }

  if (display.state === "settled") {
    const detailRows = [
      ...(display.depositTxId === undefined
        ? []
        : renderSwapCopyRow("Deposit transaction", display.depositTxId, options)),
      ...(display.payoutTxId === undefined
        ? []
        : renderSwapCopyRow("Lightning payout", display.payoutTxId, options)),
      ...(display.providerOrderId === undefined
        ? []
        : renderSwapCopyRow("Provider order", display.providerOrderId, options)),
    ];
    return React.createElement(
      "section",
      {
        className: "or-swap-panel",
      },
      React.createElement(WaitingState, {
        waiting: false,
        statusTitle: display.providerStateLabel,
        statusDetail: display.providerStateDetail,
      }),
      detailRows.length === 0
        ? null
        : React.createElement(
            "dl",
            {
              className: "or-swap-details",
            },
            detailRows,
          ),
    );
  }

  if (display.state === "progress") {
    return React.createElement(
      "section",
      {
        className: "or-swap-panel",
      },
      heading,
      renderSwapSupportDetails(display, options),
    );
  }

  if (display.state === "expired") {
    return React.createElement(
      "section",
      {
        className: "or-swap-panel",
      },
      heading,
      React.createElement(
        "p",
        {
          className: "or-swap-warning",
        },
        "This payment address expired without a detected payment. Create a new payment address to try again.",
      ),
      renderSwapSupportDetails(display, options),
      backButton,
    );
  }

  if (display.state === "refund_required") {
    return React.createElement(
      "section",
      {
        className: "or-swap-panel",
      },
      heading,
      React.createElement(
        "p",
        {
          className: "or-swap-warning",
        },
        `Use a ${display.networkLabel} address you control. Do not paste the deposit address.`,
      ),
      React.createElement(SwapRefundForm, {
        attemptId: display.attemptId,
        networkLabel: display.networkLabel,
        submittedRefundAddress: display.refundAddress,
        refundNonce: display.refundNonce,
        onRefund: options.onRefund,
        onError: options.onError,
      }),
      renderSwapSupportDetails(display, options),
    );
  }

  if (display.state === "refund_pending" || display.state === "refunded") {
    return React.createElement(
      "section",
      {
        className: "or-swap-panel",
      },
      heading,
      React.createElement(
        "dl",
        {
          className: "or-swap-details",
        },
        display.refundAddress === undefined
          ? null
          : renderSwapCopyRow("Refund address", display.refundAddress, options),
        display.refundTxId === undefined
          ? null
          : renderSwapCopyRow("Refund transaction", display.refundTxId, options),
      ),
      renderSwapSupportDetails(display, options),
    );
  }

  if (display.state === "attention" || display.state === "failed") {
    return React.createElement(
      "section",
      {
        className: "or-swap-panel",
      },
      heading,
      React.createElement(
        "p",
        { className: "or-swap-warning" },
        "This payment needs support review.",
      ),
      renderSwapSupportDetails(display, options),
      backButton,
    );
  }

  return React.createElement(
    "section",
    {
      className: "or-swap-panel",
    },
    waitingCard,
    React.createElement(
      "p",
      {
        className: "or-swap-instruction",
      },
      "Pay ",
      React.createElement("strong", null, `${display.depositAmount} ${display.assetLabel}`),
      " to this address",
    ),
    renderSwapFeeBreakdown(display.feeBreakdown),
    React.createElement(SwapPayloadQRCode, {
      payload: display.qrPayload,
      encoder: options.encoder,
      onError: options.onError,
    }),
    React.createElement(
      "dl",
      {
        className: "or-swap-details",
      },
      renderSwapCopyRow("Address", display.depositAddress, options),
      memo === undefined ? null : renderSwapCopyRow("Memo", memo, options),
      renderSwapCopyRow("Amount", display.depositAmount, options),
    ),
    React.createElement(
      "p",
      {
        className: "or-swap-warning",
      },
      display.networkWarning,
    ),
    React.createElement(
      "p",
      {
        className: "or-swap-countdown",
      },
      "Payment window ",
      React.createElement("strong", null, display.countdownLabel),
    ),
    React.createElement(
      "p",
      {
        className: "or-swap-warning",
      },
      `Pay with one method only. If you already sent ${display.assetLabel}, do not also pay the Lightning invoice.`,
    ),
    backButton,
  );
}

// Explains why the payer sends more crypto than the cart total: the swap provider's
// exchange rate and network fees are baked into the deposit amount. Renders nothing
// when the provider did not report fiat equivalents.
function renderSwapFeeBreakdown(
  breakdown: NonNullable<ReturnType<typeof createOpenReceiveSwapDisplayModel>>["feeBreakdown"],
): React.ReactElement | null {
  if (breakdown === undefined) return null;
  const feeValue =
    breakdown.feePercent === undefined
      ? breakdown.fee
      : `${breakdown.fee} (${breakdown.feePercent})`;
  return React.createElement(
    "div",
    { className: "or-swap-breakdown" },
    React.createElement("p", { className: "or-swap-breakdown-title" }, "Payment breakdown"),
    React.createElement(
      "dl",
      { className: "or-swap-details or-swap-breakdown-rows" },
      React.createElement("dt", { key: "cart-label" }, "Cart total"),
      React.createElement("dd", { key: "cart-value" }, breakdown.cartTotal),
      React.createElement("dt", { key: "send-label" }, "You send"),
      React.createElement("dd", { key: "send-value" }, breakdown.youSend),
      React.createElement("dt", { key: "fee-label" }, "Swap + network fees"),
      React.createElement("dd", { key: "fee-value" }, feeValue),
    ),
    React.createElement(
      "p",
      { className: "or-swap-breakdown-note" },
      "The swap provider's exchange rate and network fees are included in the amount above.",
    ),
  );
}

function renderSwapCopyRow(
  label: string,
  value: string,
  options: {
    readonly clipboard?: Pick<Clipboard, "writeText">;
    readonly onError?: (error: unknown) => void;
  },
): readonly React.ReactElement[] {
  return [
    React.createElement("dt", { key: `${label}-label` }, label),
    React.createElement(
      "dd",
      { key: `${label}-value` },
      React.createElement("code", null, value),
      React.createElement(
        "button",
        {
          onClick: () => {
            void copyOpenReceiveText(value, options.clipboard).catch(options.onError);
          },
          type: "button",
        },
        "Copy",
      ),
    ),
  ];
}

function renderSwapSupportDetails(
  display: NonNullable<ReturnType<typeof createOpenReceiveSwapDisplayModel>>,
  options: {
    readonly clipboard?: Pick<Clipboard, "writeText">;
    readonly onError?: (error: unknown) => void;
  },
): React.ReactElement | null {
  const rows = [
    ...(display.depositTxId === undefined
      ? []
      : renderSwapCopyRow("Deposit transaction", display.depositTxId, options)),
    ...(display.payoutTxId === undefined
      ? []
      : renderSwapCopyRow("Lightning payout", display.payoutTxId, options)),
    ...(display.refundTxId === undefined
      ? []
      : renderSwapCopyRow("Refund transaction", display.refundTxId, options)),
    ...(display.providerOrderId === undefined
      ? []
      : renderSwapCopyRow("Provider order", display.providerOrderId, options)),
  ];
  if (rows.length === 0) return null;
  return React.createElement(
    "details",
    {
      className: "or-swap-support",
    },
    React.createElement("summary", null, "Payment details"),
    React.createElement("dl", { className: "or-swap-details" }, rows),
  );
}

function SwapRefundForm(props: {
  readonly attemptId: string;
  readonly networkLabel: string;
  readonly submittedRefundAddress?: string;
  readonly refundNonce?: string;
  readonly onRefund: (
    attemptId: string,
    refundAddress: string,
    refundNonce: string,
    confirm: boolean,
  ) => Promise<void>;
  readonly onError?: (error: unknown) => void;
}): React.ReactElement {
  const [refundAddress, setRefundAddress] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const address = refundAddress.trim();
  const confirm =
    address.length > 0 &&
    props.submittedRefundAddress !== undefined &&
    props.submittedRefundAddress === address;
  const disabled = submitting || props.refundNonce === undefined;
  return React.createElement(
    "form",
    {
      className: "or-swap-refund",
      onSubmit: (event) => {
        event.preventDefault();
        if (address.length === 0 || props.refundNonce === undefined) return;
        setSubmitting(true);
        void props
          .onRefund(props.attemptId, address, props.refundNonce, confirm)
          .catch(props.onError)
          .finally(() => setSubmitting(false));
      },
    },
    props.submittedRefundAddress === undefined
      ? null
      : React.createElement(
          "p",
          {
            className: "or-swap-warning",
          },
          `Confirm refund to ${props.submittedRefundAddress}.`,
        ),
    React.createElement("input", {
      autoComplete: "off",
      onChange: (event) => setRefundAddress(event.currentTarget.value),
      placeholder: `${props.networkLabel} refund address`,
      required: true,
      type: "text",
      value: refundAddress,
    }),
    React.createElement(
      "button",
      {
        disabled,
        type: "submit",
      },
      submitting ? "Submitting..." : confirm ? "Confirm refund" : "Review refund address",
    ),
  );
}

function SwapPayloadQRCode(props: {
  readonly payload: string;
  readonly encoder?: OpenReceiveQrEncoder;
  readonly onError?: (error: unknown) => void;
}): React.ReactElement {
  const [svg, setSvg] = React.useState("");
  React.useEffect(() => {
    let cancelled = false;
    createQrPayloadSvg(props.payload, { encoder: props.encoder, width: 220 })
      .then((nextSvg) => {
        if (!cancelled) setSvg(nextSvg);
      })
      .catch((error) => {
        if (!cancelled) props.onError?.(error);
      });
    return () => {
      cancelled = true;
    };
  }, [props.payload, props.encoder, props.onError]);

  const imageSource =
    svg.length === 0 ? undefined : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

  return React.createElement("img", {
    alt: "",
    className: "or-swap-qr",
    src: imageSource,
  });
}
