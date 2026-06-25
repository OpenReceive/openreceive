import express from "express";
import { fileURLToPath } from "node:url";
import {
  createDefaultLivePriceProviders
} from "@openreceive/core";
import {
  createOpenReceive,
  type OpenReceiveServer
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
  mountHelloFruitHostedDemoRoutes
} from "../../../../shared/hosted-demo-routes.ts";
import {
  createHelloFruitOpenReceiveKvStore
} from "../../../../shared/openreceive-store.ts";
import {
  readHelloFruitCatalogCurrencies
} from "../../../../shared/demo-catalog.ts";

const DEMO_ID = "static-html-small-api";

export async function createHelloFruitOpenReceive(): Promise<OpenReceiveServer> {
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
    priceProviders: createDefaultLivePriceProviders({ currencies: priceCurrencies }),
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

  const or = openreceive.handlers;
  app.post("/openreceive/v1/invoices", or.createInvoice);
  app.get("/openreceive/v1/invoices/:invoice_id", or.getInvoice);
  app.post("/openreceive/v1/invoices/lookup", or.lookupInvoice);
  app.post("/openreceive/v1/invoices/:invoice_id/refresh", or.refreshInvoice);
  app.get("/openreceive/v1/rates", or.listRates);
  app.post("/openreceive/v1/rates/quote", or.quoteRates);
  app.get("/openreceive/v1/routes", or.listRoutes);
  app.get("/openreceive/v1/providers", or.listProviders);
  app.get("/openreceive/v1/health", or.health);
  app.get("/openreceive/v1/capabilities", or.capabilities);

  return app;
}
