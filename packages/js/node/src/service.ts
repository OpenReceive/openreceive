import {
  checkPayment as checkPaymentWithClient,
  formatOpenReceiveInvalidNwcMessage,
  formatOpenReceiveMissingNwcMessage,
  NwcUriParseError,
  OPENRECEIVE_NWC_CODE_HELP_URL,
  parseNwcUri,
  reconcilePaymentAttempts,
  StaticPriceProvider,
} from "@openreceive/core";
import { createNwcReceiveClient } from "./alby-nwc.ts";
import { OpenReceiveConfigError } from "./config-error.ts";
import { createLscSwapProvidersFromEnvironment } from "./lsc-uri.ts";
import { attachOpenReceiveFileLogging } from "./service/file-logger.ts";
import { createCheckout } from "./service/checkouts.ts";
import { currentUnixSeconds } from "./service/core-utils.ts";
import {
  createOpenReceivePriceFeed,
  listRates,
  quoteRates,
  readOpenReceivePriceCurrencies,
} from "./service/pricing.ts";
import { createSwap, getSwap, quoteSwap, refundSwap } from "./service/swaps.ts";
import type {
  CreateOpenReceiveOptions,
  OpenReceive,
  OpenReceiveServiceContext,
} from "./service/types.ts";
import { TransientSwapCache, SwapProviderWeightBudget } from "./swap/index.ts";

export type { OpenReceiveConfigErrorCode } from "./config-error.ts";
export { OpenReceiveConfigError } from "./config-error.ts";
export { OpenReceiveServiceError } from "./service/core-utils.ts";
export type * from "./service/types.ts";
export { createOpenReceivePriceFeed };

export async function createOpenReceive(
  supplied: CreateOpenReceiveOptions = {},
): Promise<OpenReceive> {
  const environment = supplied.env ?? process.env;
  const options = attachOpenReceiveFileLogging(supplied);
  const clock = options.clock ?? currentUnixSeconds;
  const client =
    options.client ??
    createNwcReceiveClient({
      connectionString: requireNwc(options.nwc ?? environment.NWC_URI),
    });
  await preflight(client);

  const priceCurrencies = readOpenReceivePriceCurrencies(options.priceCurrencies);
  const priceProviders =
    options.priceProviders ??
    (options.priceFetch === undefined
      ? [new StaticPriceProvider()]
      : [
          createOpenReceivePriceFeed({
            currencies: priceCurrencies,
            fetch: options.priceFetch,
            clock,
          }),
        ]);
  const swapProviders =
    options.swap?.providers ?? createLscSwapProvidersFromEnvironment(environment, { now: clock });
  const swapCache = new TransientSwapCache(clock);
  for (const provider of swapProviders) {
    provider.attachSwapCache?.(swapCache);
    provider.attachWeightBudget?.(new SwapProviderWeightBudget(provider.name, clock));
  }

  const context: OpenReceiveServiceContext = {
    options: { ...options, client },
    clock,
    priceProviders,
    priceCurrencies,
    swapProviders,
  };
  const service: OpenReceive = {
    priceCurrencies,
    createCheckout: (input) => createCheckout(context, input),
    checkPayment: (input) =>
      checkPaymentWithClient({
        client,
        clock,
        paymentHash: input.paymentHash,
        createdAt: input.createdAt,
        until: input.until,
        overlapSeconds: input.overlapSeconds,
      }),
    reconcilePayments: (input) =>
      reconcilePaymentAttempts({
        client,
        clock,
        attempts: input.attempts,
        until: input.until,
        overlapSeconds: input.overlapSeconds,
      }),
    quoteSwap: (input) => quoteSwap(context, input),
    createSwap: (input) => createSwap(context, input),
    getSwap: (input) => getSwap(context, input),
    refundSwap: (input) => refundSwap(context, input),
    listRates: (input) => listRates(context, input),
    quoteRates: (input) => quoteRates(context, input),
    async close() {
      await client.close?.();
    },
  };
  return service;
}

function requireNwc(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new OpenReceiveConfigError({
      code: "MISSING_NWC",
      message: formatOpenReceiveMissingNwcMessage(),
      hint: "Set the receive-only connection in NWC_URI or pass nwc explicitly.",
    });
  }
  try {
    parseNwcUri(value.trim());
  } catch (error) {
    const reason = error instanceof NwcUriParseError ? error.description : "Invalid NWC URI.";
    throw new OpenReceiveConfigError({
      code: "INVALID_NWC",
      message: formatOpenReceiveInvalidNwcMessage({ reason }),
      hint: "Use a receive-only nostr+walletconnect URI from a trusted wallet.",
      cause: error,
    });
  }
  return value.trim();
}

async function preflight(client: OpenReceiveServiceContext["options"]["client"]): Promise<void> {
  try {
    // Always fetches the NIP-47 info event (kind 13194) when the wallet client supports it.
    // Spend methods (e.g. pay_invoice) warn and pause inside preflight, then boot continues.
    await client.preflight();
  } catch (cause) {
    throw new OpenReceiveConfigError({
      code: "WALLET_PREFLIGHT_FAILED",
      message: "OpenReceive wallet preflight failed.",
      hint: `Use a receive-only NWC connection advertising make_invoice and list_transactions. Get one at ${OPENRECEIVE_NWC_CODE_HELP_URL}`,
      cause,
    });
  }
}
