import express from "express";
import { fileURLToPath } from "node:url";
import type {
  OpenReceiveInvoiceKvStore,
  OpenReceiveReceiveNwcClient,
  OpenReceiveSourcedPriceProvider,
} from "@openreceive/core";
import { openReceiveExpress } from "@openreceive/express";
import { guestCheckout } from "@openreceive/http";
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
  HelloFruitDemoOrderError,
  prepareHelloFruitOrder,
  getHelloFruitCheckoutAmount,
  getHelloFruitDemoOrder,
} from "../../../../shared/demo-order.ts";
import { mountHelloFruitHostedDemoRoutes } from "../../../../shared/hosted-demo-routes.ts";
import {
  readHelloFruitCheckoutCurrencies,
  readHelloFruitPriceFeedCurrencies,
} from "../../../../shared/demo-currencies.ts";

const DEMO_ID = "static-html-small-api";
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

  // Quickstart shape: createOpenReceive({ onPaid }) + mount with getCheckoutAmount.
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

export async function createHelloFruitStaticServer(options: HelloFruitOpenReceiveOptions = {}) {
  logDemo("server.create", "Creating static HTML demo server.");
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
      getCheckoutAmount: ({ orderId }) => getHelloFruitCheckoutAmount(openreceive, orderId),
    }),
  );

  logDemo("server.routes", "Mounting demo routes.", {
    staticStickers: "/stickers",
    openReceiveRouter: "/openreceive",
    prepareOrder: "/prepare_order",
    orders: "/orders/:orderId",
    rates: "/rates",
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

  // App order step (NOT an OpenReceive route): validate the cart, compute the authoritative total,
  // and PERSIST the order. The mounted /openreceive/checkouts route creates the checkout; the
  // <openreceive-checkout order-id> element drives it.
  app.post("/prepare_order", async (req, res, next) => {
    const startedAt = Date.now();
    try {
      const body = asRequestBody(req.body);
      logDemo("prepare_order.request", "Received prepare order request.", {
        ...summarizeOrderRequest(body),
      });
      const { order } = await prepareHelloFruitOrder(body, {
        demoId: DEMO_ID,
        demoName: "static",
        openreceive,
      });
      logDemo("prepare_order.prepared", "Prepared and persisted demo order.", {
        orderId: order.uuid,
        orderStatus: order.status,
        total: order.total_amount,
        itemCount: order.items.length,
        elapsedMs: Date.now() - startedAt,
      });
      res.status(201).json({ order });
    } catch (error) {
      if (error instanceof OpenReceiveServiceError || error instanceof HelloFruitDemoOrderError) {
        logDemo("prepare_order.rejected", "Prepare order request returned a known error.", {
          status: error.status,
          body: error.body,
          elapsedMs: Date.now() - startedAt,
        });
        res.status(error.status).json(error.body);
        return;
      }
      logDemo("prepare_order.error", "Prepare order request failed unexpectedly.", {
        error: error instanceof Error ? error.message : String(error),
        elapsedMs: Date.now() - startedAt,
      });
      next(error);
    }
  });

  // Guest resume: public order summary for `/checkout/:orderId` when sessionStorage is empty.
  app.get("/orders/:orderId", async (req, res, next) => {
    const startedAt = Date.now();
    const orderId = typeof req.params.orderId === "string" ? req.params.orderId : "";
    try {
      const order = orderId.length === 0 ? null : await getHelloFruitDemoOrder(openreceive, orderId);
      if (order === null) {
        logDemo("orders.not_found", "Order summary lookup missed.", {
          orderId,
          elapsedMs: Date.now() - startedAt,
        });
        res.status(404).json({
          code: "NOT_FOUND",
          message: "Order not found.",
          retryable: false,
        });
        return;
      }
      logDemo("orders.response", "Served order summary for checkout resume.", {
        orderId: order.uuid,
        orderStatus: order.status,
        itemCount: order.items.length,
        elapsedMs: Date.now() - startedAt,
      });
      res.status(200).json({ order });
    } catch (error) {
      logDemo("orders.error", "Order summary lookup failed.", {
        orderId,
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

function asRequestBody(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
