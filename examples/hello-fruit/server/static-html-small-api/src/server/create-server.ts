import express from "express";
import { fileURLToPath } from "node:url";
import type {
  OpenReceiveInvoiceKvStore,
  OpenReceiveReceiveNwcClient,
  OpenReceiveSourcedPriceProvider,
} from "@openreceive/core";
import {
  OpenReceiveServiceError,
  createOpenReceive,
  createOpenReceivePriceFeed,
} from "@openreceive/node";
import { createHelloFruitDemoMetadata } from "../../../../shared/demo-metadata.ts";
import { readRequiredHelloFruitNwcConnectionString } from "../../../../shared/demo-nwc.ts";
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
import { createHelloFruitOpenReceiveKvStore } from "../../../../shared/openreceive-store.ts";
import {
  readHelloFruitCheckoutCurrencies,
  readHelloFruitPriceFeedCurrencies,
} from "../../../../shared/demo-currencies.ts";
import { readHelloFruitOrderRates } from "../../../../shared/demo-price-feeds.ts";
import product from "../../../../shared/product.json" with { type: "json" };

const DEMO_ID = "static-html-small-api";
const logDemo = createHelloFruitDemoServerLogger(DEMO_ID);

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

export async function createHelloFruitOpenReceive(options: HelloFruitOpenReceiveOptions = {}) {
  logDemo("openreceive.configure", "Preparing OpenReceive demo service.", {
    namespace: process.env.OPENRECEIVE_NAMESPACE ?? "hello_fruit",
    customClient: options.client !== undefined,
    customStore: options.store !== undefined,
    customPriceProviders: options.priceProviders !== undefined,
  });
  const priceCurrencies = readHelloFruitPriceFeedCurrencies();
  const supportedCurrencies = readHelloFruitCheckoutCurrencies();
  const clientOptions =
    options.client === undefined
      ? { nwc: readRequiredHelloFruitNwcConnectionString() }
      : { client: options.client };
  const store =
    options.store ??
    (await createHelloFruitOpenReceiveKvStore({
      demoId: DEMO_ID,
    }));
  const priceProviders: readonly OpenReceiveSourcedPriceProvider[] = options.priceProviders ?? [
    createOpenReceivePriceFeed({ store, currencies: priceCurrencies }),
  ];

  logDemo("openreceive.price_currencies", "Loaded checkout and price feed currencies.", {
    checkoutCurrencies: supportedCurrencies,
    priceCurrencies,
  });

  const openreceive = await createOpenReceive({
    ...clientOptions,
    store,
    namespace: process.env.OPENRECEIVE_NAMESPACE ?? "hello_fruit",
    priceProviders,
    priceCurrencies,
    logger: createHelloFruitOpenReceiveLogger(DEMO_ID),
  });
  logDemo("openreceive.ready", "OpenReceive demo service is ready.", {
    priceProviderCount: priceProviders.length,
    checkoutCurrencyCount: supportedCurrencies.length,
  });
  return { openreceive, priceProviders, supportedCurrencies } satisfies HelloFruitOpenReceiveBundle;
}

export async function createHelloFruitStaticServer(options: HelloFruitOpenReceiveOptions = {}) {
  logDemo("server.create", "Creating static HTML demo server.");
  const app = express();
  app.use(express.json());
  app.use(
    "/stickers",
    express.static(fileURLToPath(new URL("../../../../shared/stickers/", import.meta.url))),
  );

  const { openreceive, priceProviders, supportedCurrencies } =
    await createHelloFruitOpenReceive(options);

  logDemo("server.routes", "Mounting demo routes.", {
    staticStickers: "/stickers",
    createOrder: "/create_order",
    orderStatus: "/order_status",
  });

  mountHelloFruitHostedDemoRoutes(app, {
    id: DEMO_ID,
    sourcePath: "examples/hello-fruit/server/static-html-small-api",
    docsPath: "docs/guides/quickstart-node.md",
    walletConfigured: true,
    defaultPort: "3001",
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
          "@openreceive/elements": "0.1.0",
        },
      }),
    );
  });

  app.post("/create_order", async (req, res, next) => {
    const startedAt = Date.now();
    try {
      const body = asRequestBody(req.body);
      logDemo("create_order.request", "Received create order request.", {
        ...summarizeOrderRequest(body),
        idempotencyKeyPresent:
          body.idempotency_key !== undefined || req.get("idempotency-key") !== undefined,
      });
      const rates = await readHelloFruitOrderRates({
        currency: body.currency,
        priceProviders,
        supportedCurrencies,
      });
      logDemo("create_order.rates", "Resolved order price rates.", {
        requestedCurrency: body.currency,
        rateCurrencies: rates === undefined ? [] : Object.keys(rates.bitcoin),
      });
      const orderResult = createHelloFruitCreateOrderResult(
        {
          ...body,
          idempotency_key: req.body?.idempotency_key ?? req.get("idempotency-key"),
        },
        {
          demoId: DEMO_ID,
          invoiceExpirySeconds: product.invoice_expiry_seconds,
          demoName: "static",
          rates,
          supportedCurrencies,
        },
      );
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
      const openreceiveOrder = await openreceive.getOrder(
        statusRequest,
      );
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
      .map((item) => typeof item === "object" && item !== null && !Array.isArray(item)
        ? (item as Record<string, unknown>).product_id
        : undefined)
      .filter((productId): productId is string => typeof productId === "string"),
  };
}

function summarizeSettlementFields(value: unknown): Record<string, unknown> {
  const order = typeof value === "object" && value !== null && !Array.isArray(value)
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
