import { fileURLToPath } from "node:url";
import type {
  OpenReceiveInvoiceKvStore,
  OpenReceiveReceiveNwcClient,
  OpenReceiveSourcedPriceProvider,
} from "@openreceive/core";
import { openReceiveExpress } from "@openreceive/express";
import { guestCheckout } from "@openreceive/http";
import { createOpenReceive } from "@openreceive/node";
import express from "express";
import { readHelloFruitPriceFeedCurrencies } from "../../../../shared/demo-currencies.ts";
import {
  createHelloFruitDemoServerLogger,
  createHelloFruitOpenReceiveLogger,
} from "../../../../shared/demo-logging.ts";
import { createHelloFruitPrepareCheckout } from "../../../../shared/demo-prepare-checkout.ts";

const DEMO_ID = "node-express";
const logDemo = createHelloFruitDemoServerLogger(DEMO_ID);

/** Test-only overrides (fake wallet / in-memory store). Omit in real apps. */
export interface HelloFruitOpenReceiveOptions {
  readonly client?: OpenReceiveReceiveNwcClient;
  readonly store?: OpenReceiveInvoiceKvStore;
  readonly priceProviders?: readonly OpenReceiveSourcedPriceProvider[];
  readonly configPath?: string | false;
}

export async function createHelloFruitServer(options: HelloFruitOpenReceiveOptions = {}) {
  const app = express();
  app.use(express.json());
  app.use(
    "/stickers",
    express.static(fileURLToPath(new URL("../../../../shared/stickers/", import.meta.url))),
  );

  // Same shape as docs/guides/quickstart-node.md:
  // createOpenReceive({ onPaid }) + mount with prepareCheckout.
  // onPaid may fire more than once — dedupe on checkoutId in a real app.
  const service = await createOpenReceive({
    priceCurrencies: readHelloFruitPriceFeedCurrencies(),
    logger: createHelloFruitOpenReceiveLogger(DEMO_ID),
    onPaid: async ({ orderId, checkoutId }) => {
      logDemo("openreceive.on_paid", "Checkout settled — fulfill your order here.", {
        orderId,
        checkoutId,
      });
    },
    ...options,
  });

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
