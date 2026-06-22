import {
  createDefaultLivePriceProviders
} from "@openreceive/core";
import {
  createAlbyNwcReceiveClient
} from "@openreceive/node";
import type {
  OpenReceiveExpressOptions
} from "@openreceive/express";
import {
  createOpenReceiveNextRuntime,
  dispatchOpenReceiveNextRoute,
  openReceiveNextJsonResponse,
  type OpenReceiveNextRuntime
} from "@openreceive/next";
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

interface NextDemoRuntime extends OpenReceiveNextRuntime {
  readonly connectionString: string;
}

let runtime: NextDemoRuntime | undefined;

export function isWalletConfigured(): boolean {
  readRequiredHelloFruitNwcConnectionString();
  return true;
}

export function demoMetadataResponse(): Response {
  return openReceiveNextJsonResponse(createHelloFruitDemoMetadata({
    id: DEMO_ID,
    walletConfigured: isWalletConfigured(),
    requestedMode: process.env.OPENRECEIVE_DEMO_MODE,
    gitSha: process.env.OPENRECEIVE_GIT_SHA,
    imageDigest: process.env.OPENRECEIVE_IMAGE_DIGEST,
    deployedAt: process.env.OPENRECEIVE_DEPLOYED_AT,
    packages: {
      "@openreceive/browser": "0.1.0",
      "@openreceive/next": "0.1.0",
      "@openreceive/react": "0.1.0",
      "next": "0.1.0-demo"
    }
  }));
}

export function healthzResponse(): Response {
  return openReceiveNextJsonResponse({
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
    `${GITHUB_REPOSITORY_URL}/blob/main/docs/05-frontend-checkout.md`,
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
  request: Request,
  path: readonly string[]
): Promise<Response> {
  const connectionString = readRequiredHelloFruitNwcConnectionString();

  return dispatchOpenReceiveNextRoute({
    runtime: getRuntime(connectionString),
    request,
    path
  });
}

function getRuntime(connectionString: string): NextDemoRuntime {
  if (runtime !== undefined && runtime.connectionString === connectionString) {
    return runtime;
  }

  const options = createHelloFruitOpenReceiveOptions(connectionString);
  runtime = {
    connectionString,
    ...createOpenReceiveNextRuntime(options)
  };

  return runtime;
}

export function createHelloFruitOpenReceiveOptions(
  connectionString = readRequiredHelloFruitNwcConnectionString()
): OpenReceiveExpressOptions {
  const store = createHelloFruitOpenReceiveKvStore({
    demoId: DEMO_ID
  });
  const client = createAlbyNwcReceiveClient({
    connectionString
  });

  const priceCurrencies = readHelloFruitCatalogCurrencies();

  return {
    client,
    store,
    merchantScope: () => "demo:hello-fruit-nextjs",
    priceProviders: createDefaultLivePriceProviders({ currencies: priceCurrencies }),
    priceCurrencies,
    unsafeAllowUnauthenticatedDemoMode: true,
    logger: createHelloFruitOpenReceiveLogger(DEMO_ID)
  };
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
