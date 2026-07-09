import { sweepPendingInvoicesOnce } from "@openreceive/core";
import {
  assertDurableStoreConfiguration,
  closeOpenReceiveResource,
  createConfiguredClient,
  mergeOpenReceiveConfigFile,
  preflightConfiguredClient,
  resolveConfiguredStore,
  resolveConfiguredSwapProviders,
  runOpenReceiveOperation,
} from "./service/bootstrap.ts";
import { createCheckout, getCheckout, getOrder } from "./service/checkouts.ts";
import {
  currentUnixSeconds,
  readOpenReceiveNamespace,
} from "./service/core-utils.ts";
import { attachOpenReceiveFileLogging } from "./service/file-logger.ts";
import { emitLog } from "./service/logging.ts";
import { toSwapAttempt } from "./service/models.ts";
import {
  createOpenReceivePriceFeed,
  listRates,
  quoteRates,
  readOpenReceivePriceCurrencies,
} from "./service/pricing.ts";
import { reconcileOptions } from "./service/reconcile.ts";
import {
  getSwapOptions,
  quoteSwap,
  refreshSwap,
  refundSwap,
  startSwap,
} from "./service/swaps.ts";
import { StoreBackedSwapCache, SwapProviderWeightBudget } from "./swap/index.ts";
import type {
  CreateOpenReceiveOptions,
  OpenReceive,
  Checkout,
  GetOrCreateCheckoutRequest,
  NodeOptions,
  OpenReceiveServiceContext,
} from "./service/types.ts";

export type { OpenReceivePendingSweepResult as PendingSweepResult } from "@openreceive/core";
export type { OpenReceiveConfigErrorCode } from "./config-error.ts";
export { OpenReceiveConfigError } from "./config-error.ts";
export { OpenReceiveServiceError } from "./service/core-utils.ts";
export type {
  CreateOpenReceiveOptions,
  OpenReceive,
  Checkout,
  CreateCheckoutAmount,
  CreateCheckoutRequest,
  Event,
  EventHandler,
  GetCheckoutRequest,
  GetOrCreateCheckoutRequest,
  GetOrderRequest,
  Invoice,
  ListRatesRequest,
  LogEntry,
  Logger,
  LoggingOptions,
  NodeOptions,
  NodeSettlementActionHook,
  NodeSettlementActionInput,
  Order,
  OrderStatus,
  PublicSwap,
  SwapAttempt,
  SwapOption,
  SwapOptions,
  SwapOptionsRequest,
  SwapOptionsResponse,
  SwapQuoteRequest,
  SwapQuoteResponse,
  SwapRefreshRequest,
  SwapRefundRequest,
  SwapStartRequest,
} from "./service/types.ts";
export { createOpenReceivePriceFeed };

export async function createOpenReceive(
  options: CreateOpenReceiveOptions = {},
): Promise<OpenReceive> {
  // Attach the rotating file logger (unless disabled) before any sink is built so the
  // NWC endpoint bridge and every service event write to ./logs as well as any caller logger.
  const configuredOptions = attachOpenReceiveFileLogging(mergeOpenReceiveConfigFile(options));
  const namespace = readOpenReceiveNamespace(configuredOptions.namespace);
  assertDurableStoreConfiguration({
    configuredStoreUri: configuredOptions.storeUri,
    store: configuredOptions.store,
  });
  const client = createConfiguredClient(configuredOptions);
  await preflightConfiguredClient(client);

  const store = await resolveConfiguredStore(configuredOptions, namespace);

  const nodeOptions: NodeOptions = {
    ...configuredOptions,
    client,
    store,
    namespace,
    onPaid: configuredOptions.onPaid,
  };
  const priceCurrencies = readOpenReceivePriceCurrencies(configuredOptions.priceCurrencies);
  const priceProviders = configuredOptions.priceProviders ?? [
    createOpenReceivePriceFeed({
      store,
      currencies: priceCurrencies,
      fetch: configuredOptions.priceFetch,
      clock: configuredOptions.clock,
    }),
  ];
  const swapProviders = resolveConfiguredSwapProviders(configuredOptions);
  emitLog(
    nodeOptions,
    "info",
    "swap.providers.resolved",
    swapProviders.length === 0
      ? "No swap providers configured; automated swaps are disabled."
      : "Resolved automated swap providers.",
    {
      provider_count: swapProviders.length,
      providers: swapProviders.map((provider) => provider.name),
    },
  );

  const clock = configuredOptions.clock ?? currentUnixSeconds;
  if (swapProviders.length > 0) {
    // Providers are constructed before the store exists (config parse time / by
    // the caller), so the durable limits cache is attached here once the store
    // is available. This keeps slow-changing provider data out of process memory
    // and shared across serverless instances.
    const swapCache = new StoreBackedSwapCache(store, clock, {
      warn: (message, fields) => emitLog(nodeOptions, "warn", "swap.limits.stale", message, fields),
    });
    for (const provider of swapProviders) {
      provider.attachSwapCache?.(swapCache);
      // Shared durable weight ledger so multi-dyno deploys cannot each burn a
      // provider's 250/min budget independently. Per-provider keys enable failover
      // to the next entry in swap.providers when the preferred one is limited.
      provider.attachWeightBudget?.(new SwapProviderWeightBudget(store, provider.name, clock));
      provider.attachApiRequestLogger?.((entry) =>
        emitLog(nodeOptions, "info", "swap.provider.request", "Swap provider API request.", {
          provider: entry.provider,
          path: entry.path,
          body: entry.body,
        }),
      );
      provider.attachApiResponseLogger?.((entry) =>
        emitLog(nodeOptions, "info", "swap.provider.response", "Swap provider API response.", {
          provider: entry.provider,
          path: entry.path,
          status: entry.status,
          ok: entry.ok,
          code: entry.code,
          msg: entry.msg,
          data: entry.data,
        }),
      );
    }
  }

  const context: OpenReceiveServiceContext = {
    options: nodeOptions,
    store,
    clock,
    priceProviders,
    priceCurrencies,
    swapProviders,
  };

  const getOrCreateCheckout = async (
    input: GetOrCreateCheckoutRequest,
  ): Promise<Checkout> =>
    await runOpenReceiveOperation(context, async () => await createCheckout(context, input));

  const service: OpenReceive = {
    store,
    namespace,
    priceCurrencies,
    getOrCreateCheckout,
    async getOrder(input) {
      return await runOpenReceiveOperation(context, async () => await getOrder(context, input));
    },
    async getCheckout(input) {
      return await runOpenReceiveOperation(context, async () => await getCheckout(context, input));
    },
    async sweepPendingInvoices() {
      return await runOpenReceiveOperation(
        context,
        async () => await sweepPendingInvoicesOnce(reconcileOptions(context)),
      );
    },
    async swapOptions(input) {
      return await runOpenReceiveOperation(context, () => getSwapOptions(context, input));
    },
    async swapQuote(input) {
      return await runOpenReceiveOperation(context, () => quoteSwap(context, input));
    },
    async startSwap(input) {
      return await runOpenReceiveOperation(context, async () =>
        toSwapAttempt(await startSwap(context, input)),
      );
    },
    async refundSwap(input) {
      return await runOpenReceiveOperation(context, async () =>
        toSwapAttempt(await refundSwap(context, input)),
      );
    },
    async refreshSwap(input) {
      return await runOpenReceiveOperation(context, async () =>
        toSwapAttempt(await refreshSwap(context, input)),
      );
    },
    async listRates(input) {
      return await runOpenReceiveOperation(context, () => listRates(context, input));
    },
    async quoteRates(input) {
      return await runOpenReceiveOperation(context, () => quoteRates(context, input));
    },
    async close() {
      await closeOpenReceiveResource(store);
      await closeOpenReceiveResource(client);
    },
  };

  return service;
}
