import express from "express";
import { fileURLToPath } from "node:url";
import {
  createDefaultLivePriceProviders
} from "@openreceive/core";
import {
  createAlbyNwcReceiveClient
} from "@openreceive/node";
import {
  mountOpenReceiveExpressRoutes,
  type OpenReceiveExpressOptions
} from "@openreceive/express";
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
  mountHelloFruitHostedDemoRoutes
} from "../../../../shared/hosted-demo-routes.ts";
import {
  createHelloFruitOpenReceiveKvStore
} from "../../../../shared/openreceive-store.ts";
import {
  readHelloFruitCatalogCurrencies
} from "../../../../shared/demo-catalog.ts";

const DEMO_ID = "static-html-small-api";

export function createHelloFruitOpenReceiveOptions(): OpenReceiveExpressOptions {
  const connectionString = readRequiredHelloFruitNwcConnectionString();
  const wallet = createAlbyNwcReceiveClient({
    connectionString
  });
  const priceCurrencies = readHelloFruitCatalogCurrencies();

  return {
    client: wallet,
    store: createHelloFruitOpenReceiveKvStore({
      demoId: DEMO_ID
    }),
    merchantScope: () => "demo:hello-fruit-static",
    priceProviders: createDefaultLivePriceProviders({ currencies: priceCurrencies }),
    priceCurrencies,
    unsafeAllowUnauthenticatedDemoMode: true,
    logger: createHelloFruitOpenReceiveLogger(DEMO_ID)
  };
}

export function createHelloFruitStaticServer() {
  const app = express();
  app.use(express.json());
  app.use(
    "/stickers",
    express.static(fileURLToPath(new URL("../../../../shared/stickers/", import.meta.url)))
  );

  const openreceive = createHelloFruitOpenReceiveOptions();

  mountHelloFruitHostedDemoRoutes(app, {
    id: DEMO_ID,
    sourcePath: "examples/hello-fruit/server/static-html-small-api",
    docsPath: "docs/01-quickstart-node.md",
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

  mountOpenReceiveExpressRoutes(app, openreceive);

  return app;
}
