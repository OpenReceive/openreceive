import express from "express";
import { fileURLToPath } from "node:url";
import {
  createDefaultPriceProviders,
  createDefaultLivePriceProviders
} from "@openreceive/core";
import {
  createOpenReceive,
  OpenReceiveServiceError,
  type OpenReceive
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
  HelloFruitDemoOrderError,
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
  readHelloFruitCatalogCurrencies
} from "../../../../shared/demo-catalog.ts";
import product from "../../../../shared/product.json";

const DEMO_ID = "static-html-small-api";

export async function createHelloFruitOpenReceive(): Promise<OpenReceive> {
  const priceCurrencies = readHelloFruitCatalogCurrencies();
  const store = await createHelloFruitOpenReceiveKvStore({
    demoId: DEMO_ID
  });
  const testClient = createHelloFruitTestReceiveClient();

  return await createOpenReceive({
    ...(testClient === undefined
      ? { nwc: readRequiredHelloFruitNwcConnectionString() }
      : { client: testClient }),
    store,
    namespace: process.env.OPENRECEIVE_NAMESPACE ?? "hello_fruit",
    priceProviders: testClient === undefined
      ? createDefaultLivePriceProviders({ currencies: priceCurrencies })
      : createDefaultPriceProviders({ currencies: priceCurrencies }),
    priceCurrencies,
    logger: createHelloFruitOpenReceiveLogger(DEMO_ID)
  });
}

export async function createHelloFruitStaticServer() {
  const app = express();
  app.use(express.json());
  app.use(
    "/stickers",
    express.static(fileURLToPath(new URL("../../../../shared/stickers/", import.meta.url)))
  );

  const openreceive = await createHelloFruitOpenReceive();

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
      const orderResult = createHelloFruitCreateOrderResult({
        ...asRequestBody(req.body),
        idempotency_key: req.body?.idempotency_key ?? req.get("idempotency-key")
      }, {
        demoId: DEMO_ID,
        invoiceExpirySeconds: product.invoice_expiry_seconds,
        demoName: "static"
      });
      const invoice = await openreceive.createInvoice(orderResult.invoice_request);
      res.status(201).json({
        order: orderResult.order,
        invoice
      });
    } catch (error) {
      sendOpenReceiveError(res, next, error);
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
      sendOpenReceiveError(res, next, error);
    }
  });

  return app;
}

function sendOpenReceiveError(
  res: express.Response,
  next: express.NextFunction,
  error: unknown
): void {
  if (error instanceof HelloFruitDemoOrderError) {
    res.status(error.status).json(error.body);
    return;
  }
  if (error instanceof OpenReceiveServiceError) {
    res.status(error.status).json(error.body);
    return;
  }
  next(error);
}

function asRequestBody(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
