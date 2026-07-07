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
  createHelloFruitOrderStatus,
  HelloFruitDemoOrderError,
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

export async function createHelloFruitStaticServer(options: HelloFruitOpenReceiveOptions = {}) {
  logDemo("server.create", "Creating static HTML demo server.");
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
    swapOptions: "/swap_options",
    swapQuote: "/swap_quote",
    swapStart: "/swap_start",
    swapRefund: "/swap_refund",
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

  app.post("/create_order", async (req, res, next) => {
    const startedAt = Date.now();
    try {
      const body = asRequestBody(req.body);
      logDemo("create_order.request", "Received create order request.", {
        ...summarizeOrderRequest(body),
      });
      const orderResult = await createHelloFruitCreateOrderResult(body, {
        demoId: DEMO_ID,
        demoName: "static",
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
      await authorizeOrderAccess(req, statusRequest.orderId);
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

  app.post("/swap_options", async (req, res, next) => {
    const startedAt = Date.now();
    try {
      const body = asRequestBody(req.body);
      const orderId = requireRequestString(body, "order_id");
      await authorizeOrderAccess(req, orderId);
      const result = await openreceive.swapOptions({
        orderId,
      });
      logDemo("swap_options.response", "Served automated swap options.", {
        orderId,
        enabled: result.enabled,
        optionCount: result.options.length,
        elapsedMs: Date.now() - startedAt,
      });
      res.status(200).json(result);
    } catch (error) {
      if (error instanceof OpenReceiveServiceError || error instanceof HelloFruitDemoOrderError) {
        res.status(error.status).json(error.body);
        return;
      }
      next(error);
    }
  });

  app.post("/swap_quote", async (req, res, next) => {
    const startedAt = Date.now();
    try {
      const body = asRequestBody(req.body);
      const orderId = requireRequestString(body, "order_id");
      const payInAsset = requireRequestString(body, "pay_in_asset");
      await authorizeOrderAccess(req, orderId);
      const quote = await openreceive.swapQuote({
        orderId,
        payInAsset,
      });
      logDemo("swap_quote.response", "Served automated swap quote.", {
        orderId,
        payInAsset,
        provider: quote.provider,
        available: quote.available,
        elapsedMs: Date.now() - startedAt,
      });
      res.status(200).json({ quote });
    } catch (error) {
      if (error instanceof OpenReceiveServiceError || error instanceof HelloFruitDemoOrderError) {
        res.status(error.status).json(error.body);
        return;
      }
      next(error);
    }
  });

  app.post("/swap_start", async (req, res, next) => {
    const startedAt = Date.now();
    try {
      const body = asRequestBody(req.body);
      const orderId = requireRequestString(body, "order_id");
      const payInAsset = requireRequestString(body, "pay_in_asset");
      await authorizeOrderAccess(req, orderId);
      const invoice = await openreceive.startSwap({
        orderId,
        payInAsset,
      });
      logDemo("swap_start.response", "Started automated swap.", {
        orderId,
        payInAsset,
        invoiceId: invoice.invoice_id,
        provider: invoice.swap?.provider,
        elapsedMs: Date.now() - startedAt,
      });
      res.status(201).json({ invoice });
    } catch (error) {
      if (error instanceof OpenReceiveServiceError || error instanceof HelloFruitDemoOrderError) {
        res.status(error.status).json(error.body);
        return;
      }
      next(error);
    }
  });

  app.post("/swap_refund", async (req, res, next) => {
    const startedAt = Date.now();
    try {
      const body = asRequestBody(req.body);
      const orderId = requireRequestString(body, "order_id");
      const attemptId = requireRequestString(body, "attempt_id");
      const refundAddress = requireRequestString(body, "refund_address");
      const refundNonce = requireRequestString(body, "refund_nonce");
      await authorizeOrderAccess(req, orderId);
      const invoice = await openreceive.refundSwap({
        attemptId,
        refundAddress,
        refundNonce,
        confirm: body.confirm === true,
      });
      logDemo("swap_refund.response", "Requested automated swap refund.", {
        attemptId,
        invoiceId: invoice.invoice_id,
        provider: invoice.swap?.provider,
        elapsedMs: Date.now() - startedAt,
      });
      res.status(200).json({ invoice });
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

async function authorizeOrderAccess(_req: express.Request, _orderId: string): Promise<void> {
  // Demo seam: production apps should verify the signed-in/session caller owns
  // this order before proxying OpenReceive order, swap, or refund methods.
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

function requireRequestString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new HelloFruitDemoOrderError(`${key} is required.`);
  }
  return value;
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
