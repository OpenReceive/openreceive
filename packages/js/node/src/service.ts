import {
  formatInvalidNwcMessage,
  formatMissingNwcMessage,
  NwcUriParseError,
  OPENRECEIVE_NWC_CODE_HELP_URL,
  OpenReceiveError,
  parseNwcUri,
  reconcilePaymentAttempts,
  unixSeconds,
} from "@openreceive/core";
import { createNwcReceiveClient } from "./alby-nwc.ts";
import { ConfigError } from "./config-error.ts";
import { createLscSwapProvidersFromEnvironment } from "./lsc-uri.ts";
import { attachLogging } from "./service/file-logger.ts";
import { createCheckout, prepareCheckout } from "./service/checkouts.ts";
import { createPriceFeed, listRates, quoteRates, readPriceCurrencies } from "./service/pricing.ts";
import {
  createNwcEndpointLogger,
  emitLog,
  summarizeReconcilePass,
  summarizeSwapProviderApiRequest,
  summarizeSwapProviderApiResponse,
} from "./service/logging.ts";
import { createSwap, getSwap, listSwapOptions, quoteSwap, refundSwap } from "./service/swaps.ts";
import type {
  CreateOpenReceiveOptions,
  OpenReceive,
  LogLevel,
  ServiceContext,
  SwapOptions,
} from "./service/types.ts";
import { type SwapProvider, SwapProviderWeightBudget, TransientSwapCache } from "./swap/index.ts";

export { ConfigError } from "./config-error.ts";
export { ServiceError } from "./service/core-utils.ts";
export type * from "./service/types.ts";
export { createPriceFeed };

export async function createOpenReceive(
  supplied: CreateOpenReceiveOptions = {},
): Promise<OpenReceive> {
  const environment = supplied.env ?? process.env;
  const options = attachLogging(supplied);
  const clock = options.clock ?? unixSeconds;
  const nwcLogger = createNwcEndpointLogger(options);
  const allowSpendCapableWallet =
    options.allowSpendCapableWallet ??
    isEnvironmentFlagEnabled(environment.OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC);
  const client =
    options.client ??
    createNwcReceiveClient({
      connectionString: requireNwc(options.nwc ?? environment.NWC_URI, {
        // Name the source the value actually came from, so the error does not
        // talk about `nwc` when the host only set the env var (or vice versa).
        subject: options.nwc === undefined ? "NWC_URI" : "nwc",
      }),
      allowSpendCapableWallet,
      logger: nwcLogger,
    });
  await preflight(client);

  const priceCurrencies = readPriceCurrencies(options.priceCurrencies);
  // Fiat pricing defaults to the LIVE feed (priceFetch defaults to global
  // fetch inside the feed). There is deliberately no implicit static-mock
  // fallback: a payments service must refuse to price invoices rather than
  // silently quote from a hard-coded rate. Tests and offline dev opt in
  // explicitly with priceProviders: [new StaticPriceProvider()].
  const priceProviders = options.priceProviders ?? [
    createPriceFeed({
      currencies: priceCurrencies,
      fetch: options.priceFetch,
      clock,
      env: environment,
    }),
  ];
  const swapProviders = resolveSwapProviders(options.swap, () =>
    createLscSwapProvidersFromEnvironment(environment, { now: clock }),
  );
  const nodeOptions: ServiceContext["options"] = { ...options, client };
  emitLog(
    nodeOptions,
    "debug",
    "swap.providers.resolved",
    swapProviders.length === 0
      ? "No swap providers configured; automated swaps are disabled."
      : "Resolved automated swap providers.",
    {
      provider_count: swapProviders.length,
      providers: swapProviders.map((provider) => provider.name),
    },
  );
  const swapCache = new TransientSwapCache(clock);
  for (const provider of swapProviders) {
    provider.attachSwapCache?.(swapCache);
    provider.attachWeightBudget?.(new SwapProviderWeightBudget(provider.name, clock));
    provider.attachApiRequestLogger?.((entry) =>
      emitLog(
        nodeOptions,
        swapProviderApiLogLevel(entry.path),
        "swap.provider.request",
        "Swap provider API request.",
        summarizeSwapProviderApiRequest(entry),
      ),
    );
    provider.attachApiResponseLogger?.((entry) =>
      emitLog(
        nodeOptions,
        swapProviderApiLogLevel(entry.path),
        "swap.provider.response",
        "Swap provider API response.",
        summarizeSwapProviderApiResponse(entry),
      ),
    );
  }

  const context: ServiceContext = {
    options: nodeOptions,
    clock,
    priceProviders,
    priceCurrencies,
    swapProviders,
  };
  const service: OpenReceive = {
    priceCurrencies,
    prepareCheckout: (input) => prepareCheckout(context, input),
    createCheckout: (input) => createCheckout(context, input),
    reconcilePayments: async (input) => {
      emitLog(
        nodeOptions,
        "debug",
        "payment.reconcile.requested",
        "Polling NWC wallet to reconcile payment attempts.",
        { attempt_count: input.attempts.length },
      );
      try {
        const walks: { from: number; until: number; includeUnpaid: boolean }[] = [];
        const results = await reconcilePaymentAttempts({
          client,
          clock,
          attempts: input.attempts,
          until: input.until,
          overlapSeconds: input.overlapSeconds,
          maxPages: input.maxPages,
          onWalk: (walk) => walks.push(walk),
        });
        // Info, not debug: passes are durably gated (min 2s apart, and only
        // while attempts are pending), so operators can watch settlement
        // discovery and the batched list_transactions window without turning
        // on debug logging. Per-page detail stays at debug
        // (nwc.list_transactions.*). One line per poll, and a short one: this
        // fires on every status poll while a payer waits.
        const settledCount = results.filter((result) => result.status === "settled").length;
        const pendingCount = results.filter((result) => result.status === "pending").length;
        const notFoundCount = results.filter((result) => result.status === "not_found").length;
        emitLog(
          nodeOptions,
          "info",
          "payment.reconcile.completed",
          summarizeReconcilePass({
            attemptCount: input.attempts.length,
            resultCount: results.length,
            settledCount,
            pendingCount,
            notFoundCount,
          }),
          {
            attempt_count: input.attempts.length,
            settled_count: settledCount,
            pending_count: pendingCount,
            // Zero-valued extras stay off the line; the message already says
            // what was decided.
            ...(notFoundCount === 0 ? {} : { not_found_count: notFoundCount }),
            // Attempts scanned vs hashes decided: results collapse duplicate
            // hashes and omit any the wallet walk could not reach, so a gap
            // between these two is how a truncated scan shows up in the log.
            ...(results.length === input.attempts.length ? {} : { result_count: results.length }),
            // All pending attempts share these walks: one creation-time window,
            // never one wallet call per invoice.
            walks: walks.length,
            ...(walks[0] === undefined ? {} : { window: `${walks[0].from}..${walks[0].until}` }),
          },
        );
        return results;
      } catch (error) {
        emitLog(
          nodeOptions,
          "error",
          "payment.reconcile.failed",
          "NWC payment reconciliation failed.",
          {
            attempt_count: input.attempts.length,
            error_message: error instanceof Error ? error.message : String(error),
          },
        );
        throw error;
      }
    },
    subscribeWalletNotifications: async (handler) => {
      // Declared on NotifyingReceiveNwcClient, not duck-typed: the method is
      // optional because core's ReceiveNwcClient stays the minimum receive
      // contract for custom clients that only poll.
      const subscribe = client.subscribeNotifications;
      if (typeof subscribe !== "function") {
        throw new OpenReceiveError({
          code: "UNSUPPORTED_METHOD",
          message:
            "NWC wallet client does not support NWC notifications (subscribeNotifications). Keep polling reconciliation.",
          retryable: false,
        });
      }
      emitLog(
        nodeOptions,
        "debug",
        "wallet.notifications.subscribe.requested",
        "Subscribing to NWC-02 payment_received wallet notifications.",
      );
      const unsubscribe = await subscribe.call(client, (notification) => {
        // Log only the type and payment hash — never the notification payload.
        emitLog(
          nodeOptions,
          "debug",
          "wallet.notifications.received",
          "NWC wallet notification received.",
          {
            notification_type: notification.type,
            ...(notification.payment_hash === undefined
              ? {}
              : { payment_hash: notification.payment_hash }),
          },
        );
        handler(notification);
      });
      emitLog(
        nodeOptions,
        "info",
        "wallet.notifications.subscribed",
        "Subscribed to NWC-02 payment_received wallet notifications; polling reconciliation remains the safety net.",
      );
      return async () => {
        await unsubscribe();
        emitLog(
          nodeOptions,
          "info",
          "wallet.notifications.unsubscribed",
          "Unsubscribed from NWC-02 wallet notifications.",
        );
      };
    },
    quoteSwap: (input) => quoteSwap(context, input),
    listSwapOptions: (input) => listSwapOptions(context, input),
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

/** Catalog/rate polls are noisy; keep order mutations at info. */
function swapProviderApiLogLevel(path: string): LogLevel {
  const normalized = path.toLowerCase();
  if (
    normalized.includes("rates") ||
    normalized.includes("ccies") ||
    normalized.includes("price")
  ) {
    return "debug";
  }
  return "info";
}

function requireNwc(value: string | undefined, { subject }: { subject: string }): string {
  if (value === undefined || value.trim().length === 0) {
    throw new ConfigError({
      code: "MISSING_NWC",
      message: formatMissingNwcMessage(),
      hint: "Set the receive-only connection in NWC_URI or pass nwc explicitly.",
    });
  }
  try {
    parseNwcUri(value.trim());
  } catch (error) {
    const reason = error instanceof NwcUriParseError ? error.description : "Invalid NWC URI.";
    throw new ConfigError({
      code: "INVALID_NWC",
      message: formatInvalidNwcMessage({ reason, subject }),
      hint: "Use a receive-only nostr+walletconnect URI from a trusted wallet.",
      cause: error,
    });
  }
  return value.trim();
}

/**
 * Primary first, then failovers in declaration order — the order the swap
 * service consults them. Failovers without a primary are a configuration
 * mistake, not something to guess at.
 */
function resolveSwapProviders(
  swap: SwapOptions | undefined,
  fromEnvironment: () => readonly SwapProvider[],
): readonly SwapProvider[] {
  if (swap?.provider !== undefined) return [swap.provider, ...(swap.failoverProviders ?? [])];
  if (swap?.failoverProviders !== undefined && swap.failoverProviders.length > 0) {
    throw new TypeError("swap.failoverProviders requires swap.provider.");
  }
  return fromEnvironment();
}

/**
 * Truthy environment flag: "1", "true", "yes" (case-insensitive).
 *
 * A value that is SET but unrecognized warns before reading as off — a typo
 * like "truee" must not silently mean "unset" on the one flag that overrides
 * the spend-capable wallet refusal. Mirrors the Ruby service's warning.
 */
function isEnvironmentFlagEnabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes"].includes(normalized)) return true;
  if (normalized.length > 0) {
    console.warn(
      `[openreceive] Unrecognized OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC value ${JSON.stringify(value)}; ` +
        "treating it as disabled. Use 1/true/yes to enable.",
    );
  }
  return false;
}

async function preflight(client: ServiceContext["options"]["client"]): Promise<void> {
  try {
    // Always fetches the NIP-47 info event (kind 13194) when the wallet client supports it.
    // Spend methods (e.g. pay_invoice) fail preflight closed unless the host
    // sets the explicit allowSpendCapableWallet override.
    await client.preflight();
  } catch (cause) {
    throw new ConfigError({
      code: "WALLET_PREFLIGHT_FAILED",
      message: "OpenReceive wallet preflight failed.",
      hint: `Use a receive-only NWC connection advertising make_invoice and list_transactions. Get one at ${OPENRECEIVE_NWC_CODE_HELP_URL}`,
      cause,
    });
  }
}
