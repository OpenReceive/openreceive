import * as React from "react";
import {
  OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES,
  openReceiveCheckoutLabels,
  type CheckoutSnapshot,
} from "@openreceive/browser/internal";
import {
  CopyInvoiceButton,
  InvoiceSummary,
  PaymentState,
  QRCode,
  SatsDetail,
  WaitingState,
} from "./components.ts";
import { ThemeToggle, useTheme } from "./theme.ts";
import { useCheckout } from "./use-checkout.ts";
import { getCheckoutLogContext, joinClassNames } from "./utils.ts";
import { PaymentWizard } from "./wizard.ts";
import type { CheckoutProps } from "./types.ts";

export type Checkout = CheckoutSnapshot;

export function Checkout(props: CheckoutProps): React.ReactElement {
  const {
    checkout,
    qrEncoder,
    logger,
    onError,
    refreshStatus,
    orderUrl,
    onState,
    onSettled,
    onStartOver,
    polling,
    paymentWizard = true,
    themeSwitcher = false,
    defaultTheme,
    themeStorageKey,
    countryStorageKey,
    components,
    classNames,
    children,
    className,
    ...sectionProps
  } = props;
  const checkoutModel = useCheckout({
    checkout,
    logger,
    onError,
    refreshStatus,
    orderUrl,
    onState,
    onSettled,
    polling,
  });
  const theme = useTheme({
    defaultTheme,
    storageKey: themeStorageKey,
  });
  const [swapFocused, setSwapFocused] = React.useState(false);
  const QRCodeComponent = components?.QRCode ?? QRCode;
  const InvoiceSummaryComponent = components?.InvoiceSummary ?? InvoiceSummary;
  const CopyButton = components?.CopyButton ?? CopyInvoiceButton;
  const ButtonComponent = components?.Button;
  const PaymentStateComponent = components?.PaymentState ?? PaymentState;
  const customChildren = typeof children === "function" ? children(checkoutModel) : children;
  const expired = checkoutModel.status === "expired";
  // While the payer is completing a swap, its deposit panel replaces the Lightning
  // section entirely, so hide the Lightning QR, status, countdown, summary, and copy
  // action. Never hide when expired — that path still shows the Lightning "Start over".
  const hideLightning = swapFocused && !expired;
  const summaryAmountLabel =
    checkoutModel.fiatLabel === undefined ? checkoutModel.amountLabel : undefined;
  const startOver = () => {
    onStartOver?.();
  };

  return React.createElement(
    "section",
    {
      ...sectionProps,
      className: joinClassNames(className, classNames?.root),
      [OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.root]: "",
      ...theme.attributes,
    },
    customChildren === undefined
      ? [
          themeSwitcher
            ? React.createElement(ThemeToggle, {
                key: "theme",
                className: classNames?.themeToggle,
                theme: theme.theme,
                resolvedTheme: theme.resolvedTheme,
                onThemeChange: theme.setTheme,
                ButtonComponent,
              })
            : null,
          hideLightning || expired
            ? null
            : [
                React.createElement(QRCodeComponent, {
                  key: "qr",
                  invoice: checkoutModel.invoice,
                  encoder: qrEncoder,
                  onError,
                  className: classNames?.qr,
                  style: {
                    aspectRatio: "1",
                    justifySelf: "center",
                    maxWidth: 420,
                    width: "min(100%, 420px)",
                  },
                }),
                React.createElement(SatsDetail, {
                  key: "sats-detail",
                  amountLabel: checkoutModel.amountLabel,
                  className: classNames?.satsDetail,
                }),
              ],
          hideLightning
            ? null
            : React.createElement(WaitingState, {
                key: "waiting",
                waiting: checkoutModel.waiting,
                statusTitle: checkoutModel.statusTitle,
                statusDetail: checkoutModel.statusDetail,
                className: classNames?.waiting,
              }),
          hideLightning || checkoutModel.countdownLabel === undefined
            ? null
            : React.createElement(
                "div",
                {
                  key: "countdown",
                  className: joinClassNames("or-countdown", classNames?.countdown),
                },
                checkoutModel.countdownPrefix,
                " ",
                React.createElement("strong", null, checkoutModel.countdownLabel),
              ),
          hideLightning
            ? null
            : React.createElement(InvoiceSummaryComponent, {
                key: "summary",
                amountLabel: summaryAmountLabel,
                fiatLabel: checkoutModel.fiatLabel,
                status: checkoutModel.status,
                PaymentStateComponent,
                className: classNames?.summary,
                classNames,
              }),
          hideLightning
            ? null
            : React.createElement(
                "div",
                {
                  key: "actions",
                  className: classNames?.actions,
                  [OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES.actions]: "",
                },
                expired
                  ? React.createElement(
                      ButtonComponent ?? "button",
                      {
                        type: "button",
                        onClick: startOver,
                      },
                      openReceiveCheckoutLabels.startOver,
                    )
                  : React.createElement(CopyButton, {
                      invoice: checkoutModel.invoice,
                      copyInvoice: checkoutModel.copyInvoice,
                      onError,
                      logger,
                      ButtonComponent,
                      className: classNames?.copyButton,
                    }),
              ),
          paymentWizard && !expired
            ? React.createElement(PaymentWizard, {
                key: "wizard",
                invoice: checkoutModel.invoice,
                checkout: checkoutModel.checkout,
                className: classNames?.wizard,
                logger,
                onError,
                onSwapFocusChange: setSwapFocused,
                countryStorageKey,
                orderUrl,
                qrEncoder,
                logContext: getCheckoutLogContext({
                  invoice_id: checkoutModel.invoice_id,
                  payment_hash: checkoutModel.payment_hash,
                  amount_msats: checkoutModel.amount_msats,
                }),
              })
            : null,
        ]
      : customChildren,
  );
}
