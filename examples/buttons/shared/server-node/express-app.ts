/**
 * The shop as an Express app: the Buy a Button host, shared by node-express
 * and static-html-small-api.
 *
 * Everything here is HOST code — the five shop routes, the artwork mount, the
 * mounted OpenReceive router, and the JSON error middleware. The two demos
 * differ only in their demo id, their rate-limiting choice, and the client they
 * serve.
 */

import { StaticPriceProvider } from "@openreceive/core";
import { openReceiveExpress, sendHostRouteError } from "@openreceive/express";
import { createHost } from "@openreceive/http";
import { createOpenReceive, type OpenReceive } from "@openreceive/node";
import { createTestkitReceiveClient, createTestkitSwapProvider } from "@openreceive/testkit";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { resolveCookieSecret } from "./cookie.ts";
import { createShopServerLogger } from "./logging.ts";
import { readRequiredShopNwcConnectionString, shopWalletMode } from "./nwc.ts";
import {
  bootstrap,
  createOrder,
  download,
  recentOrders,
  type ShopContext,
  type ShopRequest,
  type ShopResult,
  shopArtworkDir,
  SHOP_IMAGES_PREFIX,
  showOrder,
} from "./shop-routes.ts";
import {
  config,
  createShopAmountFor,
  createShopAuthorize,
  createShopOnPaid,
} from "./openreceive-config.ts";
import { openShopStore, type ShopStore } from "./store.ts";
import { mountShopTestkitControls, type ShopTestkitFixtures } from "./testkit-controls.ts";

export interface CreateShopExpressAppOptions {
  readonly demoId: string;
  /**
   * Cap invoice creation per client IP, counted from the engine-owned
   * openreceive_payments rows. On for the public web shop; behind a reverse
   * proxy also set `app.set("trust proxy", 1)` so `req.ip` is the payer.
   */
  readonly rateLimiting: boolean;
}

export interface ShopExpressApp {
  readonly app: Express;
  readonly store: ShopStore;
}

/** One handler shape for all five routes, so the adapter is written once. */
type ShopHandler = (request: ShopRequest, context: ShopContext) => ShopResult;

const shopRequest = (req: Request): ShopRequest => ({
  cookieHeader: req.headers.cookie,
  body: req.body,
  params: req.params as Record<string, string | undefined>,
  // Decides the identity cookie's Secure flag. A cookie marked secure is
  // dropped by the browser on plain HTTP, so this follows THE REQUEST rather
  // than an environment name — the production-mode demo is served over
  // http://localhost and would otherwise mint a fresh visitor every request.
  secure: req.secure,
});

const send = (res: Response, result: ShopResult): void => {
  if (result.setCookie !== undefined) res.append("Set-Cookie", result.setCookie);
  for (const [name, value] of Object.entries(result.headers ?? {})) res.setHeader(name, value);

  if (result.file !== undefined) {
    res.status(result.status).type(result.file.contentType);
    res.download(result.file.path, result.file.filename);
    return;
  }
  res.status(result.status).json(result.json ?? null);
};

const mount =
  (handler: ShopHandler, context: ShopContext) =>
  (req: Request, res: Response, next: NextFunction): void => {
    try {
      send(res, handler(shopRequest(req), context));
    } catch (error) {
      next(error);
    }
  };

export async function createShopExpressApp(
  options: CreateShopExpressAppOptions,
): Promise<ShopExpressApp> {
  const demoId = options.demoId;
  const log = createShopServerLogger(demoId);

  // The store MIGRATES and does not wipe: orders, users and products survive a
  // restart, which is the whole subject of this demo.
  const store = openShopStore({ demoId, log });
  const secret = resolveCookieSecret(store.dir, demoId);

  const app = express();
  app.use(express.json());

  // Catalog thumbnails are public. The DOWNLOAD is not, and deliberately does
  // not go through this mount — it is gated on the paid order row.
  app.use(SHOP_IMAGES_PREFIX, express.static(shopArtworkDir));

  // DEMO_WALLET=testkit swaps ONLY the wallet, the swap provider and the price
  // feed for the in-memory fakes (the E2E harness — no NWC_URI, no network).
  // Every other code path — store, routes, hooks, production wiring — is
  // identical.
  let service: OpenReceive;
  let testkit: ShopTestkitFixtures | undefined;
  if (shopWalletMode() === "testkit") {
    testkit = { client: createTestkitReceiveClient(), swap: createTestkitSwapProvider() };
    service = await createOpenReceive({
      ...config,
      client: testkit.client,
      priceProviders: [new StaticPriceProvider()],
      swap: { provider: testkit.swap },
    });
    log("openreceive.testkit", "Testkit wallet mode: in-memory fakes, no NWC connection.", {
      controlPrefix: "/__testkit",
    });
  } else {
    // Boot refuses a missing or invalid NWC before any route is served.
    service = await createOpenReceive({ ...config, nwc: readRequiredShopNwcConnectionString() });
  }
  log("openreceive.ready", "OpenReceive service ready.", {
    priceCurrencies: service.priceCurrencies,
  });

  // Live routes in testkit mode, a hard 404 on the whole prefix otherwise.
  mountShopTestkitControls(app, testkit);

  // The engine owns its two tables inside the shop's own database — never a
  // second one. `amountFor` and `onPaid` are two of the three hooks; the third,
  // `authorize`, is on the middleware below.
  const host = createHost({
    db: store.db,
    amountFor: createShopAmountFor(store),
    onPaid: createShopOnPaid(log),
  });

  const openreceive = openReceiveExpress({
    service,
    host,
    authorize: createShopAuthorize(store, secret),
    rateLimiting: options.rateLimiting,
  });
  app.use(openreceive);

  const context: ShopContext = { store, secret, openreceivePrefix: openreceive.prefix };

  // The shop's own JSON API. OpenReceive owns none of it.
  app.get("/shop/bootstrap", mount(bootstrap, context));
  app.post("/shop/orders", mount(createOrder, context));
  app.get("/shop/recent_orders", mount(recentOrders, context));
  app.get("/shop/orders/:reference", mount(showOrder, context));
  app.get("/shop/orders/:reference/downloads/:sku", mount(download, context));

  // No background reconciler: any OpenReceive call (the browser's polls
  // included) runs the durably gated opportunistic reconcile, so a restart and
  // a payer who closed the page both settle on the next call that wins the gate.
  const shutdown = async () => {
    await service.close();
    store.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  // Host routes reject through `hostError`, so the browser's `response.json()`
  // must find a body. `sendHostRouteError` renders the same snake_case shape
  // the mounted OpenReceive routes emit; anything else stays a 500.
  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (sendHostRouteError(res, error)) return;
    log("host_route.error", "Unhandled host route error.", {
      error: error instanceof Error ? error.message : String(error),
    });
    if (res.headersSent) return void next(error);
    res.status(500).json({ code: "INTERNAL", message: "Internal error.", retryable: false });
  });

  return { app, store };
}
