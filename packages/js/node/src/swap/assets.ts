import type { SwapAddressNetwork } from "@openreceive/core/swap-address";
import {
  type GeneratedSwapAssetInfo,
  type GeneratedSwapPayInAsset,
  OPENRECEIVE_SWAP_ASSET_INFO,
  OPENRECEIVE_SWAP_PAY_IN_ASSETS,
} from "../generated/swap-tables.ts";

// The asset table is kernel vocabulary (spec/data/kernel-tables.json), generated
// into this package, the Ruby engine, and the BTCPay plugin alike. This module
// adds the lookups and the provider network matching on top of it.
export { OPENRECEIVE_SWAP_PAY_IN_ASSETS };

export type SwapPayInAsset = GeneratedSwapPayInAsset;

export interface SwapAssetInfo extends GeneratedSwapAssetInfo {
  readonly network: SwapAddressNetwork;
}

const ASSET_INFO: Readonly<Record<SwapPayInAsset, SwapAssetInfo>> = OPENRECEIVE_SWAP_ASSET_INFO;

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
