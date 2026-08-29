import {
  type BrowserLogger,
  type CheckoutInvoiceSnapshot,
  type CheckoutSnapshot,
  checkoutLabels,
  createDetailExternalLink,
  createQrSvgController,
  createSwapDisplayModel,
  createSwapUnavailableModel,
  createTransactionDetails,
  currentCheckoutUrl,
  type DetailLinkKind,
  getSwapRefundFormError,
  orClasses,
  type QrEncoder,
  type SwapDisplayModel,
  selectCheckoutDisplayInvoice,
  swapOptionLimitMessage,
  type UnixSeconds,
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
            ? checkoutLabels.preparingPayment
            : checkoutLabels.createPaymentAddress
                .replace("{asset}", option.label)
                .replace("{network}", option.network_label),
        ),
      );
    }),
  );
}

/** Inline swap-start failure with retry — never an endless preparing spinner. */
export function renderSwapStartError(message: string, onRetry: () => void): React.ReactElement {
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
        checkoutLabels.swapStartFailedTitle,
      ),
      React.createElement("p", { className: orClasses.swapWarning }, message),
      React.createElement(
        "button",
        {
          className: orClasses.btn,
          type: "button",
          onClick: onRetry,
        },
        checkoutLabels.tryAgain,
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
      statusTitle: checkoutLabels.preparingPaymentAddress,
      statusDetail: checkoutLabels.preparingPaymentAddressDetail.replace("{asset}", assetLabel),
    }),
  );
}

export function renderSwapUnavailable(
  quote: SwapOptionDisplay,
  checkout: CheckoutSnapshot | undefined,
): React.ReactElement {
  // Copy and range arithmetic live in @openreceive/browser so this panel and
  // the element's read the same model.
  const model = createSwapUnavailableModel(quote, checkout);
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
      React.createElement("strong", { className: orClasses.swapHeadingTitle }, model.title),
    ),
    React.createElement("p", { className: orClasses.swapWarning }, model.detail),
    model.range === undefined
      ? null
      : React.createElement("p", { className: orClasses.swapWarning }, model.range),
    React.createElement("p", { className: orClasses.swapProgress }, model.hint),
  );
}

export function renderSwapDepositPanel(options: {
  readonly invoice: CheckoutInvoiceSnapshot;
  readonly checkout?: CheckoutSnapshot;
  /** Unix **seconds** ({@link UnixSeconds}), not `Date.now()` milliseconds. */
  readonly now?: UnixSeconds;
  readonly encoder?: QrEncoder;
  readonly clipboard?: Pick<Clipboard, "writeText">;
  readonly logger?: BrowserLogger | false;
  readonly onError?: (error: unknown) => void;
  readonly onRefund: (attemptId: string, refundAddress: string, confirm: boolean) => Promise<void>;
  readonly onBackToLightning: () => void;
  /** Does this checkout have a URL to return to? See `refundReturnLabel`. */
  readonly resumable?: boolean;
}): React.ReactElement | null {
  const display = createSwapDisplayModel(options.invoice, {
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.resumable === undefined ? {} : { resumable: options.resumable }),
  });
  if (display === undefined) return null;
  const backButton = React.createElement(
    "button",
    {
      className: orClasses.swapBack,
      onClick: options.onBackToLightning,
      type: "button",
    },
    checkoutLabels.payWithLightningInstead,
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
  // The same two strings, as an alert. "Refund needed" is not a section title:
  // it is the payer being told their money did not go where they sent it for.
  //
  // Icon beside a stacked title and body, the shape every other callout on this
  // panel has — an alert whose children are its own grid columns puts the
  // headline and the explanation side by side and reads as neither.
  const refundHeading = React.createElement(
    "div",
    { className: orClasses.swapRefundHeading, role: "alert" },
    renderAlertIcon("warning"),
    React.createElement(
      "div",
      { className: orClasses.swapNetworkWarningContent },
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
            kind: "tx",
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
                reference: options.checkout.reference,
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
      refundHeading,
      renderSwapRefundReturnWarning(display, options),
      renderSwapAmountFacts(display),
      React.createElement(SwapRefundForm, {
        attemptId: display.attemptId,
        payInAsset: display.payInAsset,
        networkLabel: display.networkLabel,
        ...(display.refundReason === undefined ? {} : { refundReason: display.refundReason }),
        submittedRefundAddress: display.refundAddress,
        refundAllowed: display.refundAllowed,
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
      refundHeading,
      renderSwapRefundReturnWarning(display, options),
      renderSwapAmountFacts(display),
      React.createElement(
        "dl",
        {
          className: orClasses.swapDetails,
        },
        display.refundAddress === undefined
          ? null
          : renderSwapCopyRow("Refund address", display.refundAddress, {
              ...options,
              kind: "address",
              payInAsset: display.payInAsset,
            }),
        display.refundTxId === undefined
          ? null
          : renderSwapCopyRow("Refund transaction", display.refundTxId, {
              ...options,
              kind: "tx",
              payInAsset: display.payInAsset,
            }),
      ),
      renderSwapSupportDetails(display, options),
    );
  }

  // `deposit` is the EXPLICIT branch and support-review is the fallback,
  // matching the element's renderer. Inverted, a future SwapDisplayModel state
  // would render as a payable deposit screen in React and as support-review in
  // the element — drift by construction.
  if (display.state === "deposit") {
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
        React.createElement(
          "div",
          { className: orClasses.swapQrFrame },
          React.createElement(SwapPayloadQRCode, {
            payload: display.qrPayload,
            encoder: options.encoder,
            onError: options.onError,
          }),
        ),
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
            // Every value the payer must reproduce, from the model: address,
            // memo where the rail has one, and the amount BARE.
            //
            // Explorer stays hidden until payment completes (tx ids / settled details).
            // No explorer link on the LIVE deposit row: the address has nothing on
            // chain yet, and sending the payer to a third-party explorer mid-payment
            // is not something this pane does. The settled/refund panes link theirs.
            ...display.copyRows.flatMap((row) =>
              renderSwapCopyRow(
                row.label,
                row.copyValue ?? row.value,
                { ...options, selectable: row.selectable },
                row.value,
              ),
            ),
          ),
          waitingCard(display.countdownLabel),
          renderSwapFeeBreakdown(display.feeBreakdown),
        ),
      ),
      backButton,
    );
  }

  // Fallback: any state without an explicit branch above (including a future
  // one) lands on support review rather than a payable deposit screen.
  //
  // The heading has already said "Needs attention" and why. What this screen
  // owes the payer beyond that is the next step and the facts that identify
  // the deposit to whoever picks it up — so the details are OPEN here. A caret
  // is right for a screen where the payment is going fine; it is not where the
  // whole remaining job is quoting an id to a human.
  return React.createElement(
    "section",
    {
      className: orClasses.swapPanel,
    },
    heading,
    React.createElement(
      "p",
      { className: orClasses.swapWarning },
      checkoutLabels.supportReviewFacts,
    ),
    renderSwapAmountFacts(display),
    renderSwapSupportDetails(display, options, { open: true }),
    backButton,
  );
}

function renderSwapNetworkWarning(
  display: Pick<
    SwapDisplayModel,
    "depositRisk" | "networkWarningTitle" | "networkWarningEmphasis" | "networkWarning"
  >,
): React.ReactElement {
  // A rail whose address pins both the chain and the asset cannot be mis-sent
  // the two ways this banner warns about, so it gets the same block without the
  // alarm: no red, no triangle, and no `role="alert"` interrupting a screen
  // reader for copy that is not urgent.
  const alarm = display.depositRisk !== "pinned";
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
      ...(alarm ? { role: "alert" } : {}),
      "data-or-deposit-risk": display.depositRisk,
      className: alarm ? orClasses.swapNetworkWarning : orClasses.swapNetworkNotice,
    },
    alarm
      ? React.createElement(
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
        )
      : null,
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

/**
 * What the provider says about the money: sent, expected, and coming back.
 *
 * A fact table, not copy rows. Nobody pastes "0.04 SOL" into anything, and a
 * column of copy buttons down the worst screen in the flow reads as three more
 * things the payer is being asked to do. Mirrors
 * renderElementSwapAmountFactsHtml; keep the two in step.
 */
function renderSwapAmountFacts(display: SwapDisplayModel): React.ReactElement | null {
  const rows: readonly (readonly [string, string])[] = [
    ...(display.depositReceivedAmount === undefined
      ? []
      : ([
          ["Amount received", `${display.depositReceivedAmount} ${display.assetLabel}`],
          ["Amount required", `${display.depositAmount} ${display.assetLabel}`],
        ] as const)),
    ...(display.refundAmount === undefined
      ? []
      : ([["Estimated refund", `${display.refundAmount} ${display.assetLabel}`]] as const)),
  ];
  if (rows.length === 0) return null;
  return React.createElement(
    "dl",
    { className: orClasses.swapFacts },
    rows.map(([label, value]) =>
      React.createElement(
        "div",
        { key: label, className: orClasses.swapFactsRow },
        React.createElement("dt", { className: orClasses.swapFactsLabel }, label),
        React.createElement("dd", { className: orClasses.swapFactsValue }, value),
      ),
    ),
  );
}

/**
 * The icon beside a callout. Two shapes, both stroked so they inherit the
 * alert's own colour: the triangle that means "something went wrong with your
 * money", and the bookmark that means "keep this".
 */
function renderAlertIcon(kind: "warning" | "bookmark"): React.ReactElement {
  return React.createElement(
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
      d:
        kind === "warning"
          ? "M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
          : "M17 3H7a2 2 0 00-2 2v16l7-3.5L19 21V5a2 2 0 00-2-2z",
    }),
  );
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
    React.createElement(
      "p",
      { className: orClasses.swapBreakdownTitle },
      checkoutLabels.paymentBreakdown,
    ),
    React.createElement(
      "dl",
      { className: joinClassNames(orClasses.swapDetails, orClasses.swapBreakdownRows) },
      React.createElement(
        "dt",
        { key: "cart-label", className: orClasses.swapDetailsDt },
        checkoutLabels.cartTotal,
      ),
      React.createElement("dd", { key: "cart-value" }, breakdown.cartTotal),
      React.createElement(
        "dt",
        { key: "send-label", className: orClasses.swapDetailsDt },
        checkoutLabels.youSend,
      ),
      React.createElement("dd", { key: "send-value" }, breakdown.youSend),
      React.createElement(
        "dt",
        { key: "fee-label", className: orClasses.swapDetailsDt },
        checkoutLabels.swapAndNetworkFees,
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
    /** What the value IS. Omitted, the row carries no external link. */
    readonly kind?: DetailLinkKind;
    readonly payInAsset?: string;
    readonly href?: string;
    readonly hrefLabel?: string;
    /** Render the value in a selectable input rather than a code block. */
    readonly selectable?: boolean;
  },
  displayValue: string = value,
): readonly React.ReactElement[] {
  const link =
    options.href === undefined
      ? options.kind === undefined
        ? undefined
        : createDetailExternalLink({
            kind: options.kind,
            value,
            ...(options.payInAsset === undefined ? {} : { payInAsset: options.payInAsset }),
          })
      : {
          href: options.href,
          hrefLabel: options.hrefLabel ?? checkoutLabels.viewOnExplorer,
        };
  const valueField =
    options.selectable === true
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
  view: { readonly open?: boolean } = {},
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
      ...(view.open === true ? { open: true } : {}),
    },
    React.createElement("summary", { className: orClasses.swapSupportTitle }, "Payment details"),
    React.createElement(
      "div",
      { className: orClasses.swapSupportContent },
      React.createElement("dl", { className: orClasses.swapDetails }, rows),
    ),
  );
}

/**
 * How the payer gets back here, with the affordance the sentence names.
 *
 * `refundReturnLabel` is already the right sentence for this host's routing —
 * "Bookmark this page, or copy its URL" when the checkout is resumable, "do not
 * close this tab" when it is not. When there IS a URL, a copy button for it
 * sits underneath: a payer leaving for an address in another wallet should not
 * have to know how to copy an address bar on a phone.
 *
 * Mirrors renderElementSwapRefundReturnWarningHtml; keep the two in step.
 */
function renderSwapRefundReturnWarning(
  display: SwapDisplayModel,
  options: {
    readonly clipboard?: Pick<Clipboard, "writeText">;
    readonly onError?: (error: unknown) => void;
  },
): React.ReactElement {
  const url = display.resumable ? currentCheckoutUrl() : undefined;
  return React.createElement(
    "div",
    { className: orClasses.swapRefundReturn },
    renderAlertIcon("bookmark"),
    React.createElement(
      "div",
      { className: orClasses.swapNetworkWarningContent },
      React.createElement(
        "p",
        { className: orClasses.swapRefundReturnTitle },
        checkoutLabels.refundReturnTitle,
      ),
      React.createElement(
        "p",
        { className: orClasses.swapRefundReturnBody },
        display.refundReturnLabel,
      ),
      url === undefined
        ? null
        : React.createElement(
            "dl",
            { className: orClasses.swapDetails },
            ...renderSwapCopyRow(checkoutLabels.refundReturnUrlLabel, url, {
              ...options,
              selectable: true,
            }),
          ),
    ),
  );
}

/**
 * The way back into this payment, on every payment screen and not only the
 * refund one.
 *
 * The refund screen's louder twin above is the same fact after something has
 * gone wrong. By then the payer may already have closed the tab — so the
 * reference and its URL are on screen from the moment the payment is, with copy
 * buttons rather than a sentence about the address bar.
 *
 * Resumable checkouts only, for the reason `refundReturnLabel` exists: a
 * checkout with no URL of its own has no way back to promise.
 *
 * Mirrors renderElementKeepOrderNoteHtml; keep the two in step.
 */
export function renderKeepOrderNote(options: {
  readonly reference?: string;
  readonly resumable?: boolean;
  readonly clipboard?: Pick<Clipboard, "writeText">;
  readonly onError?: (error: unknown) => void;
}): React.ReactElement | null {
  if (options.resumable !== true) return null;
  const reference = options.reference ?? "";
  const url = currentCheckoutUrl();
  if (reference.length === 0 && url === undefined) return null;
  const rowOptions = { ...options, selectable: true };
  return React.createElement(
    "div",
    { className: orClasses.keepOrder },
    React.createElement(
      "p",
      { className: orClasses.swapSectionTitle },
      checkoutLabels.keepOrderTitle,
    ),
    React.createElement("p", { className: orClasses.keepOrderBody }, checkoutLabels.keepOrderBody),
    React.createElement(
      "dl",
      { className: orClasses.swapDetails },
      ...(reference.length === 0
        ? []
        : renderSwapCopyRow(checkoutLabels.keepOrderIdLabel, reference, rowOptions)),
      ...(url === undefined
        ? []
        : renderSwapCopyRow(checkoutLabels.keepOrderUrlLabel, url, rowOptions)),
    ),
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
  readonly refundReason?: string;
  readonly submittedRefundAddress?: string;
  readonly refundAllowed: boolean;
  readonly onRefund: (attemptId: string, refundAddress: string, confirm: boolean) => Promise<void>;
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
  const disabled = submitting || !props.refundAllowed;
  const showError = showAddressError && addressError !== undefined;
  return React.createElement(
    "form",
    {
      className: orClasses.swapRefund,
      noValidate: true,
      onSubmit: (event) => {
        event.preventDefault();
        if (addressError !== undefined || !props.refundAllowed) {
          setShowAddressError(true);
          return;
        }
        setSubmitting(true);
        void props
          .onRefund(props.attemptId, address, confirm)
          .catch(props.onError)
          .finally(() => setSubmitting(false));
      },
    },
    // The form says what it is and why it is here before it asks for anything:
    // a bare input under a red banner is a payer guessing what to type.
    React.createElement(
      "p",
      { className: orClasses.swapSectionTitle },
      checkoutLabels.refundSectionTitle,
    ),
    props.refundReason === undefined
      ? null
      : React.createElement(
          "p",
          { className: orClasses.swapRefundReason },
          checkoutLabels.refundReasonLabel.replace(
            "{reason}",
            props.refundReason.replace(/_/g, " "),
          ),
        ),
    React.createElement(
      "p",
      { className: orClasses.swapRefundInstruction },
      checkoutLabels.refundAddressOwnership.replace("{network}", props.networkLabel),
    ),
    props.submittedRefundAddress === undefined
      ? null
      : React.createElement(
          "p",
          {
            className: orClasses.swapRefundInstruction,
          },
          checkoutLabels.confirmRefundTo.replace("{address}", props.submittedRefundAddress),
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
      placeholder: checkoutLabels.refundAddressPlaceholder.replace("{network}", props.networkLabel),
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
      submitting
        ? checkoutLabels.submitting
        : confirm
          ? checkoutLabels.confirmRefund
          : checkoutLabels.reviewRefundAddress,
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
  const { payload, encoder } = props;
  React.useEffect(() => {
    const controller = createQrSvgController({
      onValue: setSvg,
      onError: (error) => onErrorRef.current?.(error),
      ...(encoder === undefined ? {} : { encoder }),
      width: 220,
    });
    controller.showPayload(payload);
    return () => {
      controller.stop();
    };
  }, [payload, encoder]);

  const imageSource =
    svg.length === 0 ? undefined : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

  return React.createElement("img", {
    alt: "",
    className: orClasses.swapQr,
    src: imageSource,
  });
}
