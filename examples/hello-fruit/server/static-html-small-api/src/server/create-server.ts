import { fileURLToPath } from "node:url";
import { openReceiveExpress } from "@openreceive/express";
import { guestCheckout } from "@openreceive/http";
import { createOpenReceive } from "@openreceive/node";
import express from "express";
import { mountHelloFruitDelivery } from "../../../../shared/demo-delivery.ts";
import { fulfillHelloFruitOrder } from "../../../../shared/demo-fulfillment.ts";
import {
  createHelloFruitDemoServerLogger,
  createHelloFruitOpenReceiveLogger,
} from "../../../../shared/demo-logging.ts";
import { createHelloFruitPrepareCheckout } from "../../../../shared/demo-prepare-checkout.ts";

const DEMO_ID = "static-html-small-api";
const logDemo = createHelloFruitDemoServerLogger(DEMO_ID);
const STICKERS_DIR = fileURLToPath(new URL("../../../../shared/stickers/", import.meta.url));

export async function createHelloFruitStaticServer() {
  const app = express();
  app.use(express.json());
  // Catalog thumbnails stay public; purchased downloads go through /delivery (onPaid gate).
  app.use("/stickers", express.static(STICKERS_DIR));

  // Same shape as docs/guides/quickstart-node.md:
  // createOpenReceive({ onPaid }) + mount with prepareCheckout.
  // onPaid may fire more than once — fulfillHelloFruitOrder dedupes on checkoutId.
  // NWC + price currencies come from openreceive.yml (defaults: local-sqlite, USD).
  let service: Awaited<ReturnType<typeof createOpenReceive>>;
  service = await createOpenReceive({
    logger: createHelloFruitOpenReceiveLogger(DEMO_ID),
    onPaid: async ({ orderId, checkoutId }) => {
      const result = await fulfillHelloFruitOrder({
        store: service.store,
        orderId,
        checkoutId,
      });
      logDemo("openreceive.on_paid", "Checkout settled — order fulfillment ran.", {
        orderId,
        checkoutId,
        fulfilled: result.fulfilled,
        ...(result.fulfilled ? {} : { reason: result.reason }),
      });
    },
  });

  mountHelloFruitDelivery(app, { store: service.store, stickersDir: STICKERS_DIR });

  // guestCheckout(): anonymous create, Tier-2 reads gated by the per-order capability token.
  // For a signed-in app, swap authorize for withUser instead, e.g.:
  //   import { withUser } from "@openreceive/http";
  //   authorize: withUser((request) => currentUserFromMySession(request), {
  //     ownsOrder: (user, ctx) => orderBelongsTo(user, ctx.resource.order_id),
  //     isAdmin: (user) => user.admin,
  //   }),
  app.use(
    openReceiveExpress({
      service,
      authorize: guestCheckout(),
      prepareCheckout: createHelloFruitPrepareCheckout({ demoId: DEMO_ID, openreceive: service }),
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
