import express from "express";
import { fileURLToPath } from "node:url";
import {
  createDefaultPriceProviders,
  createDefaultLivePriceProviders
} from "@openreceive/core";
import type {
  OpenReceiveSourcedPriceProvider
} from "@openreceive/core";
import {
  createOpenReceive
} from "@openreceive/node";
import {
  createHelloFruitDemoMetadata
} from "../../../../shared/demo-metadata.ts";
import {
  createHelloFruitTestReceiveClient,
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
import product from "../../../../shared/product.json";

const DEMO_ID = "node-express";

interface HelloFruitOpenReceiveBundle {
  readonly openreceive: Awaited<ReturnType<typeof createOpenReceive>>;
  readonly priceProviders: readonly OpenReceiveSourcedPriceProvider[];
  readonly supportedCurrencies: readonly string[];
}

export async function createHelloFruitOpenReceive() {
  const priceCurrencies = readHelloFruitPriceFeedCurrencies();
  const supportedCurrencies = readHelloFruitCheckoutCurrencies();
  const store = await createHelloFruitOpenReceiveKvStore({
    demoId: DEMO_ID
  });
  const testClient = createHelloFruitTestReceiveClient();
  const priceProviders = testClient === undefined
    ? createDefaultLivePriceProviders({ currencies: priceCurrencies })
    : createDefaultPriceProviders({ currencies: priceCurrencies });

  const openreceive = await createOpenReceive({
    ...(testClient === undefined
      ? { nwc: readRequiredHelloFruitNwcConnectionString() }
      : { client: testClient }),
    store,
    namespace: process.env.OPENRECEIVE_NAMESPACE ?? "hello_fruit",
    priceProviders,
    priceCurrencies,
    logger: createHelloFruitOpenReceiveLogger(DEMO_ID)
  });
  return { openreceive, priceProviders, supportedCurrencies } satisfies HelloFruitOpenReceiveBundle;
}

export async function createHelloFruitServer() {
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
  } = await createHelloFruitOpenReceive();

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
      const invoice = await openreceive.createInvoice(orderResult.invoiceRequest);
      res.status(201).json({
        order: orderResult.order,
        invoice
      });
    } catch (error) {
      next(error);
    }
  });
  app.post("/order_status", async (req, res, next) => {
    try {
      const lookup = await openreceive.lookupInvoice(req.body);
      const orderStatus = createHelloFruitOrderStatus(lookup);
      res.status(200).json({
        ...lookup,
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
  if (isCheckoutHttpError(error)) {
    res.status(error.status).json(error.body);
    return;
  }
  next(error);
}

function isCheckoutHttpError(error: unknown): error is {
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
