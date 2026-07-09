import * as React from "react";
import {
  OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES,
  copyInvoice as copyInvoiceHelper,
  createCheckoutStatusModel,
  createQrSvg,
  formatOpenReceiveAmountCaption,
  openReceiveCheckoutLabels,
  openWallet as openWalletHelper,
  orClasses,
  type CheckoutPhase,
  type CheckoutStatusModel,
} from "@openreceive/browser/internal";
import { useOpenReceiveTransientValue } from "./hooks.ts";
import { joinClassNames } from "./utils.ts";
import type {
  CopyInvoiceButtonProps,
  InvoiceSummaryProps,
  OpenWalletButtonProps,
  PaymentStateProps,
  QRCodeProps,
  SatsDetailProps,
} from "./types.ts";

function ClipboardIcon(): React.ReactElement {
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

  React.useEffect(() => {
    let cancelled = false;
    createQrSvg(invoice, { encoder, width })
      .then((nextSvg) => {
        if (!cancelled) setSvg(nextSvg);
      })
      .catch((error) => {
        if (!cancelled) onError?.(error);
      });

    return () => {
      cancelled = true;
    };
  }, [invoice, encoder, width, onError]);

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
    copiedLabel = openReceiveCheckoutLabels.copied,
    ButtonComponent = "button",
    children,
    type = "button",
    className,
    ...buttonProps
  } = props;
  const [copied, showCopied] = useOpenReceiveTransientValue<boolean>(false);

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
        copied ? copiedLabel : openReceiveCheckoutLabels.copyInvoice,
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
    children = openReceiveCheckoutLabels.openWallet,
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

export function WaitingState(props: {
  readonly waiting?: boolean;
  readonly phase?: CheckoutPhase;
  readonly status?: CheckoutStatusModel;
  readonly statusTitle?: string;
  readonly statusDetail?: string;
  readonly className?: string;
}): React.ReactElement {
  const status =
    props.status ??
    createCheckoutStatusModel({
      phase: props.phase,
      waiting: props.waiting ?? false,
    });

  return React.createElement(
    "div",
    {
      className: joinClassNames(orClasses.paymentStatus, props.className),
    },
    status.waiting
      ? React.createElement("span", {
          className: orClasses.spinner,
          "aria-hidden": "true",
        })
      : null,
    React.createElement(
      "div",
      {
        className: orClasses.paymentStatusBody,
      },
      React.createElement(
        "strong",
        { className: orClasses.paymentStatusTitle },
        props.statusTitle ?? status.title,
      ),
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
  const caption = formatOpenReceiveAmountCaption({ amountLabel, fiatLabel, fiatCurrency });

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
