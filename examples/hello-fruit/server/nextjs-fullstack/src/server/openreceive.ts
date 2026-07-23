import {
  createOpenReceivePaymentHooks,
  type CreateOpenReceiveHttpHandlerOptions,
} from "@openreceive/http";
import { createOpenReceive } from "@openreceive/node";
import { openReceiveConfig } from "../../../../../../config/openreceive.ts";
import { helloFruitDeliveryFetchResponse } from "../../../../shared/demo-delivery.ts";
import { fulfillHelloFruitOrder } from "../../../../shared/demo-fulfillment.ts";
import {
  createHelloFruitDemoServerLogger,
  createHelloFruitOpenReceiveLogger,
} from "../../../../shared/demo-logging.ts";
import { createHelloFruitCreateOrderResult } from "../../../../shared/demo-prepare-checkout.ts";
import {
  createHelloFruitHostOrder,
  helloFruitPaymentRepository,
  readHelloFruitHostOrder,
} from "../../../../shared/openreceive-store.ts";
import { helloFruitSharedFile } from "./shared-data.ts";

const DEMO_ID = "nextjs-fullstack";
const logDemo = createHelloFruitDemoServerLogger(DEMO_ID);
const STICKERS_DIR = helloFruitSharedFile("stickers");

let servicePromise: Promise<Awaited<ReturnType<typeof createOpenReceive>>> | undefined;

export async function openReceiveHttpOptions(): Promise<CreateOpenReceiveHttpHandlerOptions> {
  const service = await getOpenReceive();
  const paymentHooks = createOpenReceivePaymentHooks({
    loadOrder: (orderId) => readHelloFruitHostOrder(orderId),
    amountForOrder: (order) => order.amount,
    payments: helloFruitPaymentRepository,
  });
  return {
    service,
    authorize: ({ resource }) =>
      resource.order_id !== undefined && readHelloFruitHostOrder(resource.order_id) !== null,
    resolveCheckout: paymentHooks.resolveCheckout,
    onCheckoutCreated: paymentHooks.onCheckoutCreated,
  };
}

export async function createOrderResponse(request: Request): Promise<Response> {
  try {
    const service = await getOpenReceive();
    const result = await createHelloFruitCreateOrderResult(await request.json(), {
      demoId: DEMO_ID,
      demoName: "Next.js",
      openreceive: service,
    });
    createHelloFruitHostOrder(result.order, result.invoiceRequest.amount);
    return jsonResponse({ order_id: result.order.uuid, summary: result.order }, 201);
  } catch (error) {
    return jsonResponse(
      { message: error instanceof Error ? error.message : "Invalid order." },
      400,
    );
  }
}

export function readOrderResponse(orderId: string): Response {
  const order = readHelloFruitHostOrder(orderId);
  return order === null
    ? jsonResponse({ message: "Order not found." }, 404)
    : jsonResponse(order.summary);
}

export async function ratesResponse(): Promise<Response> {
  return jsonResponse({ rates: await (await getOpenReceive()).listRates() });
}

export async function deliveryResponse(
  request: Request,
  orderId: string,
  productId: string,
): Promise<Response> {
  return helloFruitDeliveryFetchResponse({
    stickersDir: STICKERS_DIR,
    orderId,
    productId,
    request,
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
  return await createOpenReceive({
    ...openReceiveConfig,
    logger: createHelloFruitOpenReceiveLogger(DEMO_ID),
    onPaid: async ({ paymentHash, paidAt }) => {
      const result = await fulfillHelloFruitOrder({ paymentHash, paidAt });
      logDemo("openreceive.on_paid", "Verified payment marked host order paid.", {
        paymentHash,
        orderId: result.orderId,
        fulfilled: result.fulfilled,
      });
    },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
  });
}
