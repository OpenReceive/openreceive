import {
  createOpenReceiveHost,
  mapHostRouteError,
  type CreateOpenReceiveHttpHandlerOptions,
  type OpenReceiveHost,
  type OpenReceiveOrderSettlement,
} from "@openreceive/http";
import { createOpenReceive } from "@openreceive/node";
import { openReceiveConfig } from "../../../../../../config/openreceive.ts";
import { helloFruitDeliveryFetchResponse } from "../../../../shared/demo-delivery.ts";
import { createHelloFruitDemoServerLogger } from "../../../../shared/demo-logging.ts";
import { readRequiredHelloFruitNwcConnectionString } from "../../../../shared/demo-nwc.ts";
import { createHelloFruitCreateOrderResult } from "../../../../shared/demo-prepare-checkout.ts";
import {
  bootHelloFruitHostStore,
  createHelloFruitHostOrder,
  helloFruitHostDb,
  markHelloFruitOrderPaid,
  readHelloFruitHostOrder,
} from "../../../../shared/openreceive-store.ts";
import { helloFruitSharedFile } from "./shared-data.ts";

const DEMO_ID = "nextjs-fullstack";
const logDemo = createHelloFruitDemoServerLogger(DEMO_ID);
const STICKERS_DIR = helloFruitSharedFile("stickers");

let servicePromise: Promise<Awaited<ReturnType<typeof createOpenReceive>>> | undefined;
let storePromise: Promise<string> | undefined;
let hostPromise: Promise<OpenReceiveHost> | undefined;

async function ensureHostStore(): Promise<void> {
  storePromise ??= bootHelloFruitHostStore({ demoId: DEMO_ID, log: logDemo });
  await storePromise;
}

export async function openReceiveHttpOptions(): Promise<CreateOpenReceiveHttpHandlerOptions> {
  const [service, host] = await Promise.all([getOpenReceive(), getHost()]);
  return {
    service,
    authorize: ({ resource }) =>
      resource.orderId !== undefined && readHelloFruitHostOrder(resource.orderId) !== null,
    host,
  };
}

export async function createOrderResponse(request: Request): Promise<Response> {
  try {
    await ensureHostStore();
    const service = await getOpenReceive();
    const result = await createHelloFruitCreateOrderResult(await request.json(), {
      demoId: DEMO_ID,
      demoName: "Next.js",
      openreceive: service,
    });
    createHelloFruitHostOrder(
      result.order,
      result.invoiceRequest.amount,
      result.invoiceRequest.memo,
    );
    return jsonResponse({ order_id: result.order.uuid, summary: result.order }, 201);
  } catch (error) {
    // `hostError` and service errors already carry a payer-facing status/code;
    // only genuinely unrecognized failures collapse to a plain 400.
    const mapped = mapHostRouteError(error);
    if (mapped !== null) return jsonResponse(mapped.body, mapped.status);
    return jsonResponse(
      { message: error instanceof Error ? error.message : "Invalid order." },
      400,
    );
  }
}

export async function readOrderResponse(orderId: string): Promise<Response> {
  await ensureHostStore();
  const order = readHelloFruitHostOrder(orderId);
  return order === null
    ? jsonResponse({ message: "Order not found." }, 404)
    : jsonResponse(order.summary);
}

export async function ratesResponse(): Promise<Response> {
  return jsonResponse({ rates: await (await getOpenReceive()).listRates() });
}

export async function deliveryResponse(orderId: string, productId: string): Promise<Response> {
  await ensureHostStore();
  return helloFruitDeliveryFetchResponse({
    stickersDir: STICKERS_DIR,
    orderId,
    productId,
  });
}

async function getOpenReceive() {
  servicePromise ??= createHelloFruitOpenReceive();
  try {
    return await servicePromise;
  } catch (error) {
    servicePromise = undefined;
    throw error;
  }
}

async function createHelloFruitOpenReceive() {
  // Boot refuses missing/invalid NWC; createOpenReceive then loads the NIP-47 info event.
  const nwc = readRequiredHelloFruitNwcConnectionString();
  const service = await createOpenReceive({
    ...openReceiveConfig,
    nwc,
  });
  logDemo("openreceive.ready", "OpenReceive service ready.", {
    priceCurrencies: service.priceCurrencies,
  });
  return service;
}

async function getHost(): Promise<OpenReceiveHost> {
  hostPromise ??= createHelloFruitHost();
  try {
    return await hostPromise;
  } catch (error) {
    hostPromise = undefined;
    throw error;
  }
}

async function createHelloFruitHost(): Promise<OpenReceiveHost> {
  await ensureHostStore();
  const service = await getOpenReceive();
  const host = createOpenReceiveHost({
    db: helloFruitHostDb(),
    loadOrder: (orderId) => readHelloFruitHostOrder(orderId),
    amountForOrder: (order) => order.amount,
    onPaid: settleHelloFruitPayment,
  });

  // No background reconciler (there is no long-lived process to own one on
  // serverless): any OpenReceive call runs the durably gated opportunistic
  // reconcile, so restarts and payers who close the page settle on the next
  // call that wins the gate.
  const shutdown = async () => {
    await service.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return host;
}

// Runs inside the settlement transaction, only for the order's first settled attempt.
async function settleHelloFruitPayment(settlement: OpenReceiveOrderSettlement) {
  await markHelloFruitOrderPaid(settlement);
  logDemo("openreceive.on_paid", "Verified payment marked host order paid.", {
    paymentHash: settlement.paymentHash,
    orderId: settlement.orderId,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
  });
}
