import type {
  OpenReceiveInvoiceKvStore,
  OpenReceiveReceiveNwcClient,
  OpenReceiveSourcedPriceProvider
} from "@openreceive/core";
import {
  OpenReceiveServiceError,
  createOpenReceive,
  createOpenReceivePriceFeed
} from "@openreceive/node";
import {
  createHelloFruitDemoMetadata
} from "../../../../shared/demo-metadata.ts";
import {
  readRequiredHelloFruitNwcConnectionString
} from "../../../../shared/demo-nwc.ts";
import {
  createHelloFruitOpenReceiveLogger
} from "../../../../shared/demo-logging.ts";
import {
  createHelloFruitCreateOrderResult,
  createHelloFruitOrderStatus
} from "../../../../shared/demo-order.ts";
import {
  createHelloFruitOpenReceiveKvStore
} from "../../../../shared/openreceive-store.ts";
import {
  readHelloFruitCheckoutCurrencies,
  readHelloFruitPriceFeedCurrencies
} from "../../../../shared/demo-currencies.ts";
import {
  readHelloFruitOrderRates
} from "../../../../shared/demo-price-feeds.ts";
import product from "../../../../shared/product.json" with { type: "json" };

const DEMO_ID = "nextjs-fullstack";
const DEFAULT_PORT = "3002";
const GITHUB_REPOSITORY_URL = "https://github.com/openreceive/openreceive";

interface NextDemoOpenReceiveCache {
  readonly connectionString: string;
  readonly storeCacheKey: string;
  readonly server: ReturnType<typeof createHelloFruitOpenReceive>;
}

interface HelloFruitOpenReceiveBundle {
  readonly openreceive: Awaited<ReturnType<typeof createOpenReceive>>;
  readonly priceProviders: readonly OpenReceiveSourcedPriceProvider[];
  readonly supportedCurrencies: readonly string[];
}

export interface HelloFruitOpenReceiveTestOverrides {
  readonly client?: OpenReceiveReceiveNwcClient;
  readonly store?: OpenReceiveInvoiceKvStore;
  readonly priceProviders?: readonly OpenReceiveSourcedPriceProvider[];
}

let openreceiveCache: NextDemoOpenReceiveCache | undefined;
let testOverrides: HelloFruitOpenReceiveTestOverrides | undefined;

export function setHelloFruitOpenReceiveTestOverrides(
  overrides: HelloFruitOpenReceiveTestOverrides | undefined
): void {
  openreceiveCache = undefined;
  testOverrides = overrides;
}

export function isWalletConfigured(): boolean {
  if (testOverrides?.client !== undefined) return true;
  readRequiredHelloFruitNwcConnectionString();
  return true;
}

export function demoMetadataResponse(): Response {
  return jsonResponse(createHelloFruitDemoMetadata({
    id: DEMO_ID,
    walletConfigured: isWalletConfigured(),
    requestedMode: process.env.OPENRECEIVE_DEMO_MODE,
    gitSha: process.env.OPENRECEIVE_GIT_SHA,
    imageDigest: process.env.OPENRECEIVE_IMAGE_DIGEST,
    deployedAt: process.env.OPENRECEIVE_DEPLOYED_AT,
    packages: {
      "@openreceive/browser": "0.1.0",
      "@openreceive/react": "0.1.0",
      "next": "0.1.0-demo"
    }
  }));
}

export function sourceRedirectResponse(): Response {
  return Response.redirect(
    `${GITHUB_REPOSITORY_URL}/tree/main/examples/hello-fruit/server/nextjs-fullstack`,
    302
  );
}

export function docsRedirectResponse(): Response {
  return Response.redirect(
    `${GITHUB_REPOSITORY_URL}/blob/main/docs/guides/frontend-checkout.md`,
    302
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
    ""
  ].join("\n");
}

export async function createOrderResponse(
  request: Request
): Promise<Response> {
  const connectionString = testOverrides?.client === undefined
    ? readRequiredHelloFruitNwcConnectionString()
    : "openreceive-test-client";
  const {
    openreceive,
    priceProviders,
    supportedCurrencies
  } = await getOpenReceive(connectionString);

  try {
    const body = await readJsonBody(request);
    const rates = await readHelloFruitOrderRates({
      currency: body.currency,
      priceProviders,
      supportedCurrencies
    });
    const orderResult = createHelloFruitCreateOrderResult({
      ...body,
      idempotency_key: body.idempotency_key ?? request.headers.get("idempotency-key")
    }, {
      demoId: DEMO_ID,
      invoiceExpirySeconds: product.invoice_expiry_seconds,
      demoName: "Next.js",
      rates,
      supportedCurrencies
    });
    const checkout = await openreceive.createCheckout(orderResult.invoiceRequest);
    return jsonResponse({
      order: orderResult.order,
      checkout
    }, 201);
  } catch (error) {
    if (error instanceof OpenReceiveServiceError) {
      return jsonResponse(error.body, error.status);
    }
    throw error;
  }
}

export async function orderStatusResponse(request: Request): Promise<Response> {
  const connectionString = testOverrides?.client === undefined
    ? readRequiredHelloFruitNwcConnectionString()
    : "openreceive-test-client";
  const { openreceive } = await getOpenReceive(connectionString);

  try {
    const openreceiveOrder = await openreceive.getOrder(
      createStatusRequest(await readJsonBody(request))
    );
    const orderStatus = createHelloFruitOrderStatus(openreceiveOrder);
    return jsonResponse({
      ...openreceiveOrder,
      ...orderStatus,
      order: {
        uuid: orderStatus.order_id,
        status: orderStatus.order_status
      }
    });
  } catch (error) {
    if (error instanceof OpenReceiveServiceError) {
      return jsonResponse(error.body, error.status);
    }
    throw error;
  }
}

async function getOpenReceive(
  connectionString: string
): Promise<HelloFruitOpenReceiveBundle> {
  const storeCacheKey = currentStoreCacheKey();
  const cachedOpenReceive = openreceiveCache;
  if (cachedOpenReceive !== undefined) {
    try {
      if (
        cachedOpenReceive.connectionString === connectionString &&
        cachedOpenReceive.storeCacheKey === storeCacheKey
      ) {
        return await cachedOpenReceive.server;
      }
    } catch {
      if (openreceiveCache === cachedOpenReceive) openreceiveCache = undefined;
    }
  }

  const nextServer = createHelloFruitOpenReceive(connectionString);
  openreceiveCache = {
    connectionString,
    storeCacheKey,
    server: nextServer
  };

  try {
    return await nextServer;
  } catch (error) {
    if (openreceiveCache?.server === nextServer) openreceiveCache = undefined;
    throw error;
  }
}

export async function createHelloFruitOpenReceive(
  connectionString = readRequiredHelloFruitNwcConnectionString(),
  overrides: HelloFruitOpenReceiveTestOverrides = testOverrides === undefined ? {} : testOverrides
) {
  const store = overrides.store ?? await createHelloFruitOpenReceiveKvStore({
    demoId: DEMO_ID
  });
  const priceCurrencies = readHelloFruitPriceFeedCurrencies();
  const supportedCurrencies = readHelloFruitCheckoutCurrencies();
  const priceProviders: readonly OpenReceiveSourcedPriceProvider[] =
    overrides.priceProviders ??
    [createOpenReceivePriceFeed({ store, currencies: priceCurrencies })];

  const openreceive = await createOpenReceive({
    ...(overrides.client === undefined ? { nwc: connectionString } : { client: overrides.client }),
    store,
    namespace: process.env.OPENRECEIVE_NAMESPACE ?? "hello_fruit",
    priceProviders,
    priceCurrencies,
    logger: createHelloFruitOpenReceiveLogger(DEMO_ID)
  });
  return { openreceive, priceProviders, supportedCurrencies } satisfies HelloFruitOpenReceiveBundle;
}

function createStatusRequest(body: Record<string, unknown>): {
  readonly order_id: string;
} {
  const orderId = body.order_id;
  if (typeof orderId !== "string" || orderId.length === 0) {
    throw new OpenReceiveServiceError(400, {
      code: "INVALID_REQUEST",
      message: "order_id is required."
    });
  }
  return { order_id: orderId };
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  if (request.method === "GET" || request.method === "HEAD") return {};
  const text = await request.text();
  if (text.length === 0) return {};
  const body = JSON.parse(text) as unknown;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new OpenReceiveServiceError(400, {
      code: "INVALID_REQUEST",
      message: "JSON request body must be an object."
    });
  }
  return body as Record<string, unknown>;
}

function currentStoreCacheKey(): string {
  return JSON.stringify({
    store: process.env.OPENRECEIVE_STORE ?? "local-sqlite",
    namespace: process.env.OPENRECEIVE_NAMESPACE ?? "hello_fruit"
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
      "Content-Type": "application/json"
    }
  });
}
