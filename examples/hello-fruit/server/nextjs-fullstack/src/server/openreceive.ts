import type {
  OpenReceiveInvoiceKvStore,
  OpenReceiveReceiveNwcClient,
  OpenReceiveSourcedPriceProvider,
} from "@openreceive/core";
import { OpenReceiveServiceError, createOpenReceive } from "@openreceive/node";
import { createHelloFruitDemoMetadata } from "../../../../shared/demo-metadata.ts";
import { readRequiredHelloFruitNwcConnectionString } from "../../../../shared/demo-nwc.ts";
import {
  createHelloFruitDemoServerLogger,
  createHelloFruitOpenReceiveLogger,
} from "../../../../shared/demo-logging.ts";
import {
  createHelloFruitCreateOrderResult,
  createHelloFruitOrderStatus,
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

export async function createOrderResponse(request: Request): Promise<Response> {
  const startedAt = Date.now();
  const { openreceive } = await getOpenReceive();

  try {
    const body = await readJsonBody(request);
    logDemo("create_order.request", "Received create order request.", {
      ...summarizeOrderRequest(body),
    });
    const orderResult = await createHelloFruitCreateOrderResult(body, {
      demoId: DEMO_ID,
      demoName: "Next.js",
      openreceive,
    });
    logDemo("create_order.prepared", "Prepared demo order and invoice request.", {
      orderId: orderResult.order.uuid,
      orderStatus: orderResult.order.status,
      total: orderResult.order.total_amount,
      itemCount: orderResult.order.items.length,
    });
    const checkout = await openreceive.getOrCreateCheckout(orderResult.invoiceRequest);
    logDemo("create_order.checkout_created", "Created or reused checkout.", {
      orderId: checkout.order_id,
      elapsedMs: Date.now() - startedAt,
    });
    return jsonResponse(
      {
        order: orderResult.order,
        checkout,
      },
      201,
    );
  } catch (error) {
    if (error instanceof OpenReceiveServiceError) {
      logDemo("create_order.rejected", "Create order request returned a known error.", {
        status: error.status,
        body: error.body,
        elapsedMs: Date.now() - startedAt,
      });
      return jsonResponse(error.body, error.status);
    }
    logDemo("create_order.error", "Create order request failed unexpectedly.", {
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - startedAt,
    });
    throw error;
  }
}

export async function orderStatusResponse(request: Request): Promise<Response> {
  const startedAt = Date.now();
  const { openreceive } = await getOpenReceive();

  try {
    const statusRequest = createStatusRequest(await readJsonBody(request));
    logDemo("order_status.request", "Received order status request.", {
      orderId: statusRequest.orderId,
    });
    await authorizeOrderAccess(request, statusRequest.orderId);
    const openreceiveOrder = await openreceive.getOrder(statusRequest);
    const orderStatus = createHelloFruitOrderStatus(openreceiveOrder);
    logDemo("order_status.response", "Refreshed order status.", {
      orderId: orderStatus.order_id,
      orderStatus: orderStatus.order_status,
      ...summarizeSettlementFields(openreceiveOrder),
      elapsedMs: Date.now() - startedAt,
    });
    return jsonResponse({
      ...openreceiveOrder,
      ...orderStatus,
      order: {
        uuid: orderStatus.order_id,
        status: orderStatus.order_status,
      },
    });
  } catch (error) {
    if (error instanceof OpenReceiveServiceError) {
      logDemo("order_status.rejected", "Order status request returned a known error.", {
        status: error.status,
        body: error.body,
        elapsedMs: Date.now() - startedAt,
      });
      return jsonResponse(error.body, error.status);
    }
    logDemo("order_status.error", "Order status request failed unexpectedly.", {
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - startedAt,
    });
    throw error;
  }
}

export async function swapOptionsResponse(request: Request): Promise<Response> {
  const startedAt = Date.now();
  const { openreceive } = await getOpenReceive();

  try {
    const body = await readJsonBody(request);
    const orderId = requireRequestString(body, "order_id");
    await authorizeOrderAccess(request, orderId);
    const result = await openreceive.swapOptions({
      orderId,
    });
    logDemo("swap_options.response", "Served automated swap options.", {
      orderId,
      enabled: result.enabled,
      optionCount: result.options.length,
      elapsedMs: Date.now() - startedAt,
    });
    return jsonResponse(result);
  } catch (error) {
    if (error instanceof OpenReceiveServiceError) {
      return jsonResponse(error.body, error.status);
    }
    throw error;
  }
}

export async function swapQuoteResponse(request: Request): Promise<Response> {
  const startedAt = Date.now();
  const { openreceive } = await getOpenReceive();

  try {
    const body = await readJsonBody(request);
    const orderId = requireRequestString(body, "order_id");
    const payInAsset = requireRequestString(body, "pay_in_asset");
    await authorizeOrderAccess(request, orderId);
    const quote = await openreceive.swapQuote({
      orderId,
      payInAsset,
    });
    logDemo("swap_quote.response", "Served automated swap quote.", {
      orderId,
      payInAsset,
      provider: quote.provider,
      available: quote.available,
      elapsedMs: Date.now() - startedAt,
    });
    return jsonResponse({ quote });
  } catch (error) {
    if (error instanceof OpenReceiveServiceError) {
      return jsonResponse(error.body, error.status);
    }
    throw error;
  }
}

export async function swapStartResponse(request: Request): Promise<Response> {
  const startedAt = Date.now();
  const { openreceive } = await getOpenReceive();

  try {
    const body = await readJsonBody(request);
    const orderId = requireRequestString(body, "order_id");
    const payInAsset = requireRequestString(body, "pay_in_asset");
    await authorizeOrderAccess(request, orderId);
    const invoice = await openreceive.startSwap({
      orderId,
      payInAsset,
    });
    logDemo("swap_start.response", "Started automated swap.", {
      orderId,
      payInAsset,
      invoiceId: invoice.invoice_id,
      provider: invoice.swap?.provider,
      elapsedMs: Date.now() - startedAt,
    });
    return jsonResponse({ invoice }, 201);
  } catch (error) {
    if (error instanceof OpenReceiveServiceError) {
      return jsonResponse(error.body, error.status);
    }
    throw error;
  }
}

export async function swapRefundResponse(request: Request): Promise<Response> {
  const startedAt = Date.now();
  const { openreceive } = await getOpenReceive();

  try {
    const body = await readJsonBody(request);
    const orderId = requireRequestString(body, "order_id");
    const attemptId = requireRequestString(body, "attempt_id");
    const refundAddress = requireRequestString(body, "refund_address");
    const refundNonce = requireRequestString(body, "refund_nonce");
    await authorizeOrderAccess(request, orderId);
    const invoice = await openreceive.refundSwap({
      attemptId,
      refundAddress,
      refundNonce,
      confirm: body.confirm === true,
    });
    logDemo("swap_refund.response", "Requested automated swap refund.", {
      attemptId,
      invoiceId: invoice.invoice_id,
      provider: invoice.swap?.provider,
      elapsedMs: Date.now() - startedAt,
    });
    return jsonResponse({ invoice });
  } catch (error) {
    if (error instanceof OpenReceiveServiceError) {
      return jsonResponse(error.body, error.status);
    }
    throw error;
  }
}

async function authorizeOrderAccess(_request: Request, _orderId: string): Promise<void> {
  // Demo seam: production apps should verify the signed-in/session caller owns
  // this order before proxying OpenReceive order, swap, or refund methods.
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
  logDemo("openreceive.configure", "Preparing OpenReceive demo service.", {
    namespace: process.env.OPENRECEIVE_NAMESPACE ?? "hello_fruit",
    customClient: overrides.client !== undefined,
    customStore: overrides.store !== undefined,
    customPriceProviders: overrides.priceProviders !== undefined,
  });
  const priceCurrencies = readHelloFruitPriceFeedCurrencies();
  const supportedCurrencies = readHelloFruitCheckoutCurrencies();

  logDemo("openreceive.price_currencies", "Loaded checkout and price feed currencies.", {
    checkoutCurrencies: supportedCurrencies,
    priceCurrencies,
  });

  const openreceive = await createOpenReceive({
    ...(overrides.client === undefined ? {} : { client: overrides.client }),
    ...(overrides.store === undefined ? {} : { store: overrides.store }),
    ...(overrides.priceProviders === undefined ? {} : { priceProviders: overrides.priceProviders }),
    namespace: process.env.OPENRECEIVE_NAMESPACE ?? "hello_fruit",
    priceCurrencies,
    logger: createHelloFruitOpenReceiveLogger(DEMO_ID),
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

function summarizeSettlementFields(value: unknown): Record<string, unknown> {
  const order =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    settledAtPresent: order.settled_at !== undefined,
    transactionState: order.transaction_state,
    state: order.state,
  };
}

function createStatusRequest(body: Record<string, unknown>): {
  readonly orderId: string;
} {
  const orderId = body.order_id;
  if (typeof orderId !== "string" || orderId.length === 0) {
    throw new OpenReceiveServiceError(400, {
      code: "INVALID_REQUEST",
      message: "order_id is required.",
    });
  }
  return { orderId };
}

function requireRequestString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new OpenReceiveServiceError(400, {
      code: "INVALID_REQUEST",
      message: `${key} is required.`,
    });
  }
  return value;
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  if (request.method === "GET" || request.method === "HEAD") return {};
  const text = await request.text();
  if (text.length === 0) return {};
  const body = JSON.parse(text) as unknown;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new OpenReceiveServiceError(400, {
      code: "INVALID_REQUEST",
      message: "JSON request body must be an object.",
    });
  }
  return body as Record<string, unknown>;
}

function currentStoreCacheKey(): string {
  return JSON.stringify({
    store: process.env.OPENRECEIVE_STORE ?? "local-sqlite",
    namespace: process.env.OPENRECEIVE_NAMESPACE ?? "hello_fruit",
    swapConfig: process.env.OPENRECEIVE_SWAP_CONFIG,
    fixedFloatEnabled:
      process.env.OPENRECEIVE_SWAP_FIXED_FLOAT_KEY !== undefined &&
      process.env.OPENRECEIVE_SWAP_FIXED_FLOAT_SECRET !== undefined,
    fixedFloatBaseUrl: process.env.OPENRECEIVE_SWAP_FIXED_FLOAT_BASE_URL ?? "https://ff.io",
  });
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
