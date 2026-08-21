import {
  checkPayment as checkPaymentWithClient,
  formatOpenReceiveInvalidNwcMessage,
  formatOpenReceiveMissingNwcMessage,
  NwcUriParseError,
  OPENRECEIVE_NWC_CODE_HELP_URL,
  OpenReceiveError,
  parseNwcUri,
  compact,
  reconcilePaymentAttempts,
  unixSeconds,
} from "@openreceive/core";
import { createNwcReceiveClient } from "./alby-nwc.ts";
import type { NwcNotificationUnsubscribe, NwcWalletNotificationHandler } from "./alby-nwc.ts";
import { OpenReceiveConfigError } from "./config-error.ts";
import { createLscSwapProvidersFromEnvironment } from "./lsc-uri.ts";
import { attachOpenReceiveLogging } from "./service/file-logger.ts";
import { createCheckout, prepareCheckout } from "./service/checkouts.ts";
import {
  createOpenReceivePriceFeed,
  listRates,
  quoteRates,
  readOpenReceivePriceCurrencies,
} from "./service/pricing.ts";
import {
  createNwcEndpointLogger,
  emitLog,
  summarizeSwapProviderApiRequest,
  summarizeSwapProviderApiResponse,
} from "./service/logging.ts";
import { createSwap, getSwap, listSwapOptions, quoteSwap, refundSwap } from "./service/swaps.ts";
import type {
  CreateOpenReceiveOptions,
  OpenReceive,
  OpenReceiveLogLevel,
  OpenReceiveServiceContext,
} from "./service/types.ts";
import { TransientSwapCache, SwapProviderWeightBudget } from "./swap/index.ts";

export { OpenReceiveConfigError } from "./config-error.ts";
export { OpenReceiveServiceError } from "./service/core-utils.ts";
export type * from "./service/types.ts";
export { createOpenReceivePriceFeed };

export async function createOpenReceive(
  supplied: CreateOpenReceiveOptions = {},
): Promise<OpenReceive> {
  const environment = supplied.env ?? process.env;
  const options = attachOpenReceiveLogging(supplied);
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

  const priceCurrencies = readOpenReceivePriceCurrencies(options.priceCurrencies);
  // Fiat pricing defaults to the LIVE feed (priceFetch defaults to global
  // fetch inside the feed). There is deliberately no implicit static-mock
  // fallback: a payments service must refuse to price invoices rather than
  // silently quote from a hard-coded rate. Tests and offline dev opt in
  // explicitly with priceProviders: [new StaticPriceProvider()].
  const priceProviders = options.priceProviders ?? [
    createOpenReceivePriceFeed({
      currencies: priceCurrencies,
      fetch: options.priceFetch,
      clock,
      env: environment,
    }),
  ];
  const swapProviders =
    options.swap?.providers ?? createLscSwapProvidersFromEnvironment(environment, { now: clock });
  const nodeOptions: OpenReceiveServiceContext["options"] = { ...options, client };
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

  const context: OpenReceiveServiceContext = {
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
    checkPayment: async (input) => {
      emitLog(
        nodeOptions,
        "debug",
        "payment.check.requested",
        "Polling NWC wallet for payment settlement.",
        compact({
          payment_hash: input.paymentHash,
          created_at: input.createdAt,
          until: input.until,
          overlap_seconds: input.overlapSeconds,
        }),
      );
      try {
        const checked = await checkPaymentWithClient({
          client,
          clock,
          paymentHash: input.paymentHash,
          createdAt: input.createdAt,
          until: input.until,
          overlapSeconds: input.overlapSeconds,
        });
        const transaction = checked.details?.transaction;
        emitLog(
          nodeOptions,
          checked.status === "settled" ? "info" : "debug",
          "payment.check.completed",
          "NWC payment settlement poll completed.",
          compact({
            payment_hash: checked.paymentHash,
            status: checked.status,
            paid_at: checked.paidAt,
            paid_at_source: checked.details?.paid_at_source,
            transaction_state: transaction?.transaction_state,
            settled_at: transaction?.settled_at,
            preimage_present: transaction?.preimage !== undefined,
          }),
        );
        return checked;
      } catch (error) {
        emitLog(
          nodeOptions,
          "error",
          "payment.check.failed",
          "NWC payment settlement poll failed.",
          {
            payment_hash: input.paymentHash,
            created_at: input.createdAt,
            error_message: error instanceof Error ? error.message : String(error),
          },
        );
        throw error;
      }
    },
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
        // (nwc.list_transactions.*).
        emitLog(
          nodeOptions,
          "info",
          "payment.reconcile.completed",
          "NWC payment reconciliation completed.",
          {
            // Attempts scanned vs hashes decided: results collapse duplicate
            // hashes and omit any the wallet walk could not reach, so a gap
            // between these two is how a truncated scan shows up in the log.
            attempt_count: input.attempts.length,
            result_count: results.length,
            settled_count: results.filter((result) => result.status === "settled").length,
            pending_count: results.filter((result) => result.status === "pending").length,
            not_found_count: results.filter((result) => result.status === "not_found").length,
            // All pending attempts share these walks: one creation-time window,
            // never one wallet call per invoice.
            list_transactions_walks: walks.length,
            ...(walks[0] === undefined
              ? {}
              : { window_from: walks[0].from, window_until: walks[0].until }),
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
      // Duck-typed: only wallet clients that support NWC-02 notifications
      // (e.g. AlbyNwcReceiveClient over @getalby/sdk) expose this method.
      const notificationClient = client as typeof client & {
        subscribeNotifications?: (
          handler: NwcWalletNotificationHandler,
        ) => Promise<NwcNotificationUnsubscribe>;
      };
      if (typeof notificationClient.subscribeNotifications !== "function") {
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
      const unsubscribe = await notificationClient.subscribeNotifications((notification) => {
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
function swapProviderApiLogLevel(path: string): OpenReceiveLogLevel {
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
      message: formatOpenReceiveInvalidNwcMessage({ reason, subject }),
      hint: "Use a receive-only nostr+walletconnect URI from a trusted wallet.",
      cause: error,
    });
  }
  return value.trim();
}

/** Truthy environment flag: "1", "true", "yes" (case-insensitive). */
function isEnvironmentFlagEnabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ["1", "true", "yes"].includes(value.trim().toLowerCase());
}

async function preflight(client: OpenReceiveServiceContext["options"]["client"]): Promise<void> {
  try {
    // Always fetches the NIP-47 info event (kind 13194) when the wallet client supports it.
    // Spend methods (e.g. pay_invoice) fail preflight closed unless the host
    // sets the explicit allowSpendCapableWallet override.
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
