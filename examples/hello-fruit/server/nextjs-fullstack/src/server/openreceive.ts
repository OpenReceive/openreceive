import type {
  OpenReceiveInvoiceKvStore,
  OpenReceiveReceiveNwcClient,
  OpenReceiveSourcedPriceProvider,
} from "@openreceive/core";
import { guestCheckout, hostError, mapHostRouteError, type CreateOpenReceiveHttpHandlerOptions } from "@openreceive/http";
import {
  createOpenReceive,
  readOpenReceiveConfigFile,
} from "@openreceive/node";
import { createHelloFruitDemoMetadata } from "../../../../shared/demo-metadata.ts";
import { readRequiredHelloFruitNwcConnectionString } from "../../../../shared/demo-nwc.ts";
import {
  createHelloFruitDemoServerLogger,
  createHelloFruitOpenReceiveLogger,
} from "../../../../shared/demo-logging.ts";
import {
  createHelloFruitOrderStore,
  prepareHelloFruitOrder,
  getHelloFruitDemoOrder,
} from "../../../../shared/demo-order.ts";
import {
  readHelloFruitCheckoutCurrencies,
  readHelloFruitPriceFeedCurrencies,
} from "../../../../shared/demo-currencies.ts";

const DEMO_ID = "nextjs-fullstack";
const DEFAULT_PORT = "3002";
const GITHUB_REPOSITORY_URL = "https://github.com/openreceive/openreceive";
const logDemo = createHelloFruitDemoServerLogger(DEMO_ID);

interface NextDemoOpenReceiveCache {
  readonly walletCacheKey: string;
  readonly storeCacheKey: string;
  readonly server: ReturnType<typeof createHelloFruitOpenReceive>;
}

interface HelloFruitOpenReceiveBundle {
  readonly openreceive: Awaited<ReturnType<typeof createOpenReceive>>;
}

export interface HelloFruitOpenReceiveTestOverrides {
  readonly client?: OpenReceiveReceiveNwcClient;
  readonly store?: OpenReceiveInvoiceKvStore;
  readonly priceProviders?: readonly OpenReceiveSourcedPriceProvider[];
  readonly configPath?: string | false;
}

let openreceiveCache: NextDemoOpenReceiveCache | undefined;
let testOverrides: HelloFruitOpenReceiveTestOverrides | undefined;

export function setHelloFruitOpenReceiveTestOverrides(
  overrides: HelloFruitOpenReceiveTestOverrides | undefined,
): void {
  logDemo("test_overrides.set", "Resetting OpenReceive cache for test overrides.", {
    hasClient: overrides?.client !== undefined,
    hasStore: overrides?.store !== undefined,
    hasPriceProviders: overrides?.priceProviders !== undefined,
  });
  openreceiveCache = undefined;
  testOverrides = overrides;
}

export function isWalletConfigured(): boolean {
  if (testOverrides?.client !== undefined) return true;
  readRequiredHelloFruitNwcConnectionString();
  return true;
}

export function demoMetadataResponse(): Response {
  logDemo("metadata.request", "Serving demo metadata.");
  return jsonResponse(
    createHelloFruitDemoMetadata({
      id: DEMO_ID,
      walletConfigured: isWalletConfigured(),
      requestedMode: process.env.OPENRECEIVE_DEMO_MODE,
      gitSha: process.env.OPENRECEIVE_GIT_SHA,
      imageDigest: process.env.OPENRECEIVE_IMAGE_DIGEST,
      deployedAt: process.env.OPENRECEIVE_DEPLOYED_AT,
      packages: {
        "@openreceive/browser": "0.1.0",
        "@openreceive/react": "0.1.0",
        next: "0.1.0-demo",
      },
    }),
  );
}

export function sourceRedirectResponse(): Response {
  return Response.redirect(
    `${GITHUB_REPOSITORY_URL}/tree/main/examples/hello-fruit/server/nextjs-fullstack`,
    302,
  );
}

export function docsRedirectResponse(): Response {
  return Response.redirect(
    `${GITHUB_REPOSITORY_URL}/blob/main/docs/guides/frontend-checkout.md`,
    302,
  );
}

export function robotsResponse(): string {
  if (process.env.OPENRECEIVE_DEMO_NOINDEX === "1") {
    return "User-agent: *\nDisallow: /\n";
  }

  return `User-agent: *\nAllow: /\nSitemap: ${publicUrl()}/sitemap.xml\n`;
}

export function sitemapResponse(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    `  <url><loc>${escapeXml(publicUrl())}/</loc></url>`,
    "</urlset>",
    "",
  ].join("\n");
}

// App order step (NOT an OpenReceive route): validate the cart, compute the authoritative total,
// and PERSIST the order via the store's meta KV so `getCheckoutAmount` can look it up. Creating the
// checkout, polling, and swaps are all the mounted OpenReceive router's job (the catch-all route).
export async function prepareOrderResponse(request: Request): Promise<Response> {
  const startedAt = Date.now();
  const { openreceive } = await getOpenReceive();
  const orders = createHelloFruitOrderStore(openreceive);

  try {
    const body = await readJsonBody(request);
    logDemo("prepare_order.request", "Received prepare order request.", {
      ...summarizeOrderRequest(body),
    });
    const { order } = await prepareHelloFruitOrder(body, {
      demoId: DEMO_ID,
      demoName: "Next.js",
      openreceive,
      orders,
    });
    logDemo("prepare_order.prepared", "Prepared and persisted demo order.", {
      orderId: order.uuid,
      orderStatus: order.status,
      total: order.total_amount,
      itemCount: order.items.length,
      elapsedMs: Date.now() - startedAt,
    });
    return jsonResponse({ order }, 201);
  } catch (error) {
    const mapped = mapHostRouteError(error);
    if (mapped !== null) {
      logDemo("prepare_order.rejected", "Prepare order request returned a known error.", {
        status: mapped.status,
        body: mapped.body,
        elapsedMs: Date.now() - startedAt,
      });
      return jsonResponse(mapped.body, mapped.status);
    }
    logDemo("prepare_order.error", "Prepare order request failed unexpectedly.", {
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - startedAt,
    });
    throw error;
  }
}

/** Guest resume: public order summary for `/checkout/:orderId` when sessionStorage is empty. */
export async function orderSummaryResponse(orderId: string): Promise<Response> {
  const startedAt = Date.now();
  const { openreceive } = await getOpenReceive();
  const order = orderId.length === 0 ? null : await getHelloFruitDemoOrder(openreceive, orderId);
  if (order === null) {
    logDemo("orders.not_found", "Order summary lookup missed.", {
      orderId,
      elapsedMs: Date.now() - startedAt,
    });
    return jsonResponse(
      {
        code: "NOT_FOUND",
        message: "Order not found.",
        retryable: false,
      },
      404,
    );
  }
  logDemo("orders.response", "Served order summary for checkout resume.", {
    orderId: order.uuid,
    orderStatus: order.status,
    itemCount: order.items.length,
    elapsedMs: Date.now() - startedAt,
  });
  return jsonResponse({ order });
}

/**
 * Options for the mounted OpenReceive router (app/openreceive/[...openreceive] catch-all).
 * Same shape as docs/guides/quickstart-node.md (Next adapter): service + getCheckoutAmount.
 * guestCheckout(): anonymous create, Tier-2 reads gated by the per-order capability token.
 * For a signed-in app, swap authorize for withUser instead, e.g.:
 *   import { withUser } from "@openreceive/http";
 *   authorize: withUser((request) => currentUserFromMySession(request), {
 *     ownsOrder: (user, ctx) => orderBelongsTo(user, ctx.resource.order_id),
 *     isAdmin: (user) => user.admin,
 *   }),
 */
export async function openReceiveHttpOptions(): Promise<CreateOpenReceiveHttpHandlerOptions> {
  const { openreceive } = await getOpenReceive();
  const orders = createHelloFruitOrderStore(openreceive);
  return {
    service: openreceive,
    authorize: guestCheckout(),
    getCheckoutAmount: orders.createGetCheckoutAmount(),
  };
}

export async function ratesResponse(): Promise<Response> {
  const startedAt = Date.now();
  const { openreceive } = await getOpenReceive();
  const rates = await openreceive.listRates();
  logDemo("rates.response", "Served BTC fiat display rates.", {
    rateCurrencies: Object.keys(rates.bitcoin),
    elapsedMs: Date.now() - startedAt,
  });
  return jsonResponse({ rates });
}

async function getOpenReceive(): Promise<HelloFruitOpenReceiveBundle> {
  const walletCacheKey = testOverrides?.client === undefined ? "env" : "openreceive-test-client";
  const storeCacheKey = currentStoreCacheKey();
  const cachedOpenReceive = openreceiveCache;
  if (cachedOpenReceive !== undefined) {
    try {
      if (
        cachedOpenReceive.walletCacheKey === walletCacheKey &&
        cachedOpenReceive.storeCacheKey === storeCacheKey
      ) {
        logDemo("openreceive.cache_hit", "Reusing cached OpenReceive demo service.", {
          storeCacheKey,
        });
        return await cachedOpenReceive.server;
      }
    } catch {
      logDemo("openreceive.cache_stale", "Discarding cached OpenReceive demo service.");
      if (openreceiveCache === cachedOpenReceive) openreceiveCache = undefined;
    }
  }

  logDemo("openreceive.cache_miss", "Creating OpenReceive demo service.", {
    storeCacheKey,
    usingTestClient: testOverrides?.client !== undefined,
  });
  const nextServer = createHelloFruitOpenReceive();
  openreceiveCache = {
    walletCacheKey,
    storeCacheKey,
    server: nextServer,
  };

  try {
    return await nextServer;
  } catch (error) {
    logDemo("openreceive.create_failed", "OpenReceive demo service failed to initialize.", {
      error: error instanceof Error ? error.message : String(error),
    });
    if (openreceiveCache?.server === nextServer) openreceiveCache = undefined;
    throw error;
  }
}

export async function createHelloFruitOpenReceive(
  overrides: HelloFruitOpenReceiveTestOverrides = testOverrides === undefined ? {} : testOverrides,
) {
  const config = readOpenReceiveConfigFile({ cwd: process.cwd(), configPath: overrides.configPath });
  logDemo("openreceive.configure", "Preparing OpenReceive demo service.", {
    namespace: config?.namespace ?? "hello_fruit",
    customClient: overrides.client !== undefined,
    customStore: overrides.store !== undefined,
    customPriceProviders: overrides.priceProviders !== undefined,
  });
  const priceCurrencies = readHelloFruitPriceFeedCurrencies();
  const supportedCurrencies = readHelloFruitCheckoutCurrencies();

  logDemo("openreceive.price_currencies", "Loaded checkout and price feed currencies.", {
    checkoutCurrencyCount: supportedCurrencies.length,
    priceCurrencyCount: priceCurrencies.length,
  });

  // Quickstart shape: createOpenReceive({ onPaid }) + mount with getCheckoutAmount.
  // onPaid may fire more than once — dedupe on checkoutId in a real app.
  const openreceive = await createOpenReceive({
    ...(overrides.client === undefined ? {} : { client: overrides.client }),
    ...(overrides.store === undefined ? {} : { store: overrides.store }),
    ...(overrides.priceProviders === undefined ? {} : { priceProviders: overrides.priceProviders }),
    ...(overrides.configPath === undefined ? {} : { configPath: overrides.configPath }),
    namespace: config?.namespace ?? "hello_fruit",
    priceCurrencies,
    logger: createHelloFruitOpenReceiveLogger(DEMO_ID),
    onPaid: async ({ orderId, checkoutId }) => {
      logDemo("openreceive.on_paid", "Checkout settled — fulfill your order here.", {
        orderId,
        checkoutId,
      });
    },
  });
  logDemo("openreceive.ready", "OpenReceive demo service is ready.", {
    priceCurrencyCount: openreceive.priceCurrencies.length,
    checkoutCurrencyCount: supportedCurrencies.length,
  });
  return {
    openreceive,
  } satisfies HelloFruitOpenReceiveBundle;
}

function summarizeOrderRequest(body: Record<string, unknown>): Record<string, unknown> {
  const cart = Array.isArray(body.cart) ? body.cart : [];
  return {
    currency: body.currency,
    cartLineCount: cart.length,
    cartQuantity: cart.reduce((total, item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return total;
      const quantity = (item as Record<string, unknown>).quantity;
      return total + (typeof quantity === "number" && Number.isFinite(quantity) ? quantity : 0);
    }, 0),
    productIds: cart
      .map((item) =>
        typeof item === "object" && item !== null && !Array.isArray(item)
          ? (item as Record<string, unknown>).product_id
          : undefined,
      )
      .filter((productId): productId is string => typeof productId === "string"),
  };
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  if (request.method === "GET" || request.method === "HEAD") return {};
  const text = await request.text();
  if (text.length === 0) return {};
  const body = JSON.parse(text) as unknown;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw hostError("JSON request body must be an object.");
  }
  return body as Record<string, unknown>;
}

function currentStoreCacheKey(): string {
  const config = readOpenReceiveConfigFile({
    cwd: process.cwd(),
    configPath: testOverrides?.configPath,
  });
  return JSON.stringify(config ?? {});
}

function publicUrl(): string {
  const configured = process.env.OPENRECEIVE_PUBLIC_URL;
  if (configured !== undefined) {
    try {
      const parsed = new URL(configured);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        parsed.hash = "";
        parsed.search = "";
        return parsed.toString().replace(/\/$/, "");
      }
    } catch {
      return `http://localhost:${DEFAULT_PORT}`;
    }
  }

  return `http://localhost:${DEFAULT_PORT}`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    },
  });
}
