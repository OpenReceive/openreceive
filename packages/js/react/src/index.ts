import * as React from "react";
import {
  type OpenReceiveQrEncoder,
  copyInvoice as copyInvoiceHelper,
  createLightningUri,
  createQrSvg,
  openWallet as openWalletHelper
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

export interface OpenReceiveCopyButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  readonly invoice: string;
  readonly clipboard?: Pick<Clipboard, "writeText">;
  readonly onCopied?: () => void;
  readonly onError?: (error: unknown) => void;
}

export interface OpenReceiveOpenWalletButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  readonly invoice: string;
  readonly open?: (uri: string) => void;
  readonly onOpened?: (uri: string) => void;
  readonly onError?: (error: unknown) => void;
}

export interface OpenReceivePaymentStateProps
  extends React.HTMLAttributes<HTMLSpanElement> {
  readonly state?: string;
}

export interface OpenReceiveCheckoutProps
  extends OpenReceiveCheckoutData,
    Omit<React.HTMLAttributes<HTMLElement>, "children"> {
  readonly qrEncoder?: OpenReceiveQrEncoder;
  readonly onError?: (error: unknown) => void;
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

  const copyInvoice = React.useCallback(async () => {
    try {
      await copyInvoiceHelper({
        invoice: options.invoice,
        clipboard: options.clipboard
      });
      setCopied(true);
    } catch (error) {
      options.onError?.(error);
      throw error;
    }
  }, [options.invoice, options.clipboard, options.onError]);

  const openWallet = React.useCallback(() => {
    try {
      return openWalletHelper({
        invoice: options.invoice,
        open: options.open
      });
    } catch (error) {
      options.onError?.(error);
      throw error;
    }
  }, [options.invoice, options.open, options.onError]);

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
    onCopied,
    onError,
    onClick,
    children = "Copy",
    type = "button",
    ...buttonProps
  } = props;

  return React.createElement(
    "button",
    {
      ...buttonProps,
      type,
      onClick: async (event: React.MouseEvent<HTMLButtonElement>) => {
        onClick?.(event);
        if (event.defaultPrevented) return;

        try {
          await copyInvoiceHelper({ invoice, clipboard });
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
    onOpened,
    onError,
    onClick,
    children = "Open Wallet",
    type = "button",
    ...buttonProps
  } = props;

  return React.createElement(
    "button",
    {
      ...buttonProps,
      type,
      onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
        onClick?.(event);
        if (event.defaultPrevented) return;

        try {
          const uri = openWalletHelper({ invoice, open });
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

export function OpenReceiveCheckout(
  props: OpenReceiveCheckoutProps
): React.ReactElement {
  const {
    invoice,
    payment_hash,
    amount_msats,
    transaction_state,
    qrEncoder,
    onError,
    ...sectionProps
  } = props;
  const model = createOpenReceiveCheckoutViewModel({
    invoice,
    payment_hash,
    amount_msats,
    transaction_state
  });

  return React.createElement(
    "section",
    {
      ...sectionProps,
      "data-openreceive-checkout": ""
    },
    React.createElement(OpenReceiveQRCode, {
      invoice,
      encoder: qrEncoder,
      onError,
      style: {
        aspectRatio: "1",
        maxWidth: 256
      }
    }),
    React.createElement(
      "div",
      {
        "data-openreceive-meta": ""
      },
      model.amountLabel === undefined
        ? null
        : React.createElement("span", null, model.amountLabel),
      model.transactionStateLabel === undefined
        ? null
        : React.createElement(OpenReceivePaymentState, {
          state: model.transactionStateLabel
        }),
      model.paymentHashLabel === undefined
        ? null
        : React.createElement("code", null, model.paymentHashLabel)
    ),
    React.createElement("textarea", {
      readOnly: true,
      value: invoice,
      "aria-label": "Lightning invoice"
    }),
    React.createElement(
      "div",
      {
        "data-openreceive-actions": ""
      },
      React.createElement(OpenReceiveCopyButton, {
        invoice,
        onError
      }),
      React.createElement(OpenReceiveOpenWalletButton, {
        invoice,
        onError
      })
    )
  );
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
