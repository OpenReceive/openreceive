import {
  createDefaultLivePriceProviders
} from "@openreceive/core";
import {
  createOpenReceive,
  type OpenReceiveServer
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
  createHelloFruitOpenReceiveKvStore
} from "../../../../shared/openreceive-store.ts";
import {
  readHelloFruitCatalogCurrencies
} from "../../../../shared/demo-catalog.ts";

const DEMO_ID = "nextjs-fullstack";
const DEFAULT_PORT = "3002";
const GITHUB_REPOSITORY_URL = "https://github.com/openreceive/openreceive";

interface NextDemoOpenReceiveCache {
  readonly connectionString: string;
  readonly storeCacheKey: string;
  readonly server: Promise<OpenReceiveServer>;
}

let openreceiveCache: NextDemoOpenReceiveCache | undefined;

export function isWalletConfigured(): boolean {
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

export function healthzResponse(): Response {
  return jsonResponse({
    ok: true,
    demo: DEMO_ID,
    wallet_configured: isWalletConfigured()
  });
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

export async function dispatchOpenReceiveRoute(
  request: Request
): Promise<Response> {
  const connectionString = readRequiredHelloFruitNwcConnectionString();
  return (await getOpenReceive(connectionString)).handleFetch(request);
}

async function getOpenReceive(connectionString: string): Promise<OpenReceiveServer> {
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
  connectionString = readRequiredHelloFruitNwcConnectionString()
): Promise<OpenReceiveServer> {
  const store = await createHelloFruitOpenReceiveKvStore({
    demoId: DEMO_ID
  });
  const priceCurrencies = readHelloFruitCatalogCurrencies();

  return await createOpenReceive({
    nwc: connectionString,
    store,
    merchantScope: () => "demo:hello-fruit-nextjs",
    priceProviders: createDefaultLivePriceProviders({ currencies: priceCurrencies }),
    priceCurrencies,
    unsafeAllowUnauthenticatedDemoMode: true,
    logger: createHelloFruitOpenReceiveLogger(DEMO_ID)
  });
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
