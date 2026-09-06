/**
 * The shop as a Fastify app: the Buy a Button host for the fastify stack.
 *
 * The Fastify twin of express-app.ts. Everything here is HOST code — the five
 * shop routes, the artwork mount, the registered OpenReceive plugin, and the
 * JSON error handler. The shop's behaviour is the framework-free handlers in
 * shop-routes.ts; this file only translates a Fastify request into a
 * ShopRequest and a ShopResult back into a reply.
 *
 * What is Fastify-specific, and therefore worth reading:
 *
 * - `Fastify({ trustProxy: true })` is the Fastify spelling of Express's
 *   `app.set("trust proxy", 1)`: behind a reverse proxy `request.ip` and
 *   `request.protocol` follow the forwarded headers, so the per-IP invoice cap
 *   counts the payer rather than the proxy, and the identity cookie's Secure
 *   flag follows the original scheme.
 * - `fastify.register(openReceiveFastify, { prefix: "/openreceive", … })`:
 *   the prefix is passed AT REGISTER TIME so Fastify scopes the plugin's
 *   catch-all route to it. There is no `app.use(router)` and no body parser to
 *   add — Fastify parses JSON itself.
 * - `setErrorHandler` plays the role of the Express error middleware:
 *   `sendHostRouteError` renders a host-route refusal in the same snake_case
 *   shape the mounted OpenReceive routes emit; anything else stays a 500.
 */

import { createReadStream } from "node:fs";
import fastifyStatic from "@fastify/static";
import { openReceiveFastify, sendHostRouteError } from "@openreceive/fastify";
import { createHost } from "@openreceive/http";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { resolveCookieSecret } from "./cookie.ts";
import { createShopServerLogger } from "./logging.ts";
import {
  createShopAmountFor,
  createShopAuthorize,
  createShopOnPaid,
} from "./openreceive-config.ts";
import { createShopService } from "./service.ts";
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
import { openShopStore, type ShopStore } from "./store.ts";
import { mountShopTestkitControlsFastify } from "./testkit-controls.ts";

export interface CreateShopFastifyAppOptions {
  readonly demoId: string;
  /**
   * Cap invoice creation per client IP, counted from the engine-owned
   * openreceive_payments rows. On for the public web shop; `trustProxy` on
   * the instance is what makes `request.ip` the payer behind a proxy.
   */
  readonly rateLimiting: boolean;
}

export interface ShopFastifyApp {
  readonly app: FastifyInstance;
  readonly store: ShopStore;
}

/** Where the OpenReceive routes are registered. The bootstrap payload carries it to the SPA. */
export const SHOP_OPENRECEIVE_PREFIX = "/openreceive";

/**
 * The paths this host answers. Vite's dev server hands only these to Fastify
 * (see the fastify stack's vite.config.ts); everything else is the SPA.
 */
export const SHOP_FASTIFY_API_PREFIXES = [
  "/shop",
  SHOP_OPENRECEIVE_PREFIX,
  SHOP_IMAGES_PREFIX,
  "/__testkit",
] as const;

/** One handler shape for all five routes, so the adapter is written once. */
type ShopHandler = (request: ShopRequest, context: ShopContext) => ShopResult;

const shopRequest = (request: FastifyRequest): ShopRequest => ({
  cookieHeader: request.headers.cookie,
  body: request.body,
  params: request.params as Record<string, string | undefined>,
  // Decides the identity cookie's Secure flag. A cookie marked secure is
  // dropped by the browser on plain HTTP, so this follows THE REQUEST rather
  // than an environment name — `trustProxy` makes it the original scheme.
  secure: request.protocol === "https",
});

const send = (reply: FastifyReply, result: ShopResult): unknown => {
  if (result.setCookie !== undefined) reply.header("Set-Cookie", result.setCookie);
  for (const [name, value] of Object.entries(result.headers ?? {})) reply.header(name, value);

  if (result.file !== undefined) {
    return reply
      .code(result.status)
      .type(result.file.contentType)
      .header("Content-Disposition", `attachment; filename="${result.file.filename}"`)
      .send(createReadStream(result.file.path));
  }
  return reply.code(result.status).send(result.json ?? null);
};

const mount =
  (handler: ShopHandler, context: ShopContext) => (request: FastifyRequest, reply: FastifyReply) =>
    send(reply, handler(shopRequest(request), context));

export async function createShopFastifyApp(
  options: CreateShopFastifyAppOptions,
): Promise<ShopFastifyApp> {
  const demoId = options.demoId;
  const log = createShopServerLogger(demoId);

  // The store MIGRATES and does not wipe: orders, users and products survive a
  // restart, which is the whole subject of this demo.
  const store = openShopStore({ demoId, log });
  const secret = resolveCookieSecret(store.dir, demoId);

  // The rate-limit-behind-a-proxy rule: without this every payer shares the
  // proxy's IP. Drop it only when the app faces the network directly.
  const app = Fastify({ trustProxy: true });

  // Catalog thumbnails are public. The DOWNLOAD is not, and deliberately does
  // not go through this mount — it is gated on the paid order row.
  await app.register(fastifyStatic, {
    root: shopArtworkDir,
    prefix: `${SHOP_IMAGES_PREFIX}/`,
    // A missing thumbnail is a 404, never the SPA fallback below.
    wildcard: true,
  });

  // The wallet, and whether it is real. See service.ts.
  const { service, testkit } = await createShopService(log);

  // Live routes in testkit mode, a hard 404 on the whole prefix otherwise.
  mountShopTestkitControlsFastify(app, testkit);

  // The engine owns its two tables inside the shop's own database — never a
  // second one. `amountFor` and `onPaid` are two of the three hooks; the third,
  // `authorize`, is on the plugin below.
  const host = createHost({
    db: store.db,
    amountFor: createShopAmountFor(store),
    onPaid: createShopOnPaid(log),
  });

  // The prefix goes to register(), so Fastify scopes the plugin's catch-all to
  // it and the OpenReceive routes live directly under /openreceive.
  await app.register(openReceiveFastify, {
    service,
    host,
    authorize: createShopAuthorize(store, secret),
    rateLimiting: options.rateLimiting,
    prefix: SHOP_OPENRECEIVE_PREFIX,
  });

  const context: ShopContext = { store, secret, openreceivePrefix: SHOP_OPENRECEIVE_PREFIX };

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
  // the mounted OpenReceive routes emit; Fastify's own 4xx (a malformed JSON
  // body) keep their status; anything else stays a 500.
  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    if (sendHostRouteError(reply, error)) return;
    const status = error.statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      return reply
        .code(status)
        .send({ code: "INVALID_REQUEST", message: error.message, retryable: false });
    }
    log("host_route.error", "Unhandled host route error.", { error: error.message });
    return reply.code(500).send({ code: "INTERNAL", message: "Internal error.", retryable: false });
  });

  return { app, store };
}
