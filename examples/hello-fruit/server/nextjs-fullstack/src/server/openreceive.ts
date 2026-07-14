import type {
  OpenReceiveInvoiceKvStore,
  OpenReceiveReceiveNwcClient,
  OpenReceiveSourcedPriceProvider,
} from "@openreceive/core";
import { guestCheckout, type CreateOpenReceiveHttpHandlerOptions } from "@openreceive/http";
import {
  createOpenReceive,
  readOpenReceiveConfigFile,
} from "@openreceive/node";
import { readRequiredHelloFruitNwcConnectionString } from "../../../../shared/demo-nwc.ts";
import {
  createHelloFruitDemoServerLogger,
  createHelloFruitOpenReceiveLogger,
} from "../../../../shared/demo-logging.ts";
import { createHelloFruitPrepareCheckout } from "../../../../shared/demo-prepare-checkout.ts";
import { readHelloFruitPriceFeedCurrencies } from "../../../../shared/demo-currencies.ts";

const DEMO_ID = "nextjs-fullstack";
const logDemo = createHelloFruitDemoServerLogger(DEMO_ID);

/** Test-only overrides (fake wallet / in-memory store). Omit in real apps. */
export interface HelloFruitOpenReceiveTestOverrides {
  readonly client?: OpenReceiveReceiveNwcClient;
  readonly store?: OpenReceiveInvoiceKvStore;
  readonly priceProviders?: readonly OpenReceiveSourcedPriceProvider[];
  readonly configPath?: string | false;
}

interface HelloFruitOpenReceiveBundle {
  readonly openreceive: Awaited<ReturnType<typeof createOpenReceive>>;
}

interface NextDemoOpenReceiveCache {
  readonly walletCacheKey: string;
  readonly storeCacheKey: string;
  readonly server: Promise<HelloFruitOpenReceiveBundle>;
}

let openreceiveCache: NextDemoOpenReceiveCache | undefined;
let testOverrides: HelloFruitOpenReceiveTestOverrides | undefined;

export function setHelloFruitOpenReceiveTestOverrides(
  overrides: HelloFruitOpenReceiveTestOverrides | undefined,
): void {
  openreceiveCache = undefined;
  testOverrides = overrides;
}

export function isWalletConfigured(): boolean {
  if (testOverrides?.client !== undefined) return true;
  readRequiredHelloFruitNwcConnectionString();
  return true;
}

/**
 * Options for the mounted OpenReceive router (app/openreceive/[...openreceive] catch-all).
 * Same shape as docs/guides/quickstart-node.md (Next adapter): service + prepareCheckout.
 */
export async function openReceiveHttpOptions(): Promise<CreateOpenReceiveHttpHandlerOptions> {
  const { openreceive: service } = await getOpenReceive();
  return {
    service,
    authorize: guestCheckout(),
    prepareCheckout: createHelloFruitPrepareCheckout({
      demoId: DEMO_ID,
      demoName: "Next.js",
      openreceive: service,
    }),
  };
}

export async function ratesResponse(): Promise<Response> {
  const { openreceive: service } = await getOpenReceive();
  return jsonResponse({ rates: await service.listRates() });
}

async function getOpenReceive(): Promise<HelloFruitOpenReceiveBundle> {
  const walletCacheKey = testOverrides?.client === undefined ? "env" : "openreceive-test-client";
  const storeCacheKey = currentStoreCacheKey();
  const cached = openreceiveCache;
  if (
    cached !== undefined &&
    cached.walletCacheKey === walletCacheKey &&
    cached.storeCacheKey === storeCacheKey
  ) {
    try {
      return await cached.server;
    } catch {
      if (openreceiveCache === cached) openreceiveCache = undefined;
    }
  }

  const nextServer = createHelloFruitOpenReceive();
  openreceiveCache = {
    walletCacheKey,
    storeCacheKey,
    server: nextServer,
  };

  try {
    return await nextServer;
  } catch (error) {
    if (openreceiveCache?.server === nextServer) openreceiveCache = undefined;
    throw error;
  }
}

async function createHelloFruitOpenReceive(
  overrides: HelloFruitOpenReceiveTestOverrides = testOverrides ?? {},
): Promise<HelloFruitOpenReceiveBundle> {
  // Same shape as docs/guides/quickstart-node.md:
  // createOpenReceive({ onPaid }) — Next mounts via openReceiveNextHandlers + openReceiveHttpOptions.
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
    ...overrides,
  });
  return { openreceive: service };
}

function currentStoreCacheKey(): string {
  const config = readOpenReceiveConfigFile({
    cwd: process.cwd(),
    configPath: testOverrides?.configPath,
  });
  return JSON.stringify(config ?? {});
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
