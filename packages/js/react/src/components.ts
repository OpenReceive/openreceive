import * as React from "react";
import {
  OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES,
  copyInvoice as copyInvoiceHelper,
  createCheckoutStatusModel,
  createQrSvg,
  openReceiveCheckoutLabels,
  openWallet as openWalletHelper,
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
    ...buttonProps
  } = props;
  const [copied, showCopied] = useOpenReceiveTransientValue<boolean>(false);

  return React.createElement(
    ButtonComponent,
    {
      ...buttonProps,
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
    children ?? (copied ? copiedLabel : openReceiveCheckoutLabels.copyInvoice),
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
    ...buttonProps
  } = props;

  return React.createElement(
    ButtonComponent,
    {
      ...buttonProps,
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
  const { state = "pending", ...spanProps } = props;

  return React.createElement(
    "span",
    {
      ...spanProps,
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
      className: joinClassNames("or-payment-status", props.className),
    },
    status.waiting
      ? React.createElement("span", {
          className: "or-spinner",
          "aria-hidden": "true",
        })
      : null,
    React.createElement(
      "div",
      null,
      React.createElement("strong", null, props.statusTitle ?? status.title),
      React.createElement("span", null, props.statusDetail ?? status.detail),
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
      className,
      [OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.meta]: "",
    },
    amountLabel === undefined
      ? null
      : React.createElement(
          "span",
          {
            className: classNames?.amount,
          },
          amountLabel,
        ),
    fiatLabel === undefined
      ? null
      : React.createElement(
          "span",
          {
            className: classNames?.fiat,
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
  const { amountLabel, className, ...divProps } = props;

  if (amountLabel === undefined) return null;

  return React.createElement(
    "div",
    {
      ...divProps,
      className: joinClassNames("or-sats-detail", className),
    },
    amountLabel,
  );
}
