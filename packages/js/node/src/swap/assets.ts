import type { SwapAddressNetwork } from "@openreceive/core/swap-address";

export const OPENRECEIVE_SWAP_PAY_IN_ASSETS = [
  "SOL_SOL",
  "USDT_TRON",
  "USDT_SOL",
  "USDC_SOL",
  "ETH_ETH",
  "USDT_ETH",
  "USDC_ETH",
] as const;

export type SwapPayInAsset = (typeof OPENRECEIVE_SWAP_PAY_IN_ASSETS)[number];

export interface SwapAssetInfo {
  readonly pay_in_asset: SwapPayInAsset;
  readonly label: string;
  readonly network_label: string;
  readonly coin: string;
  readonly network: SwapAddressNetwork;
}

const ASSET_INFO: Readonly<Record<SwapPayInAsset, SwapAssetInfo>> = {
  SOL_SOL: {
    pay_in_asset: "SOL_SOL",
    label: "SOL",
    network_label: "Solana",
    coin: "SOL",
    network: "SOL",
  },
  USDT_TRON: {
    pay_in_asset: "USDT_TRON",
    label: "USDT",
    network_label: "Tron",
    coin: "USDT",
    network: "TRX",
  },
  USDT_SOL: {
    pay_in_asset: "USDT_SOL",
    label: "USDT",
    network_label: "Solana",
    coin: "USDT",
    network: "SOL",
  },
  USDC_SOL: {
    pay_in_asset: "USDC_SOL",
    label: "USDC",
    network_label: "Solana",
    coin: "USDC",
    network: "SOL",
  },
  ETH_ETH: {
    pay_in_asset: "ETH_ETH",
    label: "ETH",
    network_label: "Ethereum",
    coin: "ETH",
    network: "ETH",
  },
  USDT_ETH: {
    pay_in_asset: "USDT_ETH",
    label: "USDT",
    network_label: "Ethereum",
    coin: "USDT",
    network: "ETH",
  },
  USDC_ETH: {
    pay_in_asset: "USDC_ETH",
    label: "USDC",
    network_label: "Ethereum",
    coin: "USDC",
    network: "ETH",
  },
} as const;

export function isSwapPayInAsset(value: unknown): value is SwapPayInAsset {
  return (
    typeof value === "string" &&
    (OPENRECEIVE_SWAP_PAY_IN_ASSETS as readonly string[]).includes(value)
  );
}

export function getSwapAssetInfo(payInAsset: SwapPayInAsset): SwapAssetInfo {
  return ASSET_INFO[payInAsset];
}

export function listSwapAssetInfo(): readonly SwapAssetInfo[] {
  return OPENRECEIVE_SWAP_PAY_IN_ASSETS.map((asset) => ASSET_INFO[asset]);
}

export function normalizeSwapNetwork(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

export function swapNetworkMatches(expected: string, actual: string): boolean {
  const normalizedExpected = normalizeSwapNetwork(expected);
  const normalizedActual = normalizeSwapNetwork(actual);
  if (normalizedActual === normalizedExpected) return true;

  if (normalizedExpected === "TRX") {
    return (
      normalizedActual === "TRON" || normalizedActual === "TRC20" || normalizedActual === "TRC"
    );
  }
  if (normalizedExpected === "ETH") {
    return (
      normalizedActual === "ETHEREUM" || normalizedActual === "ERC20" || normalizedActual === "ERC"
    );
  }
  if (normalizedExpected === "SOL") {
    return normalizedActual === "SOLANA";
  }
  return false;
}

export function isLightningNetwork(value: string): boolean {
  const normalized = normalizeSwapNetwork(value);
  return (
    normalized === "LN" ||
    normalized === "LIGHTNING" ||
    normalized === "LIGHTNINGNETWORK" ||
    normalized === "BTCLN" ||
    normalized === "BTCBOLT11"
  );
}
