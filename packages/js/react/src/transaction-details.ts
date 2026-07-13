import {
  createOpenReceiveTransactionDetails,
  createOpenReceiveTransactionDetailsFromState,
  openReceiveCheckoutLabels,
  orClasses,
  type CheckoutState,
  type OpenReceiveTransactionDetailRow,
  type OpenReceiveTransactionDetailsInput,
} from "@openreceive/browser/internal";
import * as React from "react";
import { useOpenReceiveTransientValue } from "./hooks.ts";
import { copyOpenReceiveText, joinClassNames } from "./utils.ts";

export type TransactionDetailsSource =
  | CheckoutState
  | OpenReceiveTransactionDetailsInput
  | readonly OpenReceiveTransactionDetailRow[]
  | null
  | undefined;

export interface TransactionDetailsProps {
  readonly state?: TransactionDetailsSource;
  readonly open?: boolean;
  readonly className?: string;
  readonly clipboard?: Pick<Clipboard, "writeText">;
  readonly onError?: (error: unknown) => void;
}

/**
 * Collapsible post-settlement transaction details panel with copy (and optional
 * explorer) buttons. Builds rows from {@link CheckoutState} / detail input, or
 * accepts pre-built rows from `createOpenReceiveTransactionDetails*`.
 */
export function TransactionDetails(props: TransactionDetailsProps): React.ReactElement | null {
  const rows = resolveTransactionDetailRows(props.state);
  if (rows.length === 0) return null;
  return React.createElement(
    "details",
    {
      className: joinClassNames(orClasses.transactionDetails, props.className),
      open: props.open === true ? true : undefined,
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
          renderTransactionDetailRow(row, {
            clipboard: props.clipboard,
            onError: props.onError,
          }),
        ),
      ),
    ),
  );
}

export function resolveTransactionDetailRows(
  source: TransactionDetailsSource,
): OpenReceiveTransactionDetailRow[] {
  if (source === null || source === undefined) return [];
  if (Array.isArray(source)) return [...source];
  if (isCheckoutState(source)) {
    return createOpenReceiveTransactionDetailsFromState(source);
  }
  return createOpenReceiveTransactionDetails(source as OpenReceiveTransactionDetailsInput);
}

function renderTransactionDetailRow(
  row: OpenReceiveTransactionDetailRow,
  options: {
    readonly clipboard?: Pick<Clipboard, "writeText">;
    readonly onError?: (error: unknown) => void;
  },
): readonly React.ReactElement[] {
  const copyValue = row.copyValue ?? row.value;
  return [
    React.createElement(
      "dt",
      { key: `${row.label}-label`, className: orClasses.swapDetailsDt },
      row.label,
    ),
    React.createElement(
      "dd",
      { key: `${row.label}-value`, className: orClasses.swapDetailsDd },
      React.createElement("code", { className: orClasses.swapDetailsCode }, row.value),
      React.createElement(
        "div",
        { className: orClasses.swapDetailsActions },
        React.createElement(TransactionDetailCopyButton, {
          value: copyValue,
          clipboard: options.clipboard,
          onError: options.onError,
        }),
        row.href === undefined
          ? null
          : React.createElement(
              "a",
              {
                className: orClasses.swapDetailsLink,
                href: row.href,
                rel: "noreferrer",
                target: "_blank",
              },
              row.hrefLabel ?? openReceiveCheckoutLabels.viewOnExplorer,
            ),
      ),
    ),
  ];
}

function TransactionDetailCopyButton(props: {
  readonly value: string;
  readonly clipboard?: Pick<Clipboard, "writeText">;
  readonly onError?: (error: unknown) => void;
}): React.ReactElement {
  const [copied, setCopied] = useOpenReceiveTransientValue(false);
  return React.createElement(
    "button",
    {
      className: orClasses.btnSm,
      type: "button",
      onClick: () => {
        void copyOpenReceiveText(props.value, props.clipboard)
          .then(() => setCopied(true))
          .catch((error) => props.onError?.(error));
      },
    },
    copied ? openReceiveCheckoutLabels.copied : "Copy",
  );
}

function isCheckoutState(value: object): value is CheckoutState {
  return (
    "checkout_id" in value &&
    "order_id" in value &&
    "invoice_id" in value &&
    "invoice" in value &&
    "transaction_state" in value &&
    "phase" in value
  );
}
