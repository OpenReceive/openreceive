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

export function createHelloFruitStaticServer() {
  const app = express();
  app.use(express.json());
  app.use(
    "/stickers",
    express.static(fileURLToPath(new URL("../../../../shared/stickers/", import.meta.url)))
  );

  const connectionString = process.env.OPENRECEIVE_NWC;
  if (connectionString === undefined || connectionString.length === 0) {
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
    merchantScope: () => "demo:hello-fruit-static",
    unsafeAllowUnauthenticatedDemoMode: true
  });

  return app;
}
