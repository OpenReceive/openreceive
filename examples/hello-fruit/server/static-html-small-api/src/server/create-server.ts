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
  createOpenReceivePriceFeed,
  toOpenReceiveHttpOrder
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
  createHelloFruitOrderStatus
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

const DEMO_ID = "static-html-small-api";

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
  const store = options.store ?? await createHelloFruitOpenReceiveKvStore({
    demoId: DEMO_ID
  });
  const priceProviders: readonly OpenReceiveSourcedPriceProvider[] =
    options.priceProviders ??
    [createOpenReceivePriceFeed({ store, currencies: priceCurrencies })];

  const openreceive = await createOpenReceive({
    ...(options.client === undefined
      ? { nwc: readRequiredHelloFruitNwcConnectionString() }
      : { client: options.client }),
    store,
    namespace: process.env.OPENRECEIVE_NAMESPACE ?? "hello_fruit",
    priceProviders,
    priceCurrencies,
    logger: createHelloFruitOpenReceiveLogger(DEMO_ID)
  });
  return { openreceive, priceProviders, supportedCurrencies } satisfies HelloFruitOpenReceiveBundle;
}

export async function createHelloFruitStaticServer(
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
    sourcePath: "examples/hello-fruit/server/static-html-small-api",
    docsPath: "docs/guides/quickstart-node.md",
    walletConfigured: true,
    defaultPort: "3001"
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
        "@openreceive/elements": "0.1.0"
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
        demoName: "static",
        rates,
        supportedCurrencies
      });
      const checkout = toOpenReceiveHttpOrder(
        await openreceive.createOrder(orderResult.invoiceRequest)
      );
      res.status(201).json({
        order: orderResult.order,
        checkout
      });
    } catch (error) {
      next(error);
    }
  });
  app.post("/order_status", async (req, res, next) => {
    try {
      const checkout = toOpenReceiveHttpOrder(
        await openreceive.getOrder(createStatusRequest(asRequestBody(req.body)))
      );
      const orderStatus = createHelloFruitOrderStatus(checkout);
      res.status(200).json({
        ...checkout,
        ...orderStatus,
        order: {
          uuid: orderStatus.order_uuid,
          status: orderStatus.order_status
        }
      });
    } catch (error) {
      next(error);
    }
  });

  app.use(handleCheckoutError);

  return app;
}

function handleCheckoutError(
  error: unknown,
  _req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  if (error instanceof OpenReceiveServiceError) {
    res.status(error.status).json(error.body);
    return;
  }
  if (isAppHttpError(error)) {
    res.status(error.status).json(error.body);
    return;
  }
  next(error);
}

function isAppHttpError(error: unknown): error is {
  readonly status: number;
  readonly body: Record<string, unknown>;
} {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { readonly status?: unknown; readonly body?: unknown };
  return Number.isInteger(candidate.status) &&
    typeof candidate.status === "number" &&
    candidate.status >= 400 &&
    candidate.status <= 599 &&
    typeof candidate.body === "object" &&
    candidate.body !== null &&
    !Array.isArray(candidate.body);
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
    throw Object.assign(new Error("order_id is required."), {
      status: 400,
      body: {
        code: "INVALID_REQUEST",
        message: "order_id is required."
      }
    });
  }
  return { orderId };
}
