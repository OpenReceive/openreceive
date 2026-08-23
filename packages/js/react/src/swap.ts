import {
  type CheckoutInvoiceSnapshot,
  type CheckoutSnapshot,
  createDetailExternalLink,
  createSwapDisplayModel,
  createTransactionDetails,
  createQrPayloadSvg,
  getSwapRefundFormError,
  type BrowserLogger,
  type QrEncoder,
  type SwapDisplayModel,
  checkoutLabels,
  swapOptionLimitMessage,
  orClasses,
  selectCheckoutDisplayInvoice,
} from "@openreceive/browser/headless";
import * as React from "react";
import { ClipboardIcon, WaitingState } from "./components.ts";
import { useTransientValue } from "./hooks.ts";
import { TransactionDetails } from "./transaction-details.ts";
import type { SwapOptionDisplay } from "./types.ts";
import { copyText, joinClassNames, selectAllInputHandlers } from "./utils.ts";

export function renderSwapActions(options: {
  readonly enabled: boolean;
  readonly options: readonly SwapOptionDisplay[];
  readonly startingAsset: string | null;
  readonly onStart: (payInAsset: string) => void;
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
            onClick: disabled ? undefined : () => options.onStart(option.pay_in_asset),
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

/** Inline swap-start failure with retry — never an endless preparing spinner. */
export function renderSwapStartError(
  message: string,
  onRetry: (() => void) | undefined,
): React.ReactElement {
  return React.createElement(
    "section",
    {
      className: orClasses.swapPanel,
    },
    React.createElement(
      "div",
      { role: "alert" },
      React.createElement(
        "strong",
        { className: orClasses.swapHeadingTitle },
        "Could not prepare the payment address",
      ),
      React.createElement("p", { className: orClasses.swapWarning }, message),
      onRetry === undefined
        ? null
        : React.createElement(
            "button",
            {
              className: orClasses.btn,
              type: "button",
              onClick: onRetry,
            },
            "Try again",
          ),
    ),
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
  quote: SwapOptionDisplay,
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
    range === undefined
      ? null
      : React.createElement("p", { className: orClasses.swapWarning }, range),
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
  readonly encoder?: QrEncoder;
  readonly clipboard?: Pick<Clipboard, "writeText">;
  readonly logger?: BrowserLogger | false;
  readonly onError?: (error: unknown) => void;
  readonly onRefund: (
    attemptId: string,
    refundAddress: string,
    refundNonce: string,
    confirm: boolean,
  ) => Promise<void>;
  readonly onBackToLightning: () => void;
}): React.ReactElement | null {
  const display = createSwapDisplayModel(
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
    React.createElement(
      "strong",
      { className: orClasses.swapHeadingTitle },
      display.providerStateLabel,
    ),
    React.createElement(
      "span",
      { className: orClasses.swapHeadingDetail },
      display.providerStateDetail,
    ),
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
      React.createElement(TransactionDetails, {
        state: createTransactionDetails({
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
        clipboard: options.clipboard,
        onError: options.onError,
      }),
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
      renderSwapRefundFacts(display, options),
      React.createElement(
        "p",
        {
          className: orClasses.swapWarning,
        },
        `Use a ${display.networkLabel} address you control. Do not paste the deposit address.`,
      ),
      React.createElement(SwapRefundForm, {
        attemptId: display.attemptId,
        payInAsset: display.payInAsset,
        networkLabel: display.networkLabel,
        submittedRefundAddress: display.refundAddress,
        refundNonce: display.refundNonce,
        onRefund: options.onRefund,
        onError: options.onError,
      }),
      renderSwapSupportDetails(display, options),
      renderSwapRefundReturnWarning(),
    );
  }

  if (display.state === "refund_pending" || display.state === "refunded") {
    return React.createElement(
      "section",
      {
        className: orClasses.swapPanel,
      },
      heading,
      renderSwapRefundFacts(display, options),
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
      renderSwapRefundReturnWarning(),
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
    renderSwapNetworkWarning(display),
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
          // Explorer stays hidden until payment completes (tx ids / settled details).
          renderSwapCopyRow("Address", display.depositAddress, options),
          memo === undefined ? null : renderSwapCopyRow("Memo", memo, options),
          renderSwapCopyRow("Amount", display.depositAmount, options),
        ),
        waitingCard(display.countdownLabel),
        renderSwapFeeBreakdown(display.feeBreakdown),
      ),
    ),
    backButton,
  );
}

function renderSwapNetworkWarning(
  display: Pick<
    SwapDisplayModel,
    "networkWarningTitle" | "networkWarningEmphasis" | "networkWarning"
  >,
): React.ReactElement {
  const emphasisStart = display.networkWarning.indexOf(display.networkWarningEmphasis);
  const before =
    emphasisStart === -1 ? display.networkWarning : display.networkWarning.slice(0, emphasisStart);
  const after =
    emphasisStart === -1
      ? ""
      : display.networkWarning.slice(emphasisStart + display.networkWarningEmphasis.length);
  return React.createElement(
    "div",
    {
      role: "alert",
      className: orClasses.swapNetworkWarning,
    },
    React.createElement(
      "svg",
      {
        xmlns: "http://www.w3.org/2000/svg",
        fill: "none",
        viewBox: "0 0 24 24",
        className: orClasses.swapNetworkWarningIcon,
        "aria-hidden": "true",
      },
      React.createElement("path", {
        strokeLinecap: "round",
        strokeLinejoin: "round",
        strokeWidth: 2,
        d: "M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z",
      }),
    ),
    React.createElement(
      "div",
      { className: orClasses.swapNetworkWarningContent },
      React.createElement(
        "p",
        { className: orClasses.swapNetworkWarningTitle },
        display.networkWarningTitle,
      ),
      React.createElement(
        "p",
        { className: orClasses.swapNetworkWarningBody },
        before,
        emphasisStart === -1
          ? null
          : React.createElement(
              "strong",
              { className: orClasses.swapNetworkWarningEmphasis },
              display.networkWarningEmphasis,
            ),
        after,
      ),
    ),
  );
}

function renderSwapRefundFacts(
  display: SwapDisplayModel,
  options: {
    readonly clipboard?: Pick<Clipboard, "writeText">;
    readonly onError?: (error: unknown) => void;
  },
): React.ReactElement | null {
  const rows = [
    ...(display.depositReceivedAmount === undefined
      ? []
      : renderSwapCopyRow(
          "Amount received",
          `${display.depositReceivedAmount} ${display.assetLabel}`,
          options,
        )),
    ...(display.depositReceivedAmount === undefined
      ? []
      : renderSwapCopyRow(
          "Amount required",
          `${display.depositAmount} ${display.assetLabel}`,
          options,
        )),
    ...(display.refundAmount === undefined
      ? []
      : renderSwapCopyRow(
          "Estimated refund",
          `${display.refundAmount} ${display.assetLabel}`,
          options,
        )),
  ];
  if (rows.length === 0) return null;
  return React.createElement("dl", { className: orClasses.swapDetails }, rows);
}

// Explains why the payer sends more crypto than the cart total: the swap provider's
// exchange rate and network fees are baked into the deposit amount. Renders nothing
// when the provider did not report fiat equivalents.
function renderSwapFeeBreakdown(
  breakdown: SwapDisplayModel["feeBreakdown"],
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
      React.createElement(
        "dt",
        { key: "cart-label", className: orClasses.swapDetailsDt },
        "Cart total",
      ),
      React.createElement("dd", { key: "cart-value" }, breakdown.cartTotal),
      React.createElement(
        "dt",
        { key: "send-label", className: orClasses.swapDetailsDt },
        "You send",
      ),
      React.createElement("dd", { key: "send-value" }, breakdown.youSend),
      React.createElement(
        "dt",
        { key: "fee-label", className: orClasses.swapDetailsDt },
        "Swap + network fees",
      ),
      React.createElement("dd", { key: "fee-value" }, feeValue),
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
      ? createDetailExternalLink({
          label,
          value,
          ...(options.payInAsset === undefined ? {} : { payInAsset: options.payInAsset }),
        })
      : {
          href: options.href,
          hrefLabel: options.hrefLabel ?? checkoutLabels.viewOnExplorer,
        };
  const valueField =
    label === "Address" || label === "Amount"
      ? React.createElement("input", {
          className: orClasses.swapDetailsInput,
          type: "text",
          readOnly: true,
          value: displayValue,
          "aria-label": label,
          ...selectAllInputHandlers(),
        })
      : React.createElement("code", { className: orClasses.swapDetailsCode }, displayValue);
  return [
    React.createElement("dt", { key: `${label}-label`, className: orClasses.swapDetailsDt }, label),
    React.createElement(
      "dd",
      { key: `${label}-value`, className: orClasses.swapDetailsDd },
      valueField,
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
  const [copied, showCopied] = useTransientValue<boolean>(false);
  const label = copied ? checkoutLabels.copied : "Copy";
  return React.createElement(
    "button",
    {
      className: orClasses.detailCopy,
      onClick: () => {
        void copyText(props.value, props.clipboard)
          .then(() => showCopied(true))
          .catch(props.onError);
      },
      type: "button",
      "aria-label": label,
      title: label,
    },
    React.createElement(ClipboardIcon),
  );
}

function renderSwapSupportDetails(
  display: NonNullable<ReturnType<typeof createSwapDisplayModel>>,
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

function renderSwapRefundReturnWarning(): React.ReactElement {
  return React.createElement(
    "p",
    {
      className: orClasses.swapWarning,
    },
    checkoutLabels.refundReturnWarning,
  );
}

/**
 * Survives wizard remounts caused by poll snapshot churn, so the draft must outlive the
 * component. Bounded because attempt ids are unique: an unbounded module map grows for as
 * long as a single-page app lives.
 */
const REFUND_ADDRESS_DRAFT_LIMIT = 8;
const refundAddressDraftByAttempt = new Map<string, string>();

function setRefundAddressDraft(attemptId: string, value: string): void {
  refundAddressDraftByAttempt.delete(attemptId);
  refundAddressDraftByAttempt.set(attemptId, value);
  while (refundAddressDraftByAttempt.size > REFUND_ADDRESS_DRAFT_LIMIT) {
    const oldest = refundAddressDraftByAttempt.keys().next().value;
    if (oldest === undefined) break;
    refundAddressDraftByAttempt.delete(oldest);
  }
}

function SwapRefundForm(props: {
  readonly attemptId: string;
  readonly payInAsset: string;
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
  const [refundAddress, setRefundAddress] = React.useState(
    () => refundAddressDraftByAttempt.get(props.attemptId) ?? "",
  );
  React.useEffect(() => {
    setRefundAddress(refundAddressDraftByAttempt.get(props.attemptId) ?? "");
  }, [props.attemptId]);
  const [submitting, setSubmitting] = React.useState(false);
  const [showAddressError, setShowAddressError] = React.useState(false);
  const address = refundAddress.trim();
  const addressError = getSwapRefundFormError(props.payInAsset, address, props.networkLabel);
  const confirm =
    address.length > 0 &&
    props.submittedRefundAddress !== undefined &&
    props.submittedRefundAddress === address;
  const disabled = submitting || props.refundNonce === undefined;
  const showError = showAddressError && addressError !== undefined;
  return React.createElement(
    "form",
    {
      className: orClasses.swapRefund,
      noValidate: true,
      onSubmit: (event) => {
        event.preventDefault();
        if (addressError !== undefined || props.refundNonce === undefined) {
          setShowAddressError(true);
          return;
        }
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
      "aria-invalid": showError ? true : undefined,
      className: showError ? orClasses.swapRefundInputInvalid : orClasses.swapRefundInput,
      onChange: (event) => {
        const value = event.currentTarget.value;
        setRefundAddressDraft(props.attemptId, value);
        setRefundAddress(value);
      },
      onBlur: () => {
        if (refundAddress.trim().length > 0) setShowAddressError(true);
      },
      placeholder: `${props.networkLabel} refund address`,
      required: true,
      type: "text",
      value: refundAddress,
    }),
    showError
      ? React.createElement(
          "p",
          {
            className: orClasses.swapRefundError,
            role: "alert",
          },
          addressError,
        )
      : null,
    props.submittedRefundAddress === undefined
      ? React.createElement(
          "p",
          {
            className: orClasses.swapRefundHint,
          },
          `Make sure you control this ${props.networkLabel} address. Refunds sent to the wrong address usually cannot be recovered.`,
        )
      : null,
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
  readonly encoder?: QrEncoder;
  readonly onError?: (error: unknown) => void;
}): React.ReactElement {
  const [svg, setSvg] = React.useState("");
  // Read through a ref: an inline onError would re-encode the QR on every parent render.
  const onErrorRef = React.useRef(props.onError);
  onErrorRef.current = props.onError;
  React.useEffect(() => {
    let cancelled = false;
    createQrPayloadSvg(props.payload, { encoder: props.encoder, width: 220 })
      .then((nextSvg) => {
        if (!cancelled) setSvg(nextSvg);
      })
      .catch((error) => {
        if (!cancelled) onErrorRef.current?.(error);
      });
    return () => {
      cancelled = true;
    };
  }, [props.payload, props.encoder]);

  const imageSource =
    svg.length === 0 ? undefined : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

  return React.createElement("img", {
    alt: "",
    className: orClasses.swapQr,
    src: imageSource,
  });
}
