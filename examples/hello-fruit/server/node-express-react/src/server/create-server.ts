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

export function createHelloFruitServer() {
  const app = express();
  app.use(express.json());
  app.use(
    "/stickers",
    express.static(fileURLToPath(new URL("../../../../shared/stickers/", import.meta.url)))
  );

  const connectionString = process.env.OPENRECEIVE_NWC;
  if (connectionString === undefined || connectionString.length === 0) {
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
