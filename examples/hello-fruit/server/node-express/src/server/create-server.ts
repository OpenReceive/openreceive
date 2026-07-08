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
  readOpenReceiveConfigFile,
} from "@openreceive/node";
import { createHelloFruitDemoMetadata } from "../../../../shared/demo-metadata.ts";
import {
  createHelloFruitDemoServerLogger,
  createHelloFruitOpenReceiveLogger,
} from "../../../../shared/demo-logging.ts";
import {
  createHelloFruitCreateOrderResult,
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
    checkoutCurrencies: supportedCurrencies,
    priceCurrencies,
  });

  const openreceive = await createOpenReceive({
    ...(options.client === undefined ? {} : { client: options.client }),
    ...(options.store === undefined ? {} : { store: options.store }),
    ...(options.priceProviders === undefined ? {} : { priceProviders: options.priceProviders }),
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    namespace: config?.namespace ?? "hello_fruit",
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
    order: "/order",
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
  app.post("/order", async (req, res, next) => {
    const startedAt = Date.now();
    try {
      const body = asRequestBody(req.body);
      const orderId = requireRequestString(body, "order_id");
      logDemo("order.request", "Received order request.", {
        orderId,
        action: typeof body.action === "string" ? body.action : "status",
      });
      await authorizeOrderAccess(req, orderId);
      const result = await openreceive.order(body as Parameters<typeof openreceive.order>[0]);
      logDemo("order.response", "Served order request.", {
        orderId,
        elapsedMs: Date.now() - startedAt,
      });
      res.status(200).json(result);
    } catch (error) {
      if (error instanceof OpenReceiveServiceError || error instanceof HelloFruitDemoOrderError) {
        logDemo("order.rejected", "Order request returned a known error.", {
          status: error.status,
          body: error.body,
          elapsedMs: Date.now() - startedAt,
        });
        res.status(error.status).json(error.body);
        return;
      }
      logDemo("order.error", "Order request failed unexpectedly.", {
        error: error instanceof Error ? error.message : String(error),
        elapsedMs: Date.now() - startedAt,
      });
      next(error);
    }
  });

  return app;
}

async function authorizeOrderAccess(_req: express.Request, _orderId: string): Promise<void> {
  // Demo seam: production apps should verify the signed-in/session caller owns
  // this order before forwarding the request to openreceive.order(body).
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

function asRequestBody(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requireRequestString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new HelloFruitDemoOrderError(`${key} is required.`);
  }
  return value;
}

