/**
 * HTTP transport for Simple Price compatible endpoints. Everything that touches
 * the network lives here; response interpretation stays in `./parsing.ts`.
 */

import { OpenReceivePriceFeedError, type OpenReceiveBtcFiatRateMap } from "../money/decimal.ts";
import {
  OPENRECEIVE_FALLBACK_PRICE_FEED_URL,
  OPENRECEIVE_PRICE_FEED_FALLBACK_TIMEOUT_MS,
  OPENRECEIVE_PRICE_FEED_PRIMARY_TIMEOUT_MS,
  OPENRECEIVE_PRIMARY_PRICE_FEED_URL,
} from "./constants.ts";
import { parseAvailableSimplePriceResponse, parseSimplePriceResponse } from "./parsing.ts";
import type {
  OpenReceiveAvailableRatesProvider,
  OpenReceiveLivePriceSourceId,
  OpenReceiveSourcedPriceProvider,
  SimplePriceFetch,
  SimplePriceHttpResponse,
} from "./types.ts";

export interface HttpSimplePriceProviderOptions {
  url: string;
  source: OpenReceiveLivePriceSourceId;
  fetch?: SimplePriceFetch;
  timeoutMs?: number;
}

/**
 * Fetches a Simple Price compatible HTTP endpoint and selects the requested
 * fiat currencies. When `timeoutMs` is set, a slow endpoint is aborted so the
 * caller can fall through to another feed.
 *
 * @throws {OpenReceivePriceFeedError} for any transport, status, or body
 * failure — never a `RangeError`, which would read as payer input upstream.
 */
export class HttpSimplePriceProvider
  implements OpenReceiveSourcedPriceProvider, OpenReceiveAvailableRatesProvider
{
  readonly url: string;
  readonly source: OpenReceiveLivePriceSourceId;
  readonly timeoutMs?: number;
  #fetch: SimplePriceFetch;

  constructor(options: HttpSimplePriceProviderOptions) {
    this.url = options.url;
    this.source = options.source;
    this.timeoutMs = options.timeoutMs;
    this.#fetch = options.fetch ?? (globalThis.fetch as unknown as SimplePriceFetch);
  }

  async getBtcFiatRates(currencies: readonly string[]): Promise<OpenReceiveBtcFiatRateMap> {
    return parseSimplePriceResponse(await this.#fetchJson(), currencies, this.source);
  }

  // Returns every well-formed currency the endpoint carries, for caching the
  // whole feed in one read.
  async getAllBtcFiatRates(): Promise<OpenReceiveBtcFiatRateMap> {
    return parseAvailableSimplePriceResponse(await this.#fetchJson());
  }

  async #fetchJson(): Promise<unknown> {
    const response = await this.#fetchWithTimeout();

    if (!response.ok) {
      throw new OpenReceivePriceFeedError(
        `price source ${this.source} returned HTTP ${response.status}`,
      );
    }

    try {
      return JSON.parse(await response.text());
    } catch (error) {
      throw new OpenReceivePriceFeedError(
        `price source ${this.source} returned a body that is not JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async #fetchWithTimeout(): Promise<SimplePriceHttpResponse> {
    const headers = { accept: "application/json" };
    if (this.timeoutMs === undefined) {
      return this.#fetch(this.url, { headers });
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new OpenReceivePriceFeedError(
            `price source ${this.source} did not respond within ${this.timeoutMs}ms`,
          ),
        );
      }, this.timeoutMs);
    });

    try {
      return await Promise.race([
        this.#fetch(this.url, { headers, signal: controller.signal }),
        timeout,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

export interface OpenReceiveLivePriceFeedProviders {
  readonly primary: HttpSimplePriceProvider;
  readonly fallback: HttpSimplePriceProvider;
}

// Builds the primary and fallback live feed providers from the hard-coded URLs
// (or caller overrides). Both carry a timeout: an unbounded fallback would hold
// every fiat quote open for the platform fetch default.
export function createLivePriceFeedProviders(
  options: {
    fetch?: SimplePriceFetch;
    primaryUrl?: string;
    fallbackUrl?: string;
    primaryTimeoutMs?: number;
    fallbackTimeoutMs?: number;
  } = {},
): OpenReceiveLivePriceFeedProviders {
  return {
    primary: new HttpSimplePriceProvider({
      url: options.primaryUrl ?? OPENRECEIVE_PRIMARY_PRICE_FEED_URL,
      source: "primary",
      fetch: options.fetch,
      timeoutMs: options.primaryTimeoutMs ?? OPENRECEIVE_PRICE_FEED_PRIMARY_TIMEOUT_MS,
    }),
    fallback: new HttpSimplePriceProvider({
      url: options.fallbackUrl ?? OPENRECEIVE_FALLBACK_PRICE_FEED_URL,
      source: "fallback",
      fetch: options.fetch,
      timeoutMs: options.fallbackTimeoutMs ?? OPENRECEIVE_PRICE_FEED_FALLBACK_TIMEOUT_MS,
    }),
  };
}
