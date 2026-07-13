import {
  type CheckoutInvoiceSnapshot,
  type CheckoutSnapshot,
  createOpenReceiveDetailExternalLink,
  createOpenReceiveSwapDisplayModel,
  createOpenReceiveTransactionDetails,
  createQrPayloadSvg,
  formatOpenReceiveSwapLimit,
  openReceiveCheckoutLabels,
  selectCheckoutDisplayInvoice,
  type OpenReceiveBrowserLogger,
  type OpenReceiveQrEncoder,
  type OpenReceiveTransactionDetailRow,
  orClasses,
} from "@openreceive/browser/internal";
import * as React from "react";
import { WaitingState } from "./components.ts";
import { useOpenReceiveTransientValue } from "./hooks.ts";
import type { OpenReceiveSwapOptionDisplay } from "./types.ts";
import { copyOpenReceiveText, joinClassNames } from "./utils.ts";

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
      className: orClasses.swapActions,
    },
    shown.map((option) => {
      const disabled = option.available === false;
      const limitMessage = swapOptionLimitMessage(option, options.checkout);
      return React.createElement(
        "div",
        {
          className: orClasses.swapAction,
          key: option.pay_in_asset,
        },
        disabled
          ? limitMessage === undefined
            ? null
            : React.createElement("p", { className: orClasses.swapWarning }, limitMessage)
          : option.pay_amount === undefined
            ? null
            : React.createElement(
                "p",
                {
                  className: orClasses.swapEstimate,
                },
                `Estimated ${option.pay_amount} ${option.label} to settle this checkout.`,
              ),
        React.createElement(
          "button",
          {
            className: orClasses.swapStart,
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
      className: orClasses.swapPanel,
    },
    React.createElement(WaitingState, {
      waiting: true,
      statusTitle: "Preparing payment address",
      statusDetail: `Getting your ${assetLabel} payment address…`,
    }),
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
      className: orClasses.swapPanel,
    },
    React.createElement(
      "div",
      {
        className: orClasses.swapHeading,
      },
      React.createElement(
        "strong",
        { className: orClasses.swapHeadingTitle },
        `${quote.label} unavailable`,
      ),
    ),
    React.createElement("p", { className: orClasses.swapWarning }, detail),
    range === undefined ? null : React.createElement("p", { className: orClasses.swapWarning }, range),
    React.createElement(
      "p",
      {
        className: orClasses.swapProgress,
      },
      "Choose another asset above, or pay the Lightning invoice at the top of this page.",
    ),
  );
}

export function renderSwapDepositPanel(options: {
  readonly invoice: CheckoutInvoiceSnapshot;
  readonly checkout?: CheckoutSnapshot;
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
      className: orClasses.swapBack,
      onClick: options.onBackToLightning,
      type: "button",
    },
    "Pay with Lightning instead",
  );
  const heading = React.createElement(
    "div",
    {
      className: orClasses.swapHeading,
    },
    React.createElement("strong", { className: orClasses.swapHeadingTitle }, display.providerStateLabel),
    React.createElement("span", { className: orClasses.swapHeadingDetail }, display.providerStateDetail),
  );
  // The "still waiting" states borrow the Lightning section's status card (spinner +
  // title + detail) so the swap panel that replaces it reads the same.
  const waitingCard = (countdownLabel?: string) =>
    React.createElement(WaitingState, {
      waiting: true,
      statusTitle: display.providerStateLabel,
      statusDetail: display.providerStateDetail,
      ...(countdownLabel === undefined ? {} : { countdownLabel }),
    });

  if (display.state === "creating") {
    return React.createElement(
      "section",
      {
        className: orClasses.swapPanel,
      },
      waitingCard(),
      backButton,
    );
  }

  if (display.state === "settled") {
    const highlightRows = [
      ...(display.depositTxId === undefined
        ? []
        : renderSwapCopyRow("Deposit transaction", display.depositTxId, {
            ...options,
            payInAsset: display.payInAsset,
          })),
      ...(display.payoutTxId === undefined
        ? []
        : renderSwapCopyRow("Lightning payout", display.payoutTxId, options)),
      ...(display.providerOrderId === undefined
        ? []
        : renderSwapCopyRow("Provider order", display.providerOrderId, options)),
    ];
    const displayInvoice =
      options.checkout === undefined ? undefined : selectCheckoutDisplayInvoice(options.checkout);
    const bolt11 =
      typeof options.invoice.invoice === "string"
        ? options.invoice.invoice
        : typeof displayInvoice?.invoice === "string"
          ? displayInvoice.invoice
          : undefined;
    return React.createElement(
      "section",
      {
        className: orClasses.swapPanel,
      },
      React.createElement(WaitingState, {
        waiting: false,
        statusTitle: display.providerStateLabel,
        statusDetail: display.providerStateDetail,
      }),
      highlightRows.length === 0
        ? null
        : React.createElement(
            "dl",
            {
              className: orClasses.swapDetails,
            },
            highlightRows,
          ),
      renderTransactionDetailsCollapse(
        createOpenReceiveTransactionDetails({
          ...(options.checkout === undefined
            ? {}
            : {
                order_id: options.checkout.order_id,
                checkout_id: options.checkout.checkout_id,
                ...(options.checkout.fiat === undefined
                  ? {}
                  : { fiat_quote: { fiat: options.checkout.fiat } }),
                ...(options.checkout.amount_msats === undefined
                  ? {}
                  : { amount_msats: options.checkout.amount_msats }),
              }),
          invoice_id: options.invoice.invoice_id,
          ...(bolt11 === undefined ? {} : { invoice: bolt11 }),
          rail: options.invoice.rail,
          ...(options.invoice.payment_hash === undefined
            ? displayInvoice?.payment_hash === undefined
              ? {}
              : { payment_hash: displayInvoice.payment_hash }
            : { payment_hash: options.invoice.payment_hash }),
          ...(options.invoice.amount_msats === undefined
            ? {}
            : { amount_msats: options.invoice.amount_msats }),
          ...(options.invoice.fiat_quote === undefined
            ? {}
            : { fiat_quote: options.invoice.fiat_quote }),
          ...(options.invoice.transaction_state === undefined
            ? {}
            : { transaction_state: options.invoice.transaction_state }),
          ...(options.invoice.workflow_state === undefined
            ? {}
            : { workflow_state: options.invoice.workflow_state }),
          ...(options.invoice.expires_at === undefined
            ? {}
            : { expires_at: options.invoice.expires_at }),
          ...((options.checkout?.paid_at ?? options.invoice.settled_at) === undefined
            ? {}
            : { settled_at: options.checkout?.paid_at ?? options.invoice.settled_at }),
          ...(options.invoice.swap === undefined ? {} : { swap: options.invoice.swap }),
        }),
        options,
      ),
    );
  }

  if (display.state === "progress") {
    return React.createElement(
      "section",
      {
        className: orClasses.swapPanel,
      },
      waitingCard(),
      renderSwapSupportDetails(display, options),
    );
  }

  if (display.state === "expired") {
    return React.createElement(
      "section",
      {
        className: orClasses.swapPanel,
      },
      heading,
      React.createElement(
        "p",
        {
          className: orClasses.swapWarning,
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
        className: orClasses.swapPanel,
      },
      heading,
      React.createElement(
        "p",
        {
          className: orClasses.swapWarning,
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
        className: orClasses.swapPanel,
      },
      heading,
      React.createElement(
        "dl",
        {
          className: orClasses.swapDetails,
        },
        display.refundAddress === undefined
          ? null
          : renderSwapCopyRow("Refund address", display.refundAddress, {
              ...options,
              payInAsset: display.payInAsset,
            }),
        display.refundTxId === undefined
          ? null
          : renderSwapCopyRow("Refund transaction", display.refundTxId, {
              ...options,
              payInAsset: display.payInAsset,
            }),
      ),
      renderSwapSupportDetails(display, options),
    );
  }

  if (display.state === "attention" || display.state === "failed") {
    return React.createElement(
      "section",
      {
        className: orClasses.swapPanel,
      },
      heading,
      React.createElement(
        "p",
        { className: orClasses.swapWarning },
        "This payment needs support review.",
      ),
      renderSwapSupportDetails(display, options),
      backButton,
    );
  }

  return React.createElement(
    "section",
    {
      className: orClasses.swapPanel,
    },
    React.createElement(
      "p",
      {
        className: orClasses.swapInstruction,
      },
      "Pay ",
      React.createElement("strong", null, `${display.depositAmount} ${display.assetLabel}`),
      " to this address",
    ),
    React.createElement(
      "div",
      {
        className: orClasses.swapDepositLayout,
      },
      React.createElement(SwapPayloadQRCode, {
        payload: display.qrPayload,
        encoder: options.encoder,
        onError: options.onError,
      }),
      React.createElement(
        "div",
        {
          className: orClasses.swapDepositSide,
        },
        React.createElement(
          "dl",
          {
            className: orClasses.swapDetails,
          },
          renderSwapCopyRow("Address", display.depositAddress, {
            ...options,
            payInAsset: display.payInAsset,
          }),
          memo === undefined ? null : renderSwapCopyRow("Memo", memo, options),
          renderSwapCopyRow("Amount", display.depositAmount, options),
        ),
        waitingCard(display.countdownLabel),
        renderSwapFeeBreakdown(display.feeBreakdown),
      ),
    ),
    React.createElement(
      "p",
      {
        className: orClasses.swapWarning,
      },
      display.networkWarning,
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
    { className: orClasses.swapBreakdown },
    React.createElement("p", { className: orClasses.swapBreakdownTitle }, "Payment breakdown"),
    React.createElement(
      "dl",
      { className: joinClassNames(orClasses.swapDetails, orClasses.swapBreakdownRows) },
      React.createElement("dt", { key: "cart-label", className: orClasses.swapDetailsDt }, "Cart total"),
      React.createElement("dd", { key: "cart-value" }, breakdown.cartTotal),
      React.createElement("dt", { key: "send-label", className: orClasses.swapDetailsDt }, "You send"),
      React.createElement("dd", { key: "send-value" }, breakdown.youSend),
      React.createElement(
        "dt",
        { key: "fee-label", className: orClasses.swapDetailsDt },
        "Swap + network fees",
      ),
      React.createElement("dd", { key: "fee-value" }, feeValue),
    ),
    React.createElement(
      "p",
      { className: orClasses.swapBreakdownNote },
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
    readonly payInAsset?: string;
    readonly href?: string;
    readonly hrefLabel?: string;
  },
  displayValue: string = value,
): readonly React.ReactElement[] {
  const link =
    options.href === undefined
      ? createOpenReceiveDetailExternalLink({
          label,
          value,
          ...(options.payInAsset === undefined ? {} : { payInAsset: options.payInAsset }),
        })
      : {
          href: options.href,
          hrefLabel: options.hrefLabel ?? openReceiveCheckoutLabels.viewOnExplorer,
        };
  return [
    React.createElement("dt", { key: `${label}-label`, className: orClasses.swapDetailsDt }, label),
    React.createElement(
      "dd",
      { key: `${label}-value`, className: orClasses.swapDetailsDd },
      React.createElement("code", { className: orClasses.swapDetailsCode }, displayValue),
      React.createElement(
        "div",
        { className: orClasses.swapDetailsActions },
        React.createElement(SwapCopyButton, {
          value,
          clipboard: options.clipboard,
          onError: options.onError,
        }),
        link === undefined
          ? null
          : React.createElement(
              "a",
              {
                className: orClasses.swapDetailsLink,
                href: link.href,
                rel: "noreferrer",
                target: "_blank",
              },
              link.hrefLabel,
            ),
      ),
    ),
  ];
}

function SwapCopyButton(props: {
  readonly value: string;
  readonly clipboard?: Pick<Clipboard, "writeText">;
  readonly onError?: (error: unknown) => void;
}): React.ReactElement {
  const [copied, showCopied] = useOpenReceiveTransientValue<boolean>(false);
  return React.createElement(
    "button",
    {
      className: orClasses.btnSm,
      onClick: () => {
        void copyOpenReceiveText(props.value, props.clipboard)
          .then(() => showCopied(true))
          .catch(props.onError);
      },
      type: "button",
    },
    copied ? openReceiveCheckoutLabels.copied : "Copy",
  );
}

function renderSwapSupportDetails(
  display: NonNullable<ReturnType<typeof createOpenReceiveSwapDisplayModel>>,
  options: {
    readonly clipboard?: Pick<Clipboard, "writeText">;
    readonly onError?: (error: unknown) => void;
  },
): React.ReactElement | null {
  const rowOptions = { ...options, payInAsset: display.payInAsset };
  const rows = [
    ...(display.depositTxId === undefined
      ? []
      : renderSwapCopyRow("Deposit transaction", display.depositTxId, rowOptions)),
    ...(display.payoutTxId === undefined
      ? []
      : renderSwapCopyRow("Lightning payout", display.payoutTxId, options)),
    ...(display.refundTxId === undefined
      ? []
      : renderSwapCopyRow("Refund transaction", display.refundTxId, rowOptions)),
    ...(display.providerOrderId === undefined
      ? []
      : renderSwapCopyRow("Provider order", display.providerOrderId, options)),
  ];
  if (rows.length === 0) return null;
  return React.createElement(
    "details",
    {
      className: orClasses.swapSupport,
    },
    React.createElement("summary", { className: orClasses.swapSupportTitle }, "Payment details"),
    React.createElement(
      "div",
      { className: orClasses.swapSupportContent },
      React.createElement("dl", { className: orClasses.swapDetails }, rows),
    ),
  );
}

function renderTransactionDetailsCollapse(
  rows: readonly OpenReceiveTransactionDetailRow[],
  options: {
    readonly clipboard?: Pick<Clipboard, "writeText">;
    readonly onError?: (error: unknown) => void;
  },
): React.ReactElement | null {
  if (rows.length === 0) return null;
  return React.createElement(
    "details",
    {
      className: orClasses.transactionDetails,
    },
    React.createElement(
      "summary",
      { className: orClasses.transactionDetailsTitle },
      openReceiveCheckoutLabels.transactionDetails,
    ),
    React.createElement(
      "div",
      { className: orClasses.transactionDetailsContent },
      React.createElement(
        "dl",
        { className: orClasses.swapDetails },
        rows.flatMap((row) =>
          renderSwapCopyRow(
            row.label,
            row.copyValue ?? row.value,
            {
              ...options,
              ...(row.href === undefined
                ? {}
                : {
                    href: row.href,
                    hrefLabel: row.hrefLabel ?? openReceiveCheckoutLabels.viewOnExplorer,
                  }),
            },
            row.value,
          ),
        ),
      ),
    ),
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
      className: orClasses.swapRefund,
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
            className: orClasses.swapWarning,
          },
          `Confirm refund to ${props.submittedRefundAddress}.`,
        ),
    React.createElement("input", {
      autoComplete: "off",
      className: orClasses.swapRefundInput,
      onChange: (event) => setRefundAddress(event.currentTarget.value),
      placeholder: `${props.networkLabel} refund address`,
      required: true,
      type: "text",
      value: refundAddress,
    }),
    React.createElement(
      "button",
      {
        className: orClasses.btn,
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
    className: orClasses.swapQr,
    src: imageSource,
  });
}
