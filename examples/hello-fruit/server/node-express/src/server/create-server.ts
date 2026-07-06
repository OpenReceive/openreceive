import express from "express";
import { fileURLToPath } from "node:url";
import type {
  OpenReceiveInvoiceKvStore,
  OpenReceiveReceiveNwcClient,
  OpenReceiveSourcedPriceProvider,
} from "@openreceive/core";
import { OpenReceiveServiceError, createOpenReceive } from "@openreceive/node";
import { createHelloFruitDemoMetadata } from "../../../../shared/demo-metadata.ts";
import {
  createHelloFruitDemoServerLogger,
  createHelloFruitOpenReceiveLogger,
} from "../../../../shared/demo-logging.ts";
import {
  createHelloFruitCreateOrderResult,
  createHelloFruitOrderStatus,
  HelloFruitDemoOrderError,
} from "../../../../shared/demo-order.ts";
import { mountHelloFruitHostedDemoRoutes } from "../../../../shared/hosted-demo-routes.ts";
import {
  readHelloFruitCheckoutCurrencies,
  readHelloFruitPriceFeedCurrencies,
} from "../../../../shared/demo-currencies.ts";

const DEMO_ID = "node-express";
const logDemo = createHelloFruitDemoServerLogger(DEMO_ID);

interface HelloFruitOpenReceiveBundle {
  readonly openreceive: Awaited<ReturnType<typeof createOpenReceive>>;
}

export interface HelloFruitOpenReceiveOptions {
  readonly client?: OpenReceiveReceiveNwcClient;
  readonly store?: OpenReceiveInvoiceKvStore;
  readonly priceProviders?: readonly OpenReceiveSourcedPriceProvider[];
}

export async function createHelloFruitOpenReceive(options: HelloFruitOpenReceiveOptions = {}) {
  logDemo("openreceive.configure", "Preparing OpenReceive demo service.", {
    namespace: process.env.OPENRECEIVE_NAMESPACE ?? "hello_fruit",
    customClient: options.client !== undefined,
    customStore: options.store !== undefined,
    customPriceProviders: options.priceProviders !== undefined,
  });
  const priceCurrencies = readHelloFruitPriceFeedCurrencies();
  const supportedCurrencies = readHelloFruitCheckoutCurrencies();

  logDemo("openreceive.price_currencies", "Loaded checkout and price feed currencies.", {
    checkoutCurrencies: supportedCurrencies,
    priceCurrencies,
  });

  const openreceive = await createOpenReceive({
    ...(options.client === undefined ? {} : { client: options.client }),
    ...(options.store === undefined ? {} : { store: options.store }),
    ...(options.priceProviders === undefined ? {} : { priceProviders: options.priceProviders }),
    namespace: process.env.OPENRECEIVE_NAMESPACE ?? "hello_fruit",
    priceCurrencies,
    logger: createHelloFruitOpenReceiveLogger(DEMO_ID),
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

  logDemo("server.routes", "Mounting demo routes.", {
    staticStickers: "/stickers",
    createOrder: "/create_order",
    orderStatus: "/order_status",
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
        rateCurrencies: Object.keys(rates.bitcoin),
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

  app.post("/create_order", async (req, res, next) => {
    const startedAt = Date.now();
    try {
      const body = asRequestBody(req.body);
      logDemo("create_order.request", "Received create order request.", {
        ...summarizeOrderRequest(body),
      });
      const orderResult = await createHelloFruitCreateOrderResult(body, {
        demoId: DEMO_ID,
        openreceive,
      });
      logDemo("create_order.prepared", "Prepared demo order and invoice request.", {
        orderId: orderResult.order.uuid,
        orderStatus: orderResult.order.status,
        total: orderResult.order.total_amount,
        itemCount: orderResult.order.items.length,
      });
      const checkout = await openreceive.getOrCreateCheckout(orderResult.invoiceRequest);
      logDemo("create_order.checkout_created", "Created or reused checkout.", {
        orderId: checkout.order_id,
        elapsedMs: Date.now() - startedAt,
      });
      res.status(201).json({
        order: orderResult.order,
        checkout,
      });
    } catch (error) {
      if (error instanceof OpenReceiveServiceError || error instanceof HelloFruitDemoOrderError) {
        logDemo("create_order.rejected", "Create order request returned a known error.", {
          status: error.status,
          body: error.body,
          elapsedMs: Date.now() - startedAt,
        });
        res.status(error.status).json(error.body);
        return;
      }
      logDemo("create_order.error", "Create order request failed unexpectedly.", {
        error: error instanceof Error ? error.message : String(error),
        elapsedMs: Date.now() - startedAt,
      });
      next(error);
    }
  });
  app.post("/order_status", async (req, res, next) => {
    const startedAt = Date.now();
    try {
      const statusRequest = createStatusRequest(asRequestBody(req.body));
      logDemo("order_status.request", "Received order status request.", {
        orderId: statusRequest.orderId,
      });
      const openreceiveOrder = await openreceive.getOrder(statusRequest);
      const orderStatus = createHelloFruitOrderStatus(openreceiveOrder);
      logDemo("order_status.response", "Refreshed order status.", {
        orderId: orderStatus.order_id,
        orderStatus: orderStatus.order_status,
        ...summarizeSettlementFields(openreceiveOrder),
        elapsedMs: Date.now() - startedAt,
      });
      res.status(200).json({
        ...openreceiveOrder,
        ...orderStatus,
        order: {
          uuid: orderStatus.order_id,
          status: orderStatus.order_status,
        },
      });
    } catch (error) {
      if (error instanceof OpenReceiveServiceError || error instanceof HelloFruitDemoOrderError) {
        logDemo("order_status.rejected", "Order status request returned a known error.", {
          status: error.status,
          body: error.body,
          elapsedMs: Date.now() - startedAt,
        });
        res.status(error.status).json(error.body);
        return;
      }
      logDemo("order_status.error", "Order status request failed unexpectedly.", {
        error: error instanceof Error ? error.message : String(error),
        elapsedMs: Date.now() - startedAt,
      });
      next(error);
    }
  });

  return app;
}

function summarizeOrderRequest(body: Record<string, unknown>): Record<string, unknown> {
  const cart = Array.isArray(body.cart) ? body.cart : [];
  return {
    currency: body.currency,
    cartLineCount: cart.length,
    cartQuantity: cart.reduce((total, item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return total;
      const quantity = (item as Record<string, unknown>).quantity;
      return total + (typeof quantity === "number" && Number.isFinite(quantity) ? quantity : 0);
    }, 0),
    productIds: cart
      .map((item) =>
        typeof item === "object" && item !== null && !Array.isArray(item)
          ? (item as Record<string, unknown>).product_id
          : undefined,
      )
      .filter((productId): productId is string => typeof productId === "string"),
  };
}

function summarizeSettlementFields(value: unknown): Record<string, unknown> {
  const order =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    settledAtPresent: order.settled_at !== undefined,
    transactionState: order.transaction_state,
    state: order.state,
  };
}

function asRequestBody(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
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
