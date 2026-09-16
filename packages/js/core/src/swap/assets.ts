// What the shared pay-in asset table (spec/data/kernel-tables.json) says about
// an asset, for code that only has the `pay_in_asset` string: today, whether
// it is a stablecoin and which currency it tracks.

import { OPENRECEIVE_SWAP_ASSET_INFO } from "../generated/swap-assets.ts";

/**
 * The ISO 4217 currency a stablecoin pay-in asset tracks (`USDC_SOL` → `"USD"`).
 * `undefined` for a coin that floats (`SOL_SOL`, `ETH_ETH`) and for an asset the
 * table does not know, so an unknown asset renders like a floating one.
 */
export function swapPayInAssetPeggedTo(payInAsset: string): string | undefined {
  const info = (
    OPENRECEIVE_SWAP_ASSET_INFO as Readonly<Record<string, { readonly pegged_to?: string }>>
  )[payInAsset];
  return info?.pegged_to;
}
