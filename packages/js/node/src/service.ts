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
  serviceError,
} from "./service/core-utils.ts";
import { emitLog } from "./service/logging.ts";
import { toWireCheckout, toWireOrder, toWireSwapAttempt } from "./service/models.ts";
import {
  createOpenReceivePriceFeed,
  listRates,
  quoteRates,
  readOpenReceivePriceCurrencies,
} from "./service/pricing.ts";
import { reconcileOptions } from "./service/reconcile.ts";
import { getSwapOptions, quoteSwap, refundSwap, startSwap } from "./service/swaps.ts";
import type {
  CreateOpenReceiveOptions,
  OpenReceive,
  OpenReceiveCheckout,
  OpenReceiveGetOrCreateCheckoutRequest,
  OpenReceiveNodeOptions,
  OpenReceiveOrderRequest,
  OpenReceiveOrderResult,
  OpenReceiveOrderStatus,
  OpenReceiveServiceContext,
} from "./service/types.ts";

export type { OpenReceivePendingSweepResult } from "@openreceive/core";
export type { OpenReceiveConfigErrorCode } from "./config-error.ts";
export { OpenReceiveConfigError } from "./config-error.ts";
export { OpenReceiveServiceError } from "./service/core-utils.ts";
export type {
  CreateOpenReceiveOptions,
  OpenReceive,
  OpenReceiveCheckout,
  OpenReceiveCreateCheckoutAmount,
  OpenReceiveCreateCheckoutRequest,
  OpenReceiveEvent,
  OpenReceiveEventHandler,
  OpenReceiveGetCheckoutRequest,
  OpenReceiveGetOrCreateCheckoutRequest,
  OpenReceiveGetOrderRequest,
  OpenReceiveInvoice,
  OpenReceiveListRatesRequest,
  OpenReceiveLogEntry,
  OpenReceiveLogger,
  OpenReceiveNodeOptions,
  OpenReceiveNodeSettlementActionHook,
  OpenReceiveNodeSettlementActionInput,
  OpenReceiveOrder,
  OpenReceiveOrderRequest,
  OpenReceiveOrderResult,
  OpenReceiveOrderStatus,
  OpenReceivePublicSwap,
  OpenReceiveSwapAttempt,
  OpenReceiveSwapOption,
  OpenReceiveSwapOptions,
  OpenReceiveSwapOptionsRequest,
  OpenReceiveSwapOptionsResponse,
  OpenReceiveSwapQuoteRequest,
  OpenReceiveSwapQuoteResponse,
  OpenReceiveSwapRefundRequest,
  OpenReceiveSwapStartRequest,
} from "./service/types.ts";
export { createOpenReceivePriceFeed };

export async function createOpenReceive(
  options: CreateOpenReceiveOptions = {},
): Promise<OpenReceive> {
  const configuredOptions = mergeOpenReceiveConfigFile(options);
  const namespace = readOpenReceiveNamespace(configuredOptions.namespace);
  assertDurableStoreConfiguration({
    configuredStoreUri: configuredOptions.storeUri,
    store: configuredOptions.store,
  });
  const client = createConfiguredClient(configuredOptions);
  await preflightConfiguredClient(client);

  const store = await resolveConfiguredStore(configuredOptions, namespace);

  const nodeOptions: OpenReceiveNodeOptions = {
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

  const context: OpenReceiveServiceContext = {
    options: nodeOptions,
    store,
    clock: configuredOptions.clock ?? currentUnixSeconds,
    priceProviders,
    priceCurrencies,
    swapProviders,
    swapQuoteCache: new Map(),
  };

  const getOrCreateCheckout = async (
    input: OpenReceiveGetOrCreateCheckoutRequest,
  ): Promise<OpenReceiveCheckout> =>
    await runOpenReceiveOperation(context, async () =>
      toWireCheckout(await createCheckout(context, input)),
    );

  const service: OpenReceive = {
    store,
    namespace,
    priceCurrencies,
    createCheckout: getOrCreateCheckout,
    getOrCreateCheckout,
    async getOrder(input) {
      return await runOpenReceiveOperation(context, async () =>
        toWireOrder(await getOrder(context, input)),
      );
    },
    async getCheckout(input) {
      return await runOpenReceiveOperation(context, async () =>
        toWireCheckout(await getCheckout(context, input)),
      );
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
        toWireSwapAttempt(await startSwap(context, input)),
      );
    },
    async refundSwap(input) {
      return await runOpenReceiveOperation(context, async () =>
        toWireSwapAttempt(await refundSwap(context, input)),
      );
    },
    async order<A extends OpenReceiveOrderRequest>(input: A): Promise<OpenReceiveOrderResult<A>> {
      const request = input as OpenReceiveOrderRequest;
      const orderId = request.order_id;
      switch (request.action) {
        case undefined:
        case "status": {
          const order = await service.getOrder({ orderId });
          const swap = await service.swapOptions({ orderId });
          const status: OpenReceiveOrderStatus = {
            ...order,
            swaps_enabled: swap.enabled,
            swap_pay_options: swap.enabled ? swap.options : [],
          };
          return status as OpenReceiveOrderResult<A>;
        }
        case "swap_quote":
          return {
            quote: await service.swapQuote({ orderId, payInAsset: request.pay_in_asset }),
          } as OpenReceiveOrderResult<A>;
        case "start_swap":
          return {
            attempt: await service.startSwap({ orderId, payInAsset: request.pay_in_asset }),
          } as OpenReceiveOrderResult<A>;
        case "refund_swap":
          return {
            attempt: await service.refundSwap({
              attemptId: request.attempt_id,
              refundAddress: request.refund_address,
              refundNonce: request.refund_nonce,
              confirm: request.confirm === true,
            }),
          } as OpenReceiveOrderResult<A>;
        default:
          throw serviceError(
            400,
            "INVALID_REQUEST",
            `Unknown order action: ${JSON.stringify((request as { action?: unknown }).action)}. Expected "status", "swap_quote", "start_swap", or "refund_swap".`,
          );
      }
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
