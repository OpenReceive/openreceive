/**
 * The Next.js host's server side.
 *
 * Every route handler under src/app/shop/ is a three-line wrapper around one
 * of the five framework-free handlers in
 * examples/buttons/shared/server-node/shop-routes.ts. Nothing about the shop
 * is re-implemented here — this file is the adapter (a Web `Request` in, a Web
 * `Response` out) plus the lazy singletons a serverless-shaped runtime needs.
 */

import { readFileSync } from "node:fs";
import { createHost, type Host } from "@openreceive/http";
import { resolveCookieSecret } from "../../../../shared/server-node/cookie.ts";
import { createShopServerLogger } from "../../../../shared/server-node/logging.ts";
import {
  createShopAmountFor,
  createShopAuthorize,
  createShopOnPaid,
} from "../../../../shared/server-node/openreceive-config.ts";
import { createShopService, type ShopService } from "../../../../shared/server-node/service.ts";
import type {
  ShopContext,
  ShopRequest,
  ShopResult,
} from "../../../../shared/server-node/shop-routes.ts";
import { openShopStore, type ShopStore } from "../../../../shared/server-node/store.ts";
import type { ShopTestkitFixtures } from "../../../../shared/server-node/testkit-controls.ts";

const DEMO_ID = "nextjs-fullstack";
const OPENRECEIVE_PREFIX = "/openreceive";

const log = createShopServerLogger(DEMO_ID);

/**
 * Singletons, hung off `globalThis`.
 *
 * A plain module-level `let` is what you would write first, and in dev it is
 * wrong: an edit to any server file makes Turbopack re-evaluate the module
 * graph, and a second evaluation opens a SECOND SQLite handle on the same file
 * and a second wallet — after which minted attempts fail to persist with a
 * message about the host, and nothing points at the reload. Keying the cache on
 * `globalThis` survives the re-evaluation, which is the same trick every
 * database client in a Next app ends up needing.
 */
interface ShopGlobals {
  store?: ShopStore;
  secret?: string;
  service?: Promise<ShopService>;
  host?: Promise<Host>;
}

const globals = globalThis as { __buttonsShop?: ShopGlobals };
globals.__buttonsShop ??= {};
const cache: ShopGlobals = globals.__buttonsShop;

const getStore = (): ShopStore => {
  // The store MIGRATES and does not wipe, so a restart keeps the orders that
  // were already placed. That is the demo.
  cache.store ??= openShopStore({ demoId: DEMO_ID, log });
  return cache.store;
};

const getSecret = (): string => {
  cache.secret ??= resolveCookieSecret(getStore().dir, DEMO_ID);
  return cache.secret;
};

export const shopContext = (): ShopContext => ({
  store: getStore(),
  secret: getSecret(),
  openreceivePrefix: OPENRECEIVE_PREFIX,
});

const getService = async (): Promise<ShopService> => {
  cache.service ??= createShopService(log);
  try {
    return await cache.service;
  } catch (error) {
    cache.service = undefined;
    throw error;
  }
};

/** The testkit fakes, in testkit wallet mode only. `undefined` 404s the control surface. */
export const testkitFixtures = async (): Promise<ShopTestkitFixtures | undefined> =>
  (await getService()).testkit;

const getHost = async (): Promise<Host> => {
  cache.host ??= (async () => {
    // The engine owns its two tables inside the shop's own database.
    const host = createHost({
      db: getStore().db,
      amountFor: createShopAmountFor(getStore()),
      onPaid: createShopOnPaid(log),
    });
    const { service } = await getService();
    const shutdown = async () => {
      await service.close();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    return host;
  })();
  try {
    return await cache.host;
  } catch (error) {
    cache.host = undefined;
    throw error;
  }
};

/**
 * What the mounted OpenReceive catch-all is built from.
 *
 * No background reconciler: there is no long-lived process to own one on a
 * serverless runtime, so any OpenReceive call runs the durably gated
 * opportunistic reconcile and a payer who closed the page settles on the next
 * call that wins the gate.
 */
export const httpOptions = async () => ({
  service: (await getService()).service,
  host: await getHost(),
  authorize: createShopAuthorize(getStore(), getSecret()),
});

// ------------------------------------------------------------------ adapters

export const shopRequest = (
  request: Request,
  params: Record<string, string | undefined> = {},
  body?: unknown,
): ShopRequest => ({
  cookieHeader: request.headers.get("cookie") ?? undefined,
  body,
  params,
  // Decides the identity cookie's Secure flag, and follows THE REQUEST rather
  // than an environment name: a cookie marked secure is dropped by the browser
  // on plain HTTP, and the production-mode demo is served over http://localhost.
  secure: new URL(request.url).protocol === "https:",
});

export const shopResponse = (result: ShopResult): Response => {
  const headers = new Headers(result.headers);
  if (result.setCookie !== undefined) headers.append("Set-Cookie", result.setCookie);

  if (result.file !== undefined) {
    headers.set("Content-Type", result.file.contentType);
    headers.set("Content-Disposition", `attachment; filename="${result.file.filename}"`);
    return new Response(new Uint8Array(readFileSync(result.file.path)), {
      status: result.status,
      headers,
    });
  }

  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(result.json ?? null), { status: result.status, headers });
};
