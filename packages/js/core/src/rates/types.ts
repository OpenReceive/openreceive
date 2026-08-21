import type { OpenReceiveBtcFiatRateMap, OpenReceiveFiatAmount } from "../money/decimal.ts";

const OPENRECEIVE_PRICE_SOURCE_IDS = ["static_mock", "primary", "fallback"] as const;

export type OpenReceivePriceSourceId = (typeof OPENRECEIVE_PRICE_SOURCE_IDS)[number];

export type OpenReceiveLivePriceSourceId = Exclude<OpenReceivePriceSourceId, "static_mock">;

export interface OpenReceiveDirectAmountQuote {
  amount_sats: number;
  amount_msats: number;
}

export interface OpenReceiveRateQuote {
  fiat: OpenReceiveFiatAmount;
  btc_fiat_price: string;
  amount_sats: number;
  amount_msats: number;
  source: OpenReceivePriceSourceId;
  as_of: number;
  expires_at: number;
}

export interface QuoteFiatToMsatsRequest {
  fiat: OpenReceiveFiatAmount;
  as_of?: number;
}

export interface QuoteFiatToMsatsWithPriceRequest extends QuoteFiatToMsatsRequest {
  btc_fiat_price: string;
  source: OpenReceivePriceSourceId;
  ttl_seconds?: number;
}

export interface OpenReceivePriceProvider {
  getBtcFiatRates(currencies: readonly string[]): Promise<OpenReceiveBtcFiatRateMap>;
}

export interface OpenReceiveSourcedPriceProvider extends OpenReceivePriceProvider {
  readonly source: OpenReceivePriceSourceId;
}

export interface OpenReceiveBtcFiatRateMapWithSource {
  readonly source: OpenReceivePriceSourceId;
  readonly rates: OpenReceiveBtcFiatRateMap;
}

// A price provider that can also report which source actually answered, so a
// cached or multi-URL feed can attribute each rate to its real origin.
export interface OpenReceiveResolvedPriceProvider extends OpenReceiveSourcedPriceProvider {
  getBtcFiatRatesWithSource(
    currencies: readonly string[],
  ): Promise<OpenReceiveBtcFiatRateMapWithSource>;
}

// A live feed that can be probed explicitly to confirm it answers correctly.
export interface OpenReceivePriceFeedHealthCheck {
  healthCheck(currencies?: readonly string[]): Promise<OpenReceiveBtcFiatRateMapWithSource>;
}

/** A provider that can hand back every currency it carries in one read. */
export interface OpenReceiveAvailableRatesProvider {
  getAllBtcFiatRates(): Promise<OpenReceiveBtcFiatRateMap>;
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
  provider: OpenReceiveSourcedPriceProvider,
): provider is OpenReceiveResolvedPriceProvider {
  return (
    typeof (provider as Partial<OpenReceiveResolvedPriceProvider>).getBtcFiatRatesWithSource ===
    "function"
  );
}

export function providerHasGetAllBtcFiatRates(
  provider: OpenReceiveSourcedPriceProvider,
): provider is OpenReceiveSourcedPriceProvider & OpenReceiveAvailableRatesProvider {
  return (
    typeof (provider as Partial<OpenReceiveAvailableRatesProvider>).getAllBtcFiatRates ===
    "function"
  );
}
