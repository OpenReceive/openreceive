import { fileURLToPath } from "node:url";
import type {
  OpenReceiveInvoiceKvStore,
  OpenReceiveReceiveNwcClient,
  OpenReceiveSourcedPriceProvider,
} from "@openreceive/core";
import { openReceiveExpress } from "@openreceive/express";
import { guestCheckout } from "@openreceive/http";
import {
  createOpenReceive,
  readOpenReceiveConfigFile,
} from "@openreceive/node";
import express from "express";
import {
  readHelloFruitCheckoutCurrencies,
  readHelloFruitPriceFeedCurrencies,
} from "../../../../shared/demo-currencies.ts";
import {
  createHelloFruitDemoServerLogger,
  createHelloFruitOpenReceiveLogger,
} from "../../../../shared/demo-logging.ts";
import { createHelloFruitDemoMetadata } from "../../../../shared/demo-metadata.ts";
import { createHelloFruitPrepareCheckout } from "../../../../shared/demo-order.ts";
import { mountHelloFruitHostedDemoRoutes } from "../../../../shared/hosted-demo-routes.ts";

const DEMO_ID = "node-express";
const logDemo = createHelloFruitDemoServerLogger(DEMO_ID);

interface HelloFruitOpenReceiveBundle {
  readonly openreceive: Awaited<ReturnType<typeof createOpenReceive>>;
}

export interface HelloFruitOpenReceiveOptions {
  readonly client?: OpenReceiveReceiveNwcClient;
  readonly store?: OpenReceiveInvoiceKvStore;
  readonly priceProviders?: readonly OpenReceiveSourcedPriceProvider[];
  readonly configPath?: string | false;
}

export async function createHelloFruitOpenReceive(options: HelloFruitOpenReceiveOptions = {}) {
  const config = readOpenReceiveConfigFile({ cwd: process.cwd(), configPath: options.configPath });
  logDemo("openreceive.configure", "Preparing OpenReceive demo service.", {
    namespace: config?.namespace ?? "hello_fruit",
    customClient: options.client !== undefined,
    customStore: options.store !== undefined,
    customPriceProviders: options.priceProviders !== undefined,
  });
  const priceCurrencies = readHelloFruitPriceFeedCurrencies();
  const supportedCurrencies = readHelloFruitCheckoutCurrencies();

  logDemo("openreceive.price_currencies", "Loaded checkout and price feed currencies.", {
    checkoutCurrencyCount: supportedCurrencies.length,
    priceCurrencyCount: priceCurrencies.length,
  });

  // Quickstart shape: createOpenReceive({ onPaid }) + mount with prepareCheckout.
  // onPaid may fire more than once — dedupe on checkoutId in a real app.
  const openreceive = await createOpenReceive({
    ...(options.client === undefined ? {} : { client: options.client }),
    ...(options.store === undefined ? {} : { store: options.store }),
    ...(options.priceProviders === undefined ? {} : { priceProviders: options.priceProviders }),
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    namespace: config?.namespace ?? "hello_fruit",
    priceCurrencies,
    logger: createHelloFruitOpenReceiveLogger(DEMO_ID),
    onPaid: async ({ orderId, checkoutId }) => {
      logDemo("openreceive.on_paid", "Checkout settled — fulfill your order here.", {
        orderId,
        checkoutId,
      });
    },
  });
  logDemo("openreceive.ready", "OpenReceive demo service is ready.", {
    priceCurrencyCount: openreceive.priceCurrencies.length,
    checkoutCurrencyCount: supportedCurrencies.length,
  });
  return {
    openreceive,
  } satisfies HelloFruitOpenReceiveBundle;
}

export async function createHelloFruitServer(options: HelloFruitOpenReceiveOptions = {}) {
  logDemo("server.create", "Creating Express demo server.");
  const app = express();
  app.use(express.json());
  app.use(
    "/stickers",
    express.static(fileURLToPath(new URL("../../../../shared/stickers/", import.meta.url))),
  );

  const { openreceive } = await createHelloFruitOpenReceive(options);

  // Mount the shipped OpenReceive routes (same shape as docs/guides/quickstart-node.md).
  // guestCheckout(): anonymous create, Tier-2 reads gated by the per-order capability token.
  // For a signed-in app, swap authorize for withUser instead, e.g.:
  //   import { withUser } from "@openreceive/http";
  //   authorize: withUser((request) => currentUserFromMySession(request), {
  //     ownsOrder: (user, ctx) => orderBelongsTo(user, ctx.resource.order_id),
  //     isAdmin: (user) => user.admin,
  //   }),
  app.use(
    openReceiveExpress({
      service: openreceive,
      authorize: guestCheckout(),
      prepareCheckout: createHelloFruitPrepareCheckout({ demoId: DEMO_ID, openreceive }),
    }),
  );

  logDemo("server.routes", "Mounting demo routes.", {
    staticStickers: "/stickers",
    openReceiveRouter: "/openreceive",
    prepare: "/openreceive/prepare",
    rates: "/rates",
  });

  mountHelloFruitHostedDemoRoutes(app, {
    id: DEMO_ID,
    sourcePath: "examples/hello-fruit/server/node-express",
    docsPath: "docs/guides/quickstart-node.md",
    walletConfigured: true,
    defaultPort: "3000",
  });

  app.get("/demo-metadata.json", (_req, res) => {
    logDemo("metadata.request", "Serving demo metadata.");
    res.status(200).json(
      createHelloFruitDemoMetadata({
        id: DEMO_ID,
        walletConfigured: true,
        requestedMode: process.env.OPENRECEIVE_DEMO_MODE,
        gitSha: process.env.OPENRECEIVE_GIT_SHA,
        imageDigest: process.env.OPENRECEIVE_IMAGE_DIGEST,
        deployedAt: process.env.OPENRECEIVE_DEPLOYED_AT,
        packages: {
          "@openreceive/browser": "0.1.0",
          "@openreceive/angular": "0.1.0",
          "@openreceive/react": "0.1.0",
          "@openreceive/vue": "0.1.0",
          "@openreceive/svelte": "0.1.0",
        },
      }),
    );
  });

  app.get("/rates", async (_req, res, next) => {
    const startedAt = Date.now();
    try {
      const rates = await openreceive.listRates();
      logDemo("rates.response", "Served BTC fiat display rates.", {
        rateCurrencyCount: Object.keys(rates.bitcoin).length,
        elapsedMs: Date.now() - startedAt,
      });
      res.status(200).json({ rates });
    } catch (error) {
      logDemo("rates.error", "Failed to load display rates.", {
        error: error instanceof Error ? error.message : String(error),
        elapsedMs: Date.now() - startedAt,
      });
      next(error);
    }
  });

  return app;
}
