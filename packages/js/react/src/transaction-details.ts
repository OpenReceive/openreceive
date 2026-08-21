import {
  openReceiveCheckoutLabels,
  orClasses,
  type OpenReceiveTransactionDetailRow,
  type OpenReceiveTransactionDetailsSource,
  resolveOpenReceiveTransactionDetailRows,
} from "@openreceive/browser/internal";
import * as React from "react";
import { ClipboardIcon } from "./components.ts";
import { useOpenReceiveTransientValue } from "./hooks.ts";
import { copyOpenReceiveText, joinClassNames } from "./utils.ts";

export interface TransactionDetailsProps {
  readonly state?: OpenReceiveTransactionDetailsSource;
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
  const rows = resolveOpenReceiveTransactionDetailRows(props.state);
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
  const label = copied ? openReceiveCheckoutLabels.copied : "Copy";
  return React.createElement(
    "button",
    {
      className: orClasses.detailCopy,
      type: "button",
      "aria-label": label,
      title: label,
      onClick: () => {
        void copyOpenReceiveText(props.value, props.clipboard)
          .then(() => setCopied(true))
          .catch((error) => props.onError?.(error));
      },
    },
    React.createElement(ClipboardIcon),
  );
}
