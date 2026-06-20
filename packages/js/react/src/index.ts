import * as React from "react";
import {
  type OpenReceiveQrEncoder,
  copyInvoice as copyInvoiceHelper,
  createLightningUri,
  createQrSvg,
  openWallet as openWalletHelper,
  type OpenReceiveBrowserLogContext,
  type OpenReceiveBrowserLogger
} from "@openreceive/browser";

export interface OpenReceiveCheckoutData {
  readonly invoice: string;
  readonly payment_hash?: string;
  readonly amount_msats?: number;
  readonly transaction_state?: string;
}

export interface OpenReceiveCheckoutViewModel extends OpenReceiveCheckoutData {
  readonly lightningUri: string;
  readonly amountLabel?: string;
  readonly paymentHashLabel?: string;
  readonly transactionStateLabel?: string;
}

export interface UseOpenReceiveCheckoutOptions extends OpenReceiveCheckoutData {
  readonly clipboard?: Pick<Clipboard, "writeText">;
  readonly open?: (uri: string) => void;
  readonly logger?: OpenReceiveBrowserLogger;
  readonly onError?: (error: unknown) => void;
}

export interface UseOpenReceiveCheckoutResult extends OpenReceiveCheckoutViewModel {
  readonly copied: boolean;
  copyInvoice(): Promise<void>;
  openWallet(): string;
}

export interface OpenReceiveQRCodeProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
  readonly invoice: string;
  readonly encoder?: OpenReceiveQrEncoder;
  readonly width?: number;
  readonly onError?: (error: unknown) => void;
}

export type OpenReceiveButtonComponent =
  React.ElementType<React.ButtonHTMLAttributes<HTMLButtonElement>>;

export interface OpenReceiveCopyButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  readonly invoice: string;
  readonly clipboard?: Pick<Clipboard, "writeText">;
  readonly logger?: OpenReceiveBrowserLogger;
  readonly onCopied?: () => void;
  readonly onError?: (error: unknown) => void;
  readonly ButtonComponent?: OpenReceiveButtonComponent;
}

export interface OpenReceiveOpenWalletButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  readonly invoice: string;
  readonly open?: (uri: string) => void;
  readonly logger?: OpenReceiveBrowserLogger;
  readonly onOpened?: (uri: string) => void;
  readonly onError?: (error: unknown) => void;
  readonly ButtonComponent?: OpenReceiveButtonComponent;
}

export interface OpenReceivePaymentStateProps
  extends React.HTMLAttributes<HTMLSpanElement> {
  readonly state?: string;
}

export interface OpenReceiveInvoiceSummaryClassNames {
  readonly amount?: string;
  readonly paymentHash?: string;
  readonly paymentState?: string;
}

export interface OpenReceiveInvoiceSummaryProps
  extends React.HTMLAttributes<HTMLDivElement> {
  readonly amountLabel?: string;
  readonly paymentHashLabel?: string;
  readonly transactionStateLabel?: string;
  readonly PaymentStateComponent?: React.ComponentType<OpenReceivePaymentStateProps>;
  readonly classNames?: OpenReceiveInvoiceSummaryClassNames;
}

export interface OpenReceiveCheckoutClassNames
  extends OpenReceiveInvoiceSummaryClassNames {
  readonly root?: string;
  readonly qr?: string;
  readonly summary?: string;
  readonly invoice?: string;
  readonly actions?: string;
  readonly copyButton?: string;
  readonly openWalletButton?: string;
}

export interface OpenReceiveCheckoutComponents {
  readonly Button?: OpenReceiveButtonComponent;
  readonly QRCode?: React.ComponentType<OpenReceiveQRCodeProps>;
  readonly InvoiceSummary?: React.ComponentType<OpenReceiveInvoiceSummaryProps>;
  readonly CopyButton?: React.ComponentType<OpenReceiveCopyButtonProps>;
  readonly OpenWalletButton?: React.ComponentType<OpenReceiveOpenWalletButtonProps>;
  readonly PaymentState?: React.ComponentType<OpenReceivePaymentStateProps>;
}

export type OpenReceiveCheckoutChildren =
  | React.ReactNode
  | ((model: OpenReceiveCheckoutViewModel) => React.ReactNode);

export interface OpenReceiveCheckoutProps
  extends OpenReceiveCheckoutData,
    Omit<React.HTMLAttributes<HTMLElement>, "children"> {
  readonly qrEncoder?: OpenReceiveQrEncoder;
  readonly logger?: OpenReceiveBrowserLogger;
  readonly onError?: (error: unknown) => void;
  readonly components?: OpenReceiveCheckoutComponents;
  readonly classNames?: OpenReceiveCheckoutClassNames;
  readonly children?: OpenReceiveCheckoutChildren;
}

export function createOpenReceiveCheckoutViewModel(
  data: OpenReceiveCheckoutData
): OpenReceiveCheckoutViewModel {
  const lightningUri = createLightningUri(data.invoice);

  return {
    ...data,
    lightningUri,
    ...(data.amount_msats === undefined
      ? {}
      : { amountLabel: formatMsats(data.amount_msats) }),
    ...(data.payment_hash === undefined
      ? {}
      : { paymentHashLabel: shortHash(data.payment_hash) }),
    ...(data.transaction_state === undefined
      ? {}
      : { transactionStateLabel: data.transaction_state })
  };
}

export function useOpenReceiveCheckout(
  options: UseOpenReceiveCheckoutOptions
): UseOpenReceiveCheckoutResult {
  const [copied, setCopied] = React.useState(false);
  const model = React.useMemo(
    () => createOpenReceiveCheckoutViewModel(options),
    [
      options.invoice,
      options.payment_hash,
      options.amount_msats,
      options.transaction_state
    ]
  );
  const logContext = React.useMemo(
    () => getCheckoutLogContext(options),
    [
      options.payment_hash,
      options.amount_msats,
      options.transaction_state
    ]
  );

  const copyInvoice = React.useCallback(async () => {
    try {
      await copyInvoiceHelper({
        invoice: options.invoice,
        clipboard: options.clipboard,
        logger: options.logger,
        logContext
      });
      setCopied(true);
    } catch (error) {
      options.onError?.(error);
      throw error;
    }
  }, [logContext, options.invoice, options.clipboard, options.logger, options.onError]);

  const openWallet = React.useCallback(() => {
    try {
      return openWalletHelper({
        invoice: options.invoice,
        open: options.open,
        logger: options.logger,
        logContext
      });
    } catch (error) {
      options.onError?.(error);
      throw error;
    }
  }, [logContext, options.invoice, options.open, options.logger, options.onError]);

  return {
    ...model,
    copied,
    copyInvoice,
    openWallet
  };
}

export function OpenReceiveQRCode(props: OpenReceiveQRCodeProps): React.ReactElement {
  const {
    invoice,
    encoder,
    width = 256,
    onError,
    ...divProps
  } = props;
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
    "data-openreceive-qr": "",
    dangerouslySetInnerHTML: {
      __html: svg
    }
  });
}

export function OpenReceiveCopyButton(
  props: OpenReceiveCopyButtonProps
): React.ReactElement {
  const {
    invoice,
    clipboard,
    logger,
    onCopied,
    onError,
    onClick,
    ButtonComponent = "button",
    children = "Copy",
    type = "button",
    ...buttonProps
  } = props;

  return React.createElement(
    ButtonComponent,
    {
      ...buttonProps,
      type,
      onClick: async (event: React.MouseEvent<HTMLButtonElement>) => {
        onClick?.(event);
        if (event.defaultPrevented) return;

        try {
          await copyInvoiceHelper({ invoice, clipboard, logger });
          onCopied?.();
        } catch (error) {
          onError?.(error);
        }
      }
    },
    children
  );
}

export function OpenReceiveOpenWalletButton(
  props: OpenReceiveOpenWalletButtonProps
): React.ReactElement {
  const {
    invoice,
    open,
    logger,
    onOpened,
    onError,
    onClick,
    ButtonComponent = "button",
    children = "Open Wallet",
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
          const uri = openWalletHelper({ invoice, open, logger });
          onOpened?.(uri);
        } catch (error) {
          onError?.(error);
        }
      }
    },
    children
  );
}

export function OpenReceivePaymentState(
  props: OpenReceivePaymentStateProps
): React.ReactElement {
  const {
    state = "pending",
    ...spanProps
  } = props;

  return React.createElement(
    "span",
    {
      ...spanProps,
      "data-openreceive-state": state
    },
    state
  );
}

export function OpenReceiveInvoiceSummary(
  props: OpenReceiveInvoiceSummaryProps
): React.ReactElement {
  const {
    amountLabel,
    paymentHashLabel,
    transactionStateLabel,
    PaymentStateComponent = OpenReceivePaymentState,
    classNames,
    className,
    ...divProps
  } = props;

  return React.createElement(
    "div",
    {
      ...divProps,
      className,
      "data-openreceive-meta": ""
    },
    amountLabel === undefined
      ? null
      : React.createElement(
        "span",
        {
          className: classNames?.amount
        },
        amountLabel
      ),
    transactionStateLabel === undefined
      ? null
      : React.createElement(PaymentStateComponent, {
        state: transactionStateLabel,
        className: classNames?.paymentState
      }),
    paymentHashLabel === undefined
      ? null
      : React.createElement(
        "code",
        {
          className: classNames?.paymentHash
        },
        paymentHashLabel
      )
  );
}

export function OpenReceiveCheckout(
  props: OpenReceiveCheckoutProps
): React.ReactElement {
  const {
    invoice,
    payment_hash,
    amount_msats,
    transaction_state,
    qrEncoder,
    logger,
    onError,
    components,
    classNames,
    children,
    className,
    ...sectionProps
  } = props;
  const model = createOpenReceiveCheckoutViewModel({
    invoice,
    payment_hash,
    amount_msats,
    transaction_state
  });
  const QRCode = components?.QRCode ?? OpenReceiveQRCode;
  const InvoiceSummary = components?.InvoiceSummary ?? OpenReceiveInvoiceSummary;
  const CopyButton = components?.CopyButton ?? OpenReceiveCopyButton;
  const OpenWalletButton =
    components?.OpenWalletButton ?? OpenReceiveOpenWalletButton;
  const ButtonComponent = components?.Button;
  const PaymentStateComponent = components?.PaymentState ?? OpenReceivePaymentState;
  const customChildren =
    typeof children === "function" ? children(model) : children;

  return React.createElement(
    "section",
    {
      ...sectionProps,
      className: joinClassNames(className, classNames?.root),
      "data-openreceive-checkout": ""
    },
    customChildren === undefined
      ? [
        React.createElement(QRCode, {
          key: "qr",
          invoice,
          encoder: qrEncoder,
          onError,
          className: classNames?.qr,
          style: {
            aspectRatio: "1",
            maxWidth: 256
          }
        }),
        React.createElement(InvoiceSummary, {
          key: "summary",
          amountLabel: model.amountLabel,
          paymentHashLabel: model.paymentHashLabel,
          transactionStateLabel: model.transactionStateLabel,
          PaymentStateComponent,
          className: classNames?.summary,
          classNames
        }),
        React.createElement("textarea", {
          key: "invoice",
          readOnly: true,
          value: invoice,
          "aria-label": "Lightning invoice",
          className: classNames?.invoice
        }),
        React.createElement(
          "div",
          {
            key: "actions",
            className: classNames?.actions,
            "data-openreceive-actions": ""
          },
          React.createElement(CopyButton, {
            invoice,
            onError,
            logger,
            ButtonComponent,
            className: classNames?.copyButton
          }),
          React.createElement(OpenWalletButton, {
            invoice,
            onError,
            logger,
            ButtonComponent,
            className: classNames?.openWalletButton
          })
        )
      ]
      : customChildren
  );
}

export const InvoiceSummary = OpenReceiveInvoiceSummary;
export const CopyInvoiceButton = OpenReceiveCopyButton;
export const OpenWalletButton = OpenReceiveOpenWalletButton;
export const PaymentState = OpenReceivePaymentState;

function getCheckoutLogContext(
  data: OpenReceiveCheckoutData
): OpenReceiveBrowserLogContext {
  return {
    ...(data.payment_hash === undefined ? {} : { payment_hash: data.payment_hash }),
    ...(data.amount_msats === undefined ? {} : { amount_msats: data.amount_msats }),
    ...(data.transaction_state === undefined
      ? {}
      : { transaction_state: data.transaction_state })
  };
}

function formatMsats(amountMsats: number): string {
  if (!Number.isSafeInteger(amountMsats) || amountMsats < 0) {
    throw new RangeError("amount_msats must be a non-negative safe integer");
  }

  if (amountMsats % 1000 === 0) {
    const sats = amountMsats / 1000;
    return `${sats} ${sats === 1 ? "sat" : "sats"}`;
  }

  return `${amountMsats} msats`;
}

function shortHash(hash: string): string {
  return hash.length <= 16 ? hash : `${hash.slice(0, 8)}...${hash.slice(-8)}`;
}

function joinClassNames(
  ...values: readonly (string | undefined)[]
): string | undefined {
  const joined = values.filter(Boolean).join(" ");
  return joined === "" ? undefined : joined;
}
