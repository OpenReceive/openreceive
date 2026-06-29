import express from "express";
import { fileURLToPath } from "node:url";
import type {
  OpenReceiveInvoiceKvStore,
  OpenReceiveReceiveNwcClient,
  OpenReceiveSourcedPriceProvider
} from "@openreceive/core";
import {
  OpenReceiveServiceError,
  createOpenReceive,
  createOpenReceivePriceFeed
} from "@openreceive/node";
import {
  createHelloFruitDemoMetadata
} from "../../../../shared/demo-metadata.ts";
import {
  readRequiredHelloFruitNwcConnectionString
} from "../../../../shared/demo-nwc.ts";
import {
  createHelloFruitOpenReceiveLogger
} from "../../../../shared/demo-logging.ts";
import {
  createHelloFruitCreateOrderResult,
  createHelloFruitOrderStatus,
  HelloFruitDemoOrderError
} from "../../../../shared/demo-order.ts";
import {
  mountHelloFruitHostedDemoRoutes
} from "../../../../shared/hosted-demo-routes.ts";
import {
  createHelloFruitOpenReceiveKvStore
} from "../../../../shared/openreceive-store.ts";
import {
  readHelloFruitCheckoutCurrencies,
  readHelloFruitPriceFeedCurrencies
} from "../../../../shared/demo-currencies.ts";
import {
  readHelloFruitOrderRates
} from "../../../../shared/demo-price-feeds.ts";
import product from "../../../../shared/product.json" with { type: "json" };

const DEMO_ID = "node-express";

interface HelloFruitOpenReceiveBundle {
  readonly openreceive: Awaited<ReturnType<typeof createOpenReceive>>;
  readonly priceProviders: readonly OpenReceiveSourcedPriceProvider[];
  readonly supportedCurrencies: readonly string[];
}

export interface HelloFruitOpenReceiveOptions {
  readonly client?: OpenReceiveReceiveNwcClient;
  readonly store?: OpenReceiveInvoiceKvStore;
  readonly priceProviders?: readonly OpenReceiveSourcedPriceProvider[];
}

export async function createHelloFruitOpenReceive(
  options: HelloFruitOpenReceiveOptions = {}
) {
  const priceCurrencies = readHelloFruitPriceFeedCurrencies();
  const supportedCurrencies = readHelloFruitCheckoutCurrencies();
  const clientOptions = options.client === undefined
    ? { nwc: readRequiredHelloFruitNwcConnectionString() }
    : { client: options.client };
  const store = options.store ?? await createHelloFruitOpenReceiveKvStore({
    demoId: DEMO_ID
  });
  const priceProviders: readonly OpenReceiveSourcedPriceProvider[] =
    options.priceProviders ??
    [createOpenReceivePriceFeed({ store, currencies: priceCurrencies })];

  const openreceive = await createOpenReceive({
    ...clientOptions,
    store,
    namespace: process.env.OPENRECEIVE_NAMESPACE ?? "hello_fruit",
    priceProviders,
    priceCurrencies,
    logger: createHelloFruitOpenReceiveLogger(DEMO_ID)
  });
  return { openreceive, priceProviders, supportedCurrencies } satisfies HelloFruitOpenReceiveBundle;
}

export async function createHelloFruitServer(
  options: HelloFruitOpenReceiveOptions = {}
) {
  const app = express();
  app.use(express.json());
  app.use(
    "/stickers",
    express.static(fileURLToPath(new URL("../../../../shared/stickers/", import.meta.url)))
  );

  const {
    openreceive,
    priceProviders,
    supportedCurrencies
  } = await createHelloFruitOpenReceive(options);

  mountHelloFruitHostedDemoRoutes(app, {
    id: DEMO_ID,
    sourcePath: "examples/hello-fruit/server/node-express",
    docsPath: "docs/guides/quickstart-node.md",
    walletConfigured: true,
    defaultPort: "3000"
  });

  app.get("/demo-metadata.json", (_req, res) => {
    res.status(200).json(createHelloFruitDemoMetadata({
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
        "@openreceive/svelte": "0.1.0"
      }
    }));
  });

  app.post("/create_order", async (req, res, next) => {
    try {
      const body = asRequestBody(req.body);
      const rates = await readHelloFruitOrderRates({
        currency: body.currency,
        priceProviders,
        supportedCurrencies
      });
      const orderResult = createHelloFruitCreateOrderResult({
        ...body,
        idempotency_key: req.body?.idempotency_key ?? req.get("idempotency-key")
      }, {
        demoId: DEMO_ID,
        invoiceExpirySeconds: product.invoice_expiry_seconds,
        rates,
        supportedCurrencies
      });
      const checkout = await openreceive.createCheckout(orderResult.invoiceRequest);
      res.status(201).json({
        order: orderResult.order,
        checkout
      });
    } catch (error) {
      if (error instanceof OpenReceiveServiceError || error instanceof HelloFruitDemoOrderError) {
        res.status(error.status).json(error.body);
        return;
      }
      next(error);
    }
  });
  app.post("/order_status", async (req, res, next) => {
    try {
      const openreceiveOrder = await openreceive.getOrder(createStatusRequest(asRequestBody(req.body)));
      const orderStatus = createHelloFruitOrderStatus(openreceiveOrder);
      res.status(200).json({
        ...openreceiveOrder,
        ...orderStatus,
        order: {
          uuid: orderStatus.order_id,
          status: orderStatus.order_status
        }
      });
    } catch (error) {
      if (error instanceof OpenReceiveServiceError || error instanceof HelloFruitDemoOrderError) {
        res.status(error.status).json(error.body);
        return;
      }
      next(error);
    }
  });

  return app;
}

function asRequestBody(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function createStatusRequest(body: Record<string, unknown>): {
  readonly orderId: string;
} {
  const orderId = body.order_id;
  if (typeof orderId !== "string" || orderId.length === 0) {
    throw new HelloFruitDemoOrderError("order_id is required.");
  }
  return { orderId };
}
