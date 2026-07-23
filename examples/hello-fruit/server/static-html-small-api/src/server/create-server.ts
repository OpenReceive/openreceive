import { fileURLToPath } from "node:url";
import { openReceiveExpress } from "@openreceive/express";
import { createDefaultAuthorize, hostError } from "@openreceive/http";
import { createOpenReceive } from "@openreceive/node";
import express from "express";
import { mountHelloFruitDelivery } from "../../../../shared/demo-delivery.ts";
import { fulfillHelloFruitOrder } from "../../../../shared/demo-fulfillment.ts";
import {
  createHelloFruitDemoServerLogger,
  createHelloFruitOpenReceiveLogger,
} from "../../../../shared/demo-logging.ts";
import { createHelloFruitCreateOrderResult } from "../../../../shared/demo-prepare-checkout.ts";
import {
  commitHelloFruitCheckout,
  createHelloFruitHostOrder,
  readHelloFruitHostOrder,
  resolveHelloFruitHostCheckout,
} from "../../../../shared/openreceive-store.ts";

const DEMO_ID = "static-html-small-api";
const logDemo = createHelloFruitDemoServerLogger(DEMO_ID);
const STICKERS_DIR = fileURLToPath(new URL("../../../../shared/stickers/", import.meta.url));

export async function createHelloFruitStaticServer() {
  const app = express();
  app.use(express.json());
  // Catalog thumbnails stay public; purchased downloads go through /delivery (onPaid gate).
  app.use("/stickers", express.static(STICKERS_DIR));

  // Same shape as docs/guides/quickstart-node.md:
  // onPaid may fire more than once; the host order's paid_at transition is write-once.
  let service: Awaited<ReturnType<typeof createOpenReceive>>;
  service = await createOpenReceive({
    logger: createHelloFruitOpenReceiveLogger(DEMO_ID),
    onPaid: async ({ paymentHash, paidAt }) => {
      const result = await fulfillHelloFruitOrder({
        paymentHash,
        paidAt,
      });
      logDemo("openreceive.on_paid", "Checkout settled — order fulfillment ran.", {
        paymentHash,
        orderId: result.orderId,
        fulfilled: result.fulfilled,
      });
    },
  });

  mountHelloFruitDelivery(app, {
    verifyCapabilityToken: service.verifyCapabilityToken,
    stickersDir: STICKERS_DIR,
  });

  app.post("/orders", async (req, res, next) => {
    try {
      const result = await createHelloFruitCreateOrderResult(req.body, {
        demoId: DEMO_ID,
        openreceive: service,
      });
      createHelloFruitHostOrder(result.order, result.invoiceRequest.amount);
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
  app.use(
    openReceiveExpress({
      service,
      authorize: createDefaultAuthorize(),
      resolveCheckoutAmount: ({ orderId }) => {
        const order = resolveHelloFruitHostCheckout(orderId);
        if (order === null) throw hostError("Order not found.", 404, "NOT_FOUND");
        return order;
      },
      onCheckoutCreated: commitHelloFruitCheckout,
    }),
  );

  app.get("/rates", async (_req, res, next) => {
    try {
      res.status(200).json({ rates: await service.listRates() });
    } catch (error) {
      next(error);
    }
  });

  return app;
}
