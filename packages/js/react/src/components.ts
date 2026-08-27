import * as React from "react";
import {
  OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES,
  copyInvoice as copyInvoiceHelper,
  createCheckoutStatusModel,
  createQrSvgController,
  formatAmountCaption,
  checkoutLabels,
  openWallet as openWalletHelper,
  orClasses,
  type CheckoutPhase,
  type CheckoutStatusModel,
} from "@openreceive/browser/headless";
import { useTransientValue } from "./hooks.ts";
import { joinClassNames } from "./utils.ts";
import type {
  CopyInvoiceButtonProps,
  InvoiceSummaryProps,
  OpenWalletButtonProps,
  PaymentStateProps,
  QRCodeProps,
  SatsDetailProps,
} from "./types.ts";

export function ClipboardIcon(): React.ReactElement {
  return React.createElement(
    "svg",
    {
      className: orClasses.copyIcon,
      width: 16,
      height: 16,
      viewBox: "0 0 16 16",
      fill: "none",
      "aria-hidden": "true",
      focusable: "false",
    },
    React.createElement("rect", {
      x: 5,
      y: 5,
      width: 8,
      height: 9,
      rx: 1.5,
      stroke: "currentColor",
      strokeWidth: 1.5,
    }),
    React.createElement("path", {
      d: "M3.5 11V3.5A1.5 1.5 0 0 1 5 2h5.5",
      stroke: "currentColor",
      strokeWidth: 1.5,
      strokeLinecap: "round",
    }),
  );
}

export function QRCode(props: QRCodeProps): React.ReactElement {
  const { invoice, encoder, width = 256, onError, ...divProps } = props;
  const [svg, setSvg] = React.useState("");
  // Read through a ref: an inline onError would re-encode the QR on every parent render.
  const onErrorRef = React.useRef(onError);
  onErrorRef.current = onError;

  // The supersede rule — a slow encode that lands after the invoice changed
  // must not paint the old QR — lives in the controller, not here. React
  // supplies what is React's: where the SVG lands, and when the effect ends.
  React.useEffect(() => {
    const controller = createQrSvgController({
      onValue: setSvg,
      onError: (error) => onErrorRef.current?.(error),
      ...(encoder === undefined ? {} : { encoder }),
      width,
    });
    controller.show(invoice);
    return () => {
      controller.stop();
    };
  }, [invoice, encoder, width]);

  return React.createElement("div", {
    ...divProps,
    [OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.qr]: "",
    dangerouslySetInnerHTML: {
      __html: svg,
    },
  });
}

export function CopyInvoiceButton(props: CopyInvoiceButtonProps): React.ReactElement {
  const {
    invoice,
    copyInvoice,
    clipboard,
    logger,
    onCopied,
    onError,
    onClick,
    copiedLabel = checkoutLabels.copied,
    ButtonComponent = "button",
    children,
    type = "button",
    className,
    ...buttonProps
  } = props;
  const [copied, showCopied] = useTransientValue<boolean>(false);

  return React.createElement(
    ButtonComponent,
    {
      ...buttonProps,
      className: joinClassNames(orClasses.btn, className),
      type,
      onClick: async (event: React.MouseEvent<HTMLButtonElement>) => {
        onClick?.(event);
        if (event.defaultPrevented) return;

        try {
          if (copyInvoice === undefined) {
            await copyInvoiceHelper({ invoice, clipboard, logger });
          } else {
            await copyInvoice();
          }
          showCopied(true);
          onCopied?.();
        } catch (error) {
          onError?.(error);
        }
      },
    },
    children ??
      React.createElement(
        React.Fragment,
        null,
        React.createElement(ClipboardIcon),
        copied ? copiedLabel : checkoutLabels.copyInvoice,
      ),
  );
}

export function OpenWalletButton(props: OpenWalletButtonProps): React.ReactElement {
  const {
    invoice,
    openWallet,
    open,
    logger,
    onOpened,
    onError,
    onClick,
    ButtonComponent = "button",
    children = checkoutLabels.openWallet,
    type = "button",
    className,
    ...buttonProps
  } = props;

  return React.createElement(
    ButtonComponent,
    {
      ...buttonProps,
      className: joinClassNames(orClasses.btn, className),
      type,
      onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
        onClick?.(event);
        if (event.defaultPrevented) return;

        try {
          const uri =
            openWallet === undefined ? openWalletHelper({ invoice, open, logger }) : openWallet();
          onOpened?.(uri);
        } catch (error) {
          onError?.(error);
        }
      },
    },
    children,
  );
}

export function PaymentState(props: PaymentStateProps): React.ReactElement {
  const { state = "pending", className, ...spanProps } = props;

  return React.createElement(
    "span",
    {
      ...spanProps,
      className: joinClassNames(
        state === "settled" ? orClasses.stateSettled : orClasses.statePending,
        className,
      ),
      [OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.state]: state,
    },
    state,
  );
}

export function SettledCheckIcon(): React.ReactElement {
  return React.createElement(
    "svg",
    {
      className: orClasses.settledIcon,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.8,
      "aria-hidden": "true",
      focusable: "false",
    },
    React.createElement("path", {
      strokeLinecap: "round",
      strokeLinejoin: "round",
      d: "M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
    }),
  );
}

export function WaitingState(props: {
  readonly waiting?: boolean;
  readonly phase?: CheckoutPhase;
  readonly status?: CheckoutStatusModel;
  readonly statusTitle?: string;
  readonly statusDetail?: string;
  readonly countdownLabel?: string;
  readonly settled?: boolean;
  readonly className?: string;
}): React.ReactElement {
  const status =
    props.status ??
    createCheckoutStatusModel({
      phase: props.phase,
      waiting: props.waiting ?? false,
    });
  const title = props.statusTitle ?? status.title;
  const titleRow =
    props.countdownLabel === undefined
      ? React.createElement("strong", { className: orClasses.paymentStatusTitle }, title)
      : React.createElement(
          "div",
          { className: orClasses.swapWaitingTitle },
          React.createElement("strong", { className: orClasses.paymentStatusTitle }, title),
          React.createElement(
            "strong",
            { className: orClasses.swapCountdown },
            props.countdownLabel,
          ),
        );

  return React.createElement(
    "div",
    {
      // Settlement and status transitions are announced to assistive tech.
      role: "status",
      "aria-live": "polite",
      className: joinClassNames(orClasses.paymentStatus, props.className),
    },
    status.waiting
      ? React.createElement("span", {
          className: orClasses.spinner,
          "aria-hidden": "true",
        })
      : null,
    (props.settled ?? status.phase === "settled")
      ? React.createElement(SettledCheckIcon, { key: "settled-icon" })
      : null,
    React.createElement(
      "div",
      {
        className: orClasses.paymentStatusBody,
      },
      titleRow,
      React.createElement(
        "span",
        { className: orClasses.paymentStatusDetail },
        props.statusDetail ?? status.detail,
      ),
    ),
  );
}

export function InvoiceSummary(props: InvoiceSummaryProps): React.ReactElement {
  const {
    amountLabel,
    fiatLabel,
    paymentHashLabel,
    status,
    PaymentStateComponent = PaymentState,
    classNames,
    className,
    ...divProps
  } = props;

  return React.createElement(
    "div",
    {
      ...divProps,
      className: joinClassNames(orClasses.meta, className),
      [OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.meta]: "",
    },
    amountLabel === undefined
      ? null
      : React.createElement(
          "span",
          {
            className: joinClassNames(orClasses.metaItem, classNames?.amount),
          },
          amountLabel,
        ),
    fiatLabel === undefined
      ? null
      : React.createElement(
          "span",
          {
            className: joinClassNames(orClasses.metaItem, classNames?.fiat),
          },
          fiatLabel,
        ),
    paymentHashLabel === undefined
      ? null
      : React.createElement(
          "span",
          {
            className: joinClassNames(orClasses.metaItem, classNames?.paymentHash),
          },
          paymentHashLabel,
        ),
    status === undefined
      ? null
      : React.createElement(PaymentStateComponent, {
          state: status,
          className: classNames?.paymentState,
        }),
  );
}

export function SatsDetail(props: SatsDetailProps): React.ReactElement | null {
  const { amountLabel, fiatLabel, fiatCurrency, className, ...divProps } = props;
  const caption = formatAmountCaption({ amountLabel, fiatLabel, fiatCurrency });

  if (caption === undefined) return null;

  return React.createElement(
    "div",
    {
      ...divProps,
      className: joinClassNames(orClasses.satsDetail, className),
    },
    caption,
  );
}
