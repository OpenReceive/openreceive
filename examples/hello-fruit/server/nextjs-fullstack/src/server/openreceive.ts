import { guestCheckout, type CreateOpenReceiveHttpHandlerOptions } from "@openreceive/http";
import {
  createOpenReceive,
  readOpenReceiveConfigFile,
} from "@openreceive/node";
import { helloFruitDeliveryFetchResponse } from "../../../../shared/demo-delivery.ts";
import { fulfillHelloFruitOrder } from "../../../../shared/demo-fulfillment.ts";
import {
  createHelloFruitDemoServerLogger,
  createHelloFruitOpenReceiveLogger,
} from "../../../../shared/demo-logging.ts";
import { createHelloFruitPrepareCheckout } from "../../../../shared/demo-prepare-checkout.ts";
import { helloFruitSharedFile } from "./shared-data.ts";

const DEMO_ID = "nextjs-fullstack";
const logDemo = createHelloFruitDemoServerLogger(DEMO_ID);
const STICKERS_DIR = helloFruitSharedFile("stickers");

interface HelloFruitOpenReceiveBundle {
  readonly openreceive: Awaited<ReturnType<typeof createOpenReceive>>;
}

interface NextDemoOpenReceiveCache {
  readonly storeCacheKey: string;
  readonly server: Promise<HelloFruitOpenReceiveBundle>;
}

let openreceiveCache: NextDemoOpenReceiveCache | undefined;

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

/** Gated post-pay sticker download (`GET /delivery/:orderId/:productId`). */
export async function deliveryResponse(
  request: Request,
  orderId: string,
  productId: string,
): Promise<Response> {
  const { openreceive: service } = await getOpenReceive();
  return helloFruitDeliveryFetchResponse({
    store: service.store,
    stickersDir: STICKERS_DIR,
    orderId,
    productId,
    request,
  });
}

async function getOpenReceive(): Promise<HelloFruitOpenReceiveBundle> {
  const storeCacheKey = currentStoreCacheKey();
  const cached = openreceiveCache;
  if (cached !== undefined && cached.storeCacheKey === storeCacheKey) {
    try {
      return await cached.server;
    } catch {
      if (openreceiveCache === cached) openreceiveCache = undefined;
    }
  }

  const nextServer = createHelloFruitOpenReceive();
  openreceiveCache = {
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

async function createHelloFruitOpenReceive(): Promise<HelloFruitOpenReceiveBundle> {
  // Same shape as docs/guides/quickstart-node.md:
  // createOpenReceive({ onPaid }) — Next mounts via openReceiveNextHandlers + openReceiveHttpOptions.
  // onPaid may fire more than once — fulfillHelloFruitOrder dedupes on checkoutId.
  // NWC + price currencies come from openreceive.yml (defaults: local-sqlite, USD).
  let service: Awaited<ReturnType<typeof createOpenReceive>>;
  service = await createOpenReceive({
    logger: createHelloFruitOpenReceiveLogger(DEMO_ID),
    onPaid: async ({ orderId, checkoutId }) => {
      const result = await fulfillHelloFruitOrder({
        store: service.store,
        orderId,
        checkoutId,
      });
      logDemo("openreceive.on_paid", "Checkout settled — order fulfillment ran.", {
        orderId,
        checkoutId,
        fulfilled: result.fulfilled,
        ...(result.fulfilled ? {} : { reason: result.reason }),
      });
    },
  });
  return { openreceive: service };
}

function currentStoreCacheKey(): string {
  const config = readOpenReceiveConfigFile({
    cwd: process.cwd(),
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
