export const OPENRECEIVE_SWAP_PAY_IN_ASSETS = [
  "SOL_SOL",
  "USDT_TRON",
  "USDT_SOL",
  "USDC_SOL",
  "ETH_ETH",
  "USDT_ETH",
  "USDC_ETH",
] as const;

export type OpenReceiveSwapPayInAsset = (typeof OPENRECEIVE_SWAP_PAY_IN_ASSETS)[number];

export interface OpenReceiveSwapAssetInfo {
  readonly pay_in_asset: OpenReceiveSwapPayInAsset;
  readonly label: string;
  readonly network_label: string;
  readonly coin: string;
  readonly network: string;
  readonly expiry_seconds: number;
}

const ASSET_INFO: Readonly<Record<OpenReceiveSwapPayInAsset, OpenReceiveSwapAssetInfo>> = {
  SOL_SOL: {
    pay_in_asset: "SOL_SOL",
    label: "SOL",
    network_label: "Solana",
    coin: "SOL",
    network: "SOL",
    expiry_seconds: 900,
  },
  USDT_TRON: {
    pay_in_asset: "USDT_TRON",
    label: "USDT",
    network_label: "Tron",
    coin: "USDT",
    network: "TRX",
    expiry_seconds: 900,
  },
  USDT_SOL: {
    pay_in_asset: "USDT_SOL",
    label: "USDT",
    network_label: "Solana",
    coin: "USDT",
    network: "SOL",
    expiry_seconds: 900,
  },
  USDC_SOL: {
    pay_in_asset: "USDC_SOL",
    label: "USDC",
    network_label: "Solana",
    coin: "USDC",
    network: "SOL",
    expiry_seconds: 900,
  },
  ETH_ETH: {
    pay_in_asset: "ETH_ETH",
    label: "ETH",
    network_label: "Ethereum",
    coin: "ETH",
    network: "ETH",
    expiry_seconds: 1800,
  },
  USDT_ETH: {
    pay_in_asset: "USDT_ETH",
    label: "USDT",
    network_label: "Ethereum",
    coin: "USDT",
    network: "ETH",
    expiry_seconds: 1800,
  },
  USDC_ETH: {
    pay_in_asset: "USDC_ETH",
    label: "USDC",
    network_label: "Ethereum",
    coin: "USDC",
    network: "ETH",
    expiry_seconds: 1800,
  },
} as const;

export function isOpenReceiveSwapPayInAsset(value: unknown): value is OpenReceiveSwapPayInAsset {
  return (
    typeof value === "string" &&
    (OPENRECEIVE_SWAP_PAY_IN_ASSETS as readonly string[]).includes(value)
  );
}

export function getOpenReceiveSwapAssetInfo(
  payInAsset: OpenReceiveSwapPayInAsset,
): OpenReceiveSwapAssetInfo {
  return ASSET_INFO[payInAsset];
}

export function listOpenReceiveSwapAssetInfo(): readonly OpenReceiveSwapAssetInfo[] {
  return OPENRECEIVE_SWAP_PAY_IN_ASSETS.map((asset) => ASSET_INFO[asset]);
}

export function formatOpenReceiveSwapAssetLabel(payInAsset: OpenReceiveSwapPayInAsset): string {
  const info = getOpenReceiveSwapAssetInfo(payInAsset);
  return `${info.label} (${info.network_label})`;
}

export function normalizeOpenReceiveSwapNetwork(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

export function openReceiveSwapNetworkMatches(expected: string, actual: string): boolean {
  const normalizedExpected = normalizeOpenReceiveSwapNetwork(expected);
  const normalizedActual = normalizeOpenReceiveSwapNetwork(actual);
  if (normalizedActual === normalizedExpected) return true;

  if (normalizedExpected === "TRX") {
    return normalizedActual === "TRON" || normalizedActual === "TRC20" || normalizedActual === "TRC";
  }
  if (normalizedExpected === "ETH") {
    return normalizedActual === "ETHEREUM" || normalizedActual === "ERC20" || normalizedActual === "ERC";
  }
  if (normalizedExpected === "SOL") {
    return normalizedActual === "SOLANA";
  }
  return false;
}

export function isOpenReceiveLightningNetwork(value: string): boolean {
  const normalized = normalizeOpenReceiveSwapNetwork(value);
  return (
    normalized === "LN" ||
    normalized === "LIGHTNING" ||
    normalized === "LIGHTNINGNETWORK" ||
    normalized === "BTCLN" ||
    normalized === "BTCBOLT11"
  );
}

/**
 * Coarse shape-check of a deposit/refund address against the pay-in asset's
 * network (format guard, not full checksum validation). Shared by every swap
 * caller so on-chain address rules live in one place; callers throw their own error.
 */
export function isValidSwapAddressForNetwork(
  payInAsset: OpenReceiveSwapPayInAsset,
  address: string,
): boolean {
  if (address.length > 200 || /\s/.test(address)) return false;
  const network = getOpenReceiveSwapAssetInfo(payInAsset).network;
  if (network === "ETH") return /^0x[0-9a-fA-F]{40}$/.test(address);
  if (network === "SOL") return /^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(address);
  if (network === "TRX") return /^T[1-9A-HJ-NP-Za-km-z]{20,60}$/.test(address);
  return address.length >= 5;
}
