import type { BtcFiatRateMap, MoneyAmount } from "../money/decimal.ts";

const OPENRECEIVE_PRICE_SOURCE_IDS = ["static_mock", "primary", "fallback"] as const;

export type PriceSourceId = (typeof OPENRECEIVE_PRICE_SOURCE_IDS)[number];

export type LivePriceSourceId = Exclude<PriceSourceId, "static_mock">;

export interface DirectAmountQuote {
  amountSats: number;
  amountMsats: number;
}

/**
 * A fiat-to-msats quote, camelCase like every other TS surface. On the wire
 * (`fiat_quote` in checkout bodies) the same object is serialized snake_case
 * by the HTTP handler.
 */
export interface RateQuote {
  fiat: MoneyAmount;
  btcFiatPrice: string;
  amountSats: number;
  amountMsats: number;
  source: PriceSourceId;
  asOf: number;
  expiresAt: number;
}

export interface QuoteFiatToMsatsRequest {
  fiat: MoneyAmount;
  asOf?: number;
}

export interface QuoteFiatToMsatsWithPriceRequest extends QuoteFiatToMsatsRequest {
  btcFiatPrice: string;
  source: PriceSourceId;
  ttlSeconds?: number;
}

export interface PriceProvider {
  getBtcFiatRates(currencies: readonly string[]): Promise<BtcFiatRateMap>;
}

export interface SourcedPriceProvider extends PriceProvider {
  readonly source: PriceSourceId;
}

export interface BtcFiatRateMapWithSource {
  readonly source: PriceSourceId;
  readonly rates: BtcFiatRateMap;
}

// A price provider that can also report which source actually answered, so a
// cached or multi-URL feed can attribute each rate to its real origin.
export interface ResolvedPriceProvider extends SourcedPriceProvider {
  getBtcFiatRatesWithSource(currencies: readonly string[]): Promise<BtcFiatRateMapWithSource>;
}

// A live feed that can be probed explicitly to confirm it answers correctly.
export interface PriceFeedHealthCheck {
  healthCheck(currencies?: readonly string[]): Promise<BtcFiatRateMapWithSource>;
}

/** A provider that can hand back every currency it carries in one read. */
export interface AvailableRatesProvider {
  getAllBtcFiatRates(): Promise<BtcFiatRateMap>;
}

export interface SimplePriceHttpResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type SimplePriceFetch = (
  url: string,
  init?: {
    headers?: Record<string, string>;
    signal?: AbortSignal;
  },
) => Promise<SimplePriceHttpResponse>;

export function isResolvedPriceProvider(
  provider: SourcedPriceProvider,
): provider is ResolvedPriceProvider {
  return (
    typeof (provider as Partial<ResolvedPriceProvider>).getBtcFiatRatesWithSource === "function"
  );
}

export function providerHasGetAllBtcFiatRates(
  provider: SourcedPriceProvider,
): provider is SourcedPriceProvider & AvailableRatesProvider {
  return typeof (provider as Partial<AvailableRatesProvider>).getAllBtcFiatRates === "function";
}
