import express from "express";
import { fileURLToPath } from "node:url";
import {
  InMemoryInvoiceStore
} from "@openreceive/core";
import {
  createAlbyNwcReceiveClient
} from "@openreceive/node";
import {
  mountOpenReceiveExpressRoutes
} from "@openreceive/express";
import {
  createHelloFruitDemoMetadata
} from "../../../../shared/demo-metadata.ts";
import {
  mountHelloFruitHostedDemoRoutes
} from "../../../../shared/hosted-demo-routes.ts";

export function createHelloFruitServer() {
  const app = express();
  app.use(express.json());
  app.use(
    "/stickers",
    express.static(fileURLToPath(new URL("../../../../shared/stickers/", import.meta.url)))
  );

  const connectionString = process.env.OPENRECEIVE_NWC;
  const walletConfigured = connectionString !== undefined && connectionString.length > 0;

  mountHelloFruitHostedDemoRoutes(app, {
    id: "node-express-react",
    sourcePath: "examples/hello-fruit/server/node-express-react",
    docsPath: "docs/01-quickstart-node.md",
    walletConfigured,
    defaultPort: "3000"
  });

  app.get("/demo-metadata.json", (_req, res) => {
    res.status(200).json(createHelloFruitDemoMetadata({
      id: "node-express-react",
      walletConfigured,
      requestedMode: process.env.OPENRECEIVE_DEMO_MODE,
      gitSha: process.env.OPENRECEIVE_GIT_SHA,
      imageDigest: process.env.OPENRECEIVE_IMAGE_DIGEST,
      deployedAt: process.env.OPENRECEIVE_DEPLOYED_AT,
      packages: {
        "@openreceive/browser": "0.1.0",
        "@openreceive/react": "0.1.0"
      }
    }));
  });

  if (!walletConfigured) {
    app.get("/openreceive/v1/health", (_req, res) => {
      res.status(200).json({
        ok: true,
        wallet_configured: false
      });
    });
    app.get("/openreceive/v1/capabilities", (_req, res) => {
      res.status(200).json({
        base_path: "/openreceive/v1",
        wallet_configured: false,
        transports: ["sse"],
        methods: ["make_invoice", "lookup_invoice"]
      });
    });
    app.use("/openreceive", (_req, res) => {
      res.status(503).json({
        code: "WALLET_UNAVAILABLE",
        message: "Set OPENRECEIVE_NWC before creating live invoices."
      });
    });
    return app;
  }

  const wallet = createAlbyNwcReceiveClient({
    connectionString
  });

  mountOpenReceiveExpressRoutes(app, {
    client: wallet,
    store: new InMemoryInvoiceStore(),
    merchantScope: () => "demo:hello-fruit",
    unsafeAllowUnauthenticatedDemoMode: true
  });

  return app;
}
