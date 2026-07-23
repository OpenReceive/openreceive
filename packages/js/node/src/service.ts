import {
  checkPayment as checkPaymentWithClient,
  scanSettledPayments,
  StaticPriceProvider,
} from "@openreceive/core";
import { createNwcReceiveClient } from "./alby-nwc.ts";
import { readOpenReceiveConfigFile } from "./config.ts";
import { OpenReceiveConfigError } from "./config-error.ts";
import { attachOpenReceiveFileLogging } from "./service/file-logger.ts";
import { createCheckout } from "./service/checkouts.ts";
import { currentUnixSeconds } from "./service/core-utils.ts";
import {
  createOpenReceivePriceFeed,
  listRates,
  quoteRates,
  readOpenReceivePriceCurrencies,
} from "./service/pricing.ts";
import {
  createSwap,
  getSwap,
  quoteSwap,
  refundSwap,
} from "./service/swaps.ts";
import type {
  CreateOpenReceiveOptions,
  OpenReceive,
  OpenReceiveServiceContext,
  PaymentWatcher,
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
  const options = attachOpenReceiveFileLogging(mergeFileConfig(supplied));
  const clock = options.clock ?? currentUnixSeconds;
  const client = options.client ?? createNwcReceiveClient({ connectionString: requireNwc(options.nwc) });
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
  const swapProviders = options.swap?.providers ?? [];
  const swapCache = new TransientSwapCache(clock);
  for (const provider of swapProviders) {
    provider.attachSwapCache?.(swapCache);
    provider.attachWeightBudget?.(
      new SwapProviderWeightBudget(provider.name, clock),
    );
  }

  const context: OpenReceiveServiceContext = {
    options: { ...options, client },
    clock,
    priceProviders,
    priceCurrencies,
    swapProviders,
  };
  const watchers = new Set<PaymentWatcher>();

  const service: OpenReceive = {
    priceCurrencies,
    createCheckout: (input) => createCheckout(context, input),
    async recoverCheckout(input) {
      const checked = await checkPaymentWithClient({
        client,
        clock,
        paymentHash: input.paymentHash,
      });
      const transaction = checked.details?.transaction;
      if (
        checked.status !== "pending" ||
        transaction?.invoice === undefined ||
        transaction.amount_msats === undefined ||
        transaction.created_at === undefined ||
        (input.expiresAt ?? transaction.expires_at ?? transaction.created_at + 600) <= clock()
      ) return null;
      const amountMsats = Number(transaction.amount_msats);
      if (!Number.isSafeInteger(amountMsats)) return null;
      return {
        orderId: input.orderId,
        paymentHash: input.paymentHash.toLowerCase(),
        bolt11: transaction.invoice,
        amountMsats,
        createdAt: transaction.created_at,
        expiresAt: input.expiresAt ?? transaction.expires_at ?? transaction.created_at + 600,
        fiatQuote: null,
      };
    },
    checkPayment: (input) =>
      checkPaymentWithClient({
        client,
        clock,
        paymentHash: input.paymentHash,
        from: input.from,
        until: input.until,
      }),
    async reconcilePayments(input) {
      return await Promise.all(
        input.paymentHashes.map((paymentHash) =>
          checkPaymentWithClient({
            client,
            clock,
            paymentHash,
            from: input.from,
            until: input.until,
          }),
        ),
      );
    },
    watchPayments(input) {
      const watcher = startPaymentWatcher(context, input);
      watchers.add(watcher);
      void watcher.done.finally(() => watchers.delete(watcher));
      return watcher;
    },
    quoteSwap: (input) => quoteSwap(context, input),
    createSwap: (input) => createSwap(context, input),
    getSwap: (input) => getSwap(context, input),
    refundSwap: (input) => refundSwap(context, input),
    listRates: (input) => listRates(context, input),
    quoteRates: (input) => quoteRates(context, input),
    async close() {
      for (const watcher of watchers) watcher.stop();
      await Promise.all([...watchers].map((watcher) => watcher.done));
      await client.close?.();
    },
  };
  return service;
}

function startPaymentWatcher(
  context: OpenReceiveServiceContext,
  input: Parameters<OpenReceive["watchPayments"]>[0],
): PaymentWatcher {
  const controller = new AbortController();
  const pollIntervalMs = input.pollIntervalMs ?? 5_000;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 250) {
    throw new RangeError("pollIntervalMs must be a safe integer of at least 250");
  }
  const from = input.from ?? Math.max(0, context.clock() - 60 * 60);
  const delivered = new Set<string>();
  const onPaid = input.onPaid ?? context.options.onPaid;
  const stop = () => controller.abort();
  input.signal?.addEventListener("abort", stop, { once: true });

  const done = (async () => {
    try {
      while (!controller.signal.aborted) {
        try {
          const settled = await scanSettledPayments({
            client: context.options.client,
            clock: context.clock,
            from,
            until: context.clock(),
          });
          for (const payment of settled) {
            if (delivered.has(payment.paymentHash)) continue;
            await onPaid?.(payment);
            delivered.add(payment.paymentHash);
          }
        } catch {
          // Wallet and callback failures are retried by the next overlapping scan.
        }
        await abortableDelay(pollIntervalMs, controller.signal);
      }
    } finally {
      input.signal?.removeEventListener("abort", stop);
    }
  })();
  return { stop, done };
}

function mergeFileConfig(options: CreateOpenReceiveOptions): CreateOpenReceiveOptions {
  const file = readOpenReceiveConfigFile({
    cwd: options.cwd,
    configPath: options.configPath,
    now: options.clock,
  });
  if (file === undefined) return options;
  return {
    ...(file.nwc === undefined ? {} : { nwc: file.nwc }),
    ...(file.priceCurrencies === undefined ? {} : { priceCurrencies: file.priceCurrencies }),
    ...(file.swap === undefined ? {} : { swap: { providers: file.swap.providers } }),
    ...(file.logging === undefined ? {} : { logging: file.logging }),
    ...options,
  } as CreateOpenReceiveOptions;
}

function requireNwc(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new OpenReceiveConfigError({
      code: "MISSING_NWC",
      message: "OpenReceive requires a receive-only NWC connection string.",
      hint: "Set nwc in openreceive.yml or pass it to createOpenReceive().",
    });
  }
  return value;
}

async function preflight(client: OpenReceiveServiceContext["options"]["client"]): Promise<void> {
  try {
    await client.preflight();
  } catch (cause) {
    throw new OpenReceiveConfigError({
      code: "WALLET_PREFLIGHT_FAILED",
      message: "OpenReceive wallet preflight failed.",
      hint: "Use a receive-only NWC connection advertising make_invoice and list_transactions.",
      cause,
    });
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
