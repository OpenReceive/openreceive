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
import { currentUnixSeconds, readOpenReceiveNamespace } from "./service/core-utils.ts";
import { toWireCheckout, toWireInvoice, toWireOrder } from "./service/models.ts";
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
  OpenReceivePublicSwap,
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
        toWireInvoice(await startSwap(context, input)),
      );
    },
    async refundSwap(input) {
      return await runOpenReceiveOperation(context, async () =>
        toWireInvoice(await refundSwap(context, input)),
      );
    },
    async order(input) {
      const orderId = input.order_id;
      switch (input.action) {
        case "quote":
          return { quote: await service.swapQuote({ orderId, payInAsset: input.pay_in_asset }) };
        case "start":
          return { invoice: await service.startSwap({ orderId, payInAsset: input.pay_in_asset }) };
        case "refund":
          return {
            invoice: await service.refundSwap({
              attemptId: input.attempt_id,
              refundAddress: input.refund_address,
              refundNonce: input.refund_nonce,
              confirm: input.confirm === true,
            }),
          };
        default: {
          const order = await service.getOrder({ orderId });
          const swap = await service.swapOptions({ orderId });
          return { ...order, payment_methods: swap.enabled ? swap.options : [] };
        }
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
