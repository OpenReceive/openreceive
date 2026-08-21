/**
 * Host-app Express glue shared by the two Express-based Hello Fruit demos.
 * Everything here is host code — order routes, the delivery gate, the mounted
 * OpenReceive router, and the JSON error middleware. The demos differ only in
 * their demo id and their rate-limiting choice.
 */

import { fileURLToPath } from "node:url";
import { openReceiveExpress, sendHostRouteError } from "@openreceive/express";
import { createOpenReceiveHost, type OpenReceiveOrderSettlement } from "@openreceive/http";
import { createOpenReceive } from "@openreceive/node";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { openReceiveConfig } from "../../../config/openreceive.ts";
import { mountHelloFruitDelivery } from "./demo-delivery.ts";
import { createHelloFruitDemoServerLogger } from "./demo-logging.ts";
import { readRequiredHelloFruitNwcConnectionString } from "./demo-nwc.ts";
import { createHelloFruitCreateOrderResult } from "./demo-prepare-checkout.ts";
import {
  bootHelloFruitHostStore,
  createHelloFruitHostOrder,
  helloFruitHostDb,
  markHelloFruitOrderPaid,
  readHelloFruitHostOrder,
} from "./openreceive-store.ts";

const STICKERS_DIR = fileURLToPath(new URL("./stickers/", import.meta.url));

export interface CreateHelloFruitExpressAppOptions {
  readonly demoId: string;
  /**
   * Cap invoice creation per client IP, counted from the openreceive_payments
   * rows this host already persists. Off by default — leave it off for
   * point-of-sale deployments, where many payers share the terminal's IP.
   * Behind a reverse proxy, also set `app.set("trust proxy", 1)` so `req.ip` is
   * the payer, not the proxy (otherwise all payers share one budget).
   */
  readonly rateLimiting: boolean;
}

export async function createHelloFruitExpressApp(
  options: CreateHelloFruitExpressAppOptions,
): Promise<Express> {
  const demoId = options.demoId;
  const logDemo = createHelloFruitDemoServerLogger(demoId);
  await bootHelloFruitHostStore({ demoId, log: logDemo });

  const app = express();
  app.use(express.json());
  // Catalog thumbnails stay public; purchased downloads go through /delivery (onPaid gate).
  app.use("/stickers", express.static(STICKERS_DIR));

  // Same shape as docs/guides/quickstart-node.md:
  // onPaid runs inside the settlement transaction, only for the order's first settled attempt.
  // Boot refuses missing/invalid NWC; createOpenReceive then loads the NIP-47 info event.
  const nwc = readRequiredHelloFruitNwcConnectionString();
  const onPaid = async (settlement: OpenReceiveOrderSettlement) => {
    await markHelloFruitOrderPaid(settlement);
    logDemo("openreceive.on_paid", "Checkout settled — order fulfillment ran.", {
      paymentHash: settlement.paymentHash,
      orderId: settlement.orderId,
    });
  };
  const service = await createOpenReceive({
    ...openReceiveConfig,
    nwc,
  });
  logDemo("openreceive.ready", "OpenReceive service ready.", {
    priceCurrencies: service.priceCurrencies,
  });

  mountHelloFruitDelivery(app, {
    stickersDir: STICKERS_DIR,
  });
  const host = createOpenReceiveHost({
    db: helloFruitHostDb(),
    loadOrder: (orderId) => readHelloFruitHostOrder(orderId),
    amountForOrder: (order) => order.amount,
    onPaid,
  });

  // No background reconciler: any OpenReceive call (browser polls included)
  // runs the durably gated opportunistic reconcile, so restarts and payers who
  // close the page settle on the next call that wins the gate.
  const shutdown = async () => {
    await service.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  app.post("/orders", async (req, res, next) => {
    try {
      const result = await createHelloFruitCreateOrderResult(req.body, {
        demoId,
        openreceive: service,
      });
      createHelloFruitHostOrder(
        result.order,
        result.invoiceRequest.amount,
        result.invoiceRequest.memo,
      );
      res.status(201).json({ order_id: result.order.uuid, summary: result.order });
    } catch (error) {
      next(error);
    }
  });
  app.get("/orders/:orderId", (req, res) => {
    const stored = readHelloFruitHostOrder(String(req.params.orderId ?? ""));
    if (stored === null) return void res.status(404).json({ message: "Order not found." });
    res.status(200).json(stored.summary);
  });

  // Signed-in apps replace the default policy with their own session/ownership checks.
  const openreceive = openReceiveExpress({
    service,
    authorize: ({ resource }) =>
      resource.orderId !== undefined && readHelloFruitHostOrder(resource.orderId) !== null,
    host,
    rateLimiting: options.rateLimiting,
  });
  // The payer's checkout component only knows the order id; the invoice
  // description is host data. Inject the memo computed at order time into the
  // create bodies before the mounted router reads them (`checkout.create` and
  // `swap.create` both accept an optional `memo`).
  const injectOrderMemo = (req: Request, _res: Response, next: NextFunction): void => {
    injectHelloFruitOrderMemo(req.body);
    next();
  };
  app.post(`${openreceive.prefix}/checkouts`, injectOrderMemo);
  app.post(`${openreceive.prefix}/swaps`, injectOrderMemo);
  app.use(openreceive);

  app.get("/rates", async (_req, res, next) => {
    try {
      res.status(200).json({ rates: await service.listRates() });
    } catch (error) {
      next(error);
    }
  });

  // Host routes reject through `hostError`, so the browser's `response.json()`
  // must find a body. `sendHostRouteError` renders the same snake_case error
  // shape the mounted OpenReceive routes emit; anything else stays a 500.
  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (sendHostRouteError(res, error)) return;
    logDemo("host_route.error", "Unhandled host route error.", {
      error: error instanceof Error ? error.message : String(error),
    });
    if (res.headersSent) return void next(error);
    res.status(500).json({ code: "INTERNAL", message: "Internal error.", retryable: false });
  });

  return app;
}

/**
 * Adds the stored order memo to a parsed checkout/swap create body when the
 * payer did not send one, so minted invoices carry the order's description.
 */
function injectHelloFruitOrderMemo(body: unknown): void {
  if (typeof body !== "object" || body === null) return;
  const record = body as Record<string, unknown>;
  if (typeof record.order_id !== "string" || record.memo !== undefined) return;
  const memo = readHelloFruitHostOrder(record.order_id)?.memo;
  if (memo !== undefined) record.memo = memo;
}
