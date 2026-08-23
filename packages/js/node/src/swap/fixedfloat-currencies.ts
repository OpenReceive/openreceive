/**
 * FixedFloat `/ccies` discovery: which provider currency codes stand for
 * OpenReceive's pay-in assets and for the BTC Lightning payout, the cache
 * (de)serialization of that resolution, and the rate-pair keys it implies.
 * `/ccies` carries availability and display metadata only — never limits.
 */

import { recordOrEmpty } from "@openreceive/core";
import {
  getOpenReceiveSwapAssetInfo,
  isOpenReceiveLightningNetwork,
  listOpenReceiveSwapAssetInfo,
  openReceiveSwapNetworkMatches,
  type SwapPayInAsset,
} from "./assets.ts";
import { optionalStringField } from "./fixedfloat-fields.ts";
import { fixedFloatRatesPairKey } from "./fixedfloat-rates.ts";

export interface FixedFloatCurrency {
  readonly code: string;
  readonly coin: string;
  readonly network: string;
  readonly recv?: boolean;
  readonly send?: boolean;
}

export interface FixedFloatCurrencyResolution {
  readonly fetched_at: number;
  readonly pay_in: ReadonlyMap<SwapPayInAsset, FixedFloatCurrency>;
  readonly lightning: FixedFloatCurrency;
}

/**
 * Match a `/ccies` body against OpenReceive's pay-in asset list and pick the
 * Lightning payout currency: `lightningCcy` when configured, otherwise the
 * first sendable BTC Lightning entry.
 */
export function resolveFixedFloatCurrencies(
  data: unknown,
  input: { readonly fetchedAt: number; readonly lightningCcy: string | undefined },
): FixedFloatCurrencyResolution {
  const currencies = readFixedFloatCurrencies(data);
  const payIn = new Map<SwapPayInAsset, FixedFloatCurrency>();
  for (const asset of listOpenReceiveSwapAssetInfo()) {
    const found = currencies.find(
      (currency) =>
        currency.coin.toUpperCase() === asset.coin &&
        openReceiveSwapNetworkMatches(asset.network, currency.network) &&
        // /ccies recv=false means FixedFloat will not accept deposits for this
        // currency — omit it from the catalog rather than failing at /create.
        currency.recv !== false,
    );
    if (found !== undefined) payIn.set(asset.pay_in_asset, found);
  }

  const lightningCurrency =
    input.lightningCcy === undefined
      ? currencies.find(
          (currency) =>
            currency.coin.toUpperCase() === "BTC" &&
            isOpenReceiveLightningNetwork(currency.network) &&
            // Payout side must be sendable to the merchant's bolt11.
            currency.send !== false,
        )
      : currencies.find(
          (currency) => currency.code === input.lightningCcy && currency.send !== false,
        );
  if (lightningCurrency === undefined) {
    throw new Error("FixedFloat /ccies did not include a BTC Lightning payout currency.");
  }

  return {
    fetched_at: input.fetchedAt,
    pay_in: payIn,
    lightning: lightningCurrency,
  };
}

export function serializeFixedFloatCurrencyResolution(
  resolution: FixedFloatCurrencyResolution,
): string {
  return JSON.stringify({
    fetched_at: resolution.fetched_at,
    pay_in: Array.from(resolution.pay_in.entries()),
    lightning: resolution.lightning,
  });
}

export function deserializeFixedFloatCurrencyResolution(
  value: string,
): FixedFloatCurrencyResolution {
  const parsed = JSON.parse(value) as {
    readonly fetched_at: number;
    readonly pay_in: readonly (readonly [SwapPayInAsset, FixedFloatCurrency])[];
    readonly lightning: FixedFloatCurrency;
  };
  return {
    fetched_at: parsed.fetched_at,
    pay_in: new Map(parsed.pay_in),
    lightning: parsed.lightning,
  };
}

/** The provider code for a pay-in asset, or the payer-facing "not supported" error. */
export function requiredFixedFloatCurrency(
  resolution: FixedFloatCurrencyResolution,
  payInAsset: SwapPayInAsset,
): string {
  const currency = resolution.pay_in.get(payInAsset);
  if (currency === undefined) {
    const label = getOpenReceiveSwapAssetInfo(payInAsset).pay_in_asset;
    throw new Error(`FixedFloat does not currently support ${label}.`);
  }
  return currency.code;
}

export function openReceiveFixedFloatRatePairKeys(
  resolution: FixedFloatCurrencyResolution,
): Set<string> {
  const keys = new Set<string>();
  for (const currency of resolution.pay_in.values()) {
    keys.add(fixedFloatRatesPairKey(currency.code, resolution.lightning.code));
  }
  return keys;
}

function readFixedFloatCurrencies(data: unknown): FixedFloatCurrency[] {
  const record = recordOrEmpty(data);
  const items = Array.isArray(data)
    ? data
    : Array.isArray(record.ccies)
      ? record.ccies
      : Array.isArray(record.currencies)
        ? record.currencies
        : [];
  const currencies: FixedFloatCurrency[] = [];
  for (const item of items) {
    const record = recordOrEmpty(item);
    const code = optionalStringField(record, "code") ?? optionalStringField(record, "ticker");
    const coin =
      optionalStringField(record, "coin") ??
      optionalStringField(record, "currency") ??
      optionalStringField(record, "symbol");
    const network =
      optionalStringField(record, "network") ??
      optionalStringField(record, "chain") ??
      optionalStringField(record, "networkName") ??
      optionalStringField(record, "name");
    if (code !== undefined && coin !== undefined && network !== undefined) {
      currencies.push({
        code,
        coin: coin.toUpperCase(),
        network,
        ...(typeof record.recv === "boolean" ? { recv: record.recv } : {}),
        ...(typeof record.send === "boolean" ? { send: record.send } : {}),
      });
    }
  }
  return currencies;
}
