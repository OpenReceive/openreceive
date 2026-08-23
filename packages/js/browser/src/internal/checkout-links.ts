// Outbound links from the checkout: the block explorer for a deposit or
// payout transaction, an external bolt11 decoder, and the detail-row link that
// picks between them. Every URL is built from an allowlisted network, never
// from provider text.

import { checkoutLabels } from "./ui.ts";

/** Deposit networks that have a public block explorer in OpenReceive UI. */
export type ExplorerNetwork = "ETH" | "SOL" | "TRON";

/**
 * Resolve the chain network from a `pay_in_asset` like `USDT_ETH` / `SOL_SOL`.
 * Returns undefined for unknown or Lightning-only values.
 */
export function getExplorerNetwork(payInAsset: string | undefined): ExplorerNetwork | undefined {
  if (payInAsset === undefined || payInAsset === "") return undefined;
  const network = payInAsset.includes("_")
    ? (payInAsset.split("_").at(-1) ?? payInAsset)
    : payInAsset;
  if (network === "ETH" || network === "SOL" || network === "TRON") return network;
  return undefined;
}

/**
 * Public block-explorer URL for an on-chain address or transaction.
 * Lightning identifiers are intentionally unsupported — use
 * {@link createLightningInvoiceDecodeUrl} for bolt11.
 */
export function createBlockExplorerUrl(options: {
  readonly payInAsset?: string;
  readonly network?: ExplorerNetwork | string;
  readonly kind: "address" | "tx";
  readonly value: string;
}): string | undefined {
  const value = options.value.trim();
  if (value === "") return undefined;
  const network =
    options.network === "ETH" || options.network === "SOL" || options.network === "TRON"
      ? options.network
      : getExplorerNetwork(
          options.payInAsset ?? (typeof options.network === "string" ? options.network : undefined),
        );
  if (network === undefined) return undefined;
  const encoded = encodeURIComponent(value);
  if (network === "ETH") {
    return options.kind === "tx"
      ? `https://etherscan.io/tx/${encoded}`
      : `https://etherscan.io/address/${encoded}`;
  }
  if (network === "SOL") {
    return options.kind === "tx"
      ? `https://solscan.io/tx/${encoded}`
      : `https://solscan.io/account/${encoded}`;
  }
  return options.kind === "tx"
    ? `https://tronscan.org/#/transaction/${encoded}`
    : `https://tronscan.org/#/address/${encoded}`;
}

/**
 * Link to an external bolt11 decoder, as `{decodeLinkUrl}?invoice={bolt11}`.
 * Strips an optional `lightning:` URI prefix.
 *
 * Off unless the host names a decoder: a bolt11 carries the amount, payee and
 * description, and fetching it hands the payer's IP to that third party too, so
 * OpenReceive never picks one on the host's behalf. Omit `decodeLinkUrl` and no
 * link is rendered.
 */
export function createLightningInvoiceDecodeUrl(
  invoice: string,
  decodeLinkUrl?: string,
): string | undefined {
  const base = decodeLinkUrl?.trim();
  if (base === undefined || base === "") return undefined;
  const raw = invoice.trim();
  if (raw === "") return undefined;
  const bolt11 = raw.toLowerCase().startsWith("lightning:") ? raw.slice("lightning:".length) : raw;
  if (bolt11 === "") return undefined;
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}invoice=${encodeURIComponent(bolt11)}`;
}

/**
 * External link metadata for a swap/transaction detail row (explorer or decode).
 */
export function createDetailExternalLink(options: {
  readonly label: string;
  readonly value: string;
  readonly payInAsset?: string;
  /** Host-configured bolt11 decoder. Omitted, no decode link is offered. */
  readonly decodeLinkUrl?: string;
}): { readonly href: string; readonly hrefLabel: string } | undefined {
  const value = options.value.trim();
  if (value === "") return undefined;
  if (options.label === "Lightning invoice") {
    const href = createLightningInvoiceDecodeUrl(value, options.decodeLinkUrl);
    return href === undefined ? undefined : { href, hrefLabel: checkoutLabels.decodeInvoice };
  }
  const kind =
    options.label === "Deposit address" ||
    options.label === "Refund address" ||
    options.label === "Address"
      ? "address"
      : options.label === "Deposit transaction" || options.label === "Refund transaction"
        ? "tx"
        : undefined;
  if (kind === undefined) return undefined;
  const href = createBlockExplorerUrl({
    payInAsset: options.payInAsset,
    kind,
    value,
  });
  return href === undefined ? undefined : { href, hrefLabel: checkoutLabels.viewOnExplorer };
}
