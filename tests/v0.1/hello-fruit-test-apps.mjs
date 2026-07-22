/**
 * Test-only Hello Fruit app wrappers. Fake wallet + in-memory store live here — not in the
 * example entrypoints, which require a real OPENRECEIVE_NWC and use local-sqlite.
 */

import { fileURLToPath } from "node:url";
import express from "express";
import { InMemoryInvoiceKvStore, StaticPriceProvider } from "../../packages/js/core/src/index.ts";
import { openReceiveExpress } from "../../packages/js/express/src/index.ts";
import { guestCheckout } from "../../packages/js/http/src/index.ts";
import { openReceiveNextHandlers } from "../../packages/js/next/src/index.ts";
import { createOpenReceive } from "../../packages/js/node/src/index.ts";
import { readHelloFruitPriceFeedCurrencies } from "../../examples/hello-fruit/shared/demo-currencies.ts";
import { mountHelloFruitDelivery, helloFruitDeliveryFetchResponse } from "../../examples/hello-fruit/shared/demo-delivery.ts";
import { fulfillHelloFruitOrder } from "../../examples/hello-fruit/shared/demo-fulfillment.ts";
import {
  createHelloFruitDemoServerLogger,
  createHelloFruitOpenReceiveLogger,
} from "../../examples/hello-fruit/shared/demo-logging.ts";
import { createHelloFruitPrepareCheckout } from "../../examples/hello-fruit/shared/demo-prepare-checkout.ts";

const STICKERS_DIR = fileURLToPath(
  new URL("../../examples/hello-fruit/shared/stickers/", import.meta.url),
);

export class HelloFruitTestReceiveClient {
  count = 0;
  // Track every invoice we mint so status polling can reconcile a real wallet payment and
  // `settleAll()` can move money in the fake wallet (the settle-via-fake-wallet step the mounted
  // order route needs to report a paid order).
  invoices = [];

  async preflight() {
    return {
      walletPubkey: "f".repeat(64),
      relays: ["wss://relay.example.com"],
      methods: ["make_invoice", "list_transactions"],
      encryption: "nip44_v2",
      spendCapabilityAdvertised: false,
      receiveCheckoutReady: true,
      warnings: [],
    };
  }

  async makeInvoice(request) {
    this.count += 1;
    const paymentHash = this.count.toString(16).padStart(64, "0");
    const createdAt = Math.floor(Date.now() / 1000);
    const invoice = {
      invoice: `lnbc-hello-fruit-test-${this.count}`,
      payment_hash: paymentHash,
      amount_msats: request.amount_msats,
      created_at: createdAt,
      expires_at: createdAt + 600,
      transaction_state: "pending",
      settled_at: undefined,
    };
    this.invoices.push(invoice);
    return {
      invoice: invoice.invoice,
      payment_hash: invoice.payment_hash,
      amount_msats: invoice.amount_msats,
      created_at: invoice.created_at,
      expires_at: invoice.expires_at,
    };
  }

  async listTransactions(request) {
    if (request.type === "outgoing") return { transactions: [] };
    const from = request.from ?? 0;
    const until = request.until ?? Number.MAX_SAFE_INTEGER;
    return {
      transactions: this.invoices
        .filter((invoice) => invoice.created_at >= from && invoice.created_at <= until)
        .map((invoice) => ({
          type: "incoming",
          invoice: invoice.invoice,
          payment_hash: invoice.payment_hash,
          amount_msats: invoice.amount_msats,
          transaction_state: invoice.transaction_state,
          created_at: invoice.created_at,
          settled_at: invoice.transaction_state === "settled" ? invoice.settled_at : undefined,
          preimage: invoice.transaction_state === "settled" ? "1".repeat(64) : undefined,
        })),
    };
  }

  /** Settle every minted invoice, so the next order-status reconcile reports the order paid. */
  settleAll(settledAt = Math.floor(Date.now() / 1000)) {
    for (const invoice of this.invoices) {
      invoice.transaction_state = "settled";
      invoice.settled_at = settledAt;
    }
  }
}

export function createHelloFruitTestOpenReceiveOptions() {
  return {
    client: new HelloFruitTestReceiveClient(),
    store: new InMemoryInvoiceKvStore(),
    priceProviders: [new StaticPriceProvider()],
    configPath: false,
  };
}

export async function createHelloFruitServerForTest(options = createHelloFruitTestOpenReceiveOptions()) {
  return createHelloFruitExpressAppForTest("node-express", options);
}

export async function createHelloFruitStaticServerForTest(
  options = createHelloFruitTestOpenReceiveOptions(),
) {
  return createHelloFruitExpressAppForTest("static-html-small-api", options);
}

/**
 * Next.js App Router–shaped GET/POST handlers with the same guestCheckout + prepareCheckout
 * wiring as the example, but with injectable OpenReceive options for CI.
 */
export async function createHelloFruitNextHandlersForTest(
  options = createHelloFruitTestOpenReceiveOptions(),
) {
  const demoId = "nextjs-fullstack";
  let service;
  service = await createOpenReceive({
    priceCurrencies: readHelloFruitPriceFeedCurrencies(),
    logger: createHelloFruitOpenReceiveLogger(demoId),
    ...options,
    onPaid: async ({ orderId, checkoutId }) => {
      await fulfillHelloFruitOrder({
        store: service.store,
        orderId,
        checkoutId,
      });
    },
  });
  const handlers = openReceiveNextHandlers({
    service,
    authorize: guestCheckout(),
    prepareCheckout: createHelloFruitPrepareCheckout({
      demoId,
      demoName: "Next.js",
      openreceive: service,
    }),
  });
  return {
    ...handlers,
    service,
    delivery: (request, orderId, productId) =>
      helloFruitDeliveryFetchResponse({
        store: service.store,
        namespace: service.namespace,
        stickersDir: STICKERS_DIR,
        orderId,
        productId,
        request,
      }),
  };
}

async function createHelloFruitExpressAppForTest(demoId, options) {
  const app = express();
  const logDemo = createHelloFruitDemoServerLogger(demoId);
  app.use(express.json());
  app.use("/stickers", express.static(STICKERS_DIR));

  let service;
  service = await createOpenReceive({
    priceCurrencies: readHelloFruitPriceFeedCurrencies(),
    logger: createHelloFruitOpenReceiveLogger(demoId),
    ...options,
    onPaid: async ({ orderId, checkoutId }) => {
      const result = await fulfillHelloFruitOrder({
        store: service.store,
        orderId,
        checkoutId,
      });
      logDemo("openreceive.on_paid", "Checkout settled — order fulfillment ran.", {
        orderId,
        checkoutId,
        fulfilled: result.fulfilled,
        ...(result.fulfilled ? {} : { reason: result.reason }),
      });
    },
  });

  mountHelloFruitDelivery(app, {
    store: service.store,
    namespace: service.namespace,
    stickersDir: STICKERS_DIR,
  });

  app.use(
    openReceiveExpress({
      service,
      authorize: guestCheckout(),
      prepareCheckout: createHelloFruitPrepareCheckout({ demoId, openreceive: service }),
    }),
  );

  app.get("/rates", async (_req, res, next) => {
    try {
      res.status(200).json({ rates: await service.listRates() });
    } catch (error) {
      next(error);
    }
  });

  return app;
}
