/**
 * ActionCable bridge (solid_cable on the Rails side — no Redis). The
 * notifications/reconciler worker containers settle orders out of band and
 * broadcast `{message, data}` envelopes on OrderChannel; this maps them onto
 * root-store actions. Polling remains the baseline — the cable push only makes
 * settlement instant. Same store action sinks both paths, so they are
 * idempotent together.
 */

import { type Consumer, createConsumer, type Subscription } from "@rails/actioncable";
import { reaction } from "mobx";
import { isHelloFruitDemoOrder } from "../../../../../../../shared/demo-order.ts";
// Import type only: the store must not depend on this helper at module load.
import type { ShopWorkspace } from "../stores/ShopWorkspace.ts";
import { logDemo } from "./logging.ts";

interface CableMessage {
  readonly message: string;
  readonly data: Record<string, unknown>;
}

declare global {
  interface Window {
    __helloFruitCableConsumer?: Consumer;
  }
}

const getConsumer = (): Consumer => {
  if (!window.__helloFruitCableConsumer) {
    window.__helloFruitCableConsumer = createConsumer();
  }
  return window.__helloFruitCableConsumer;
};

const handleMessage = (workspace: ShopWorkspace, payload: CableMessage): void => {
  if (!payload?.message) return;
  switch (payload.message) {
    case "order-update": {
      if (isHelloFruitDemoOrder(payload.data)) {
        logDemo("cable.order_update", "Order update pushed over ActionCable.", {
          orderId: payload.data.uuid,
          status: payload.data.status,
        });
        workspace.applyOrderUpdate(payload.data);
      }
      break;
    }
    default:
      console.warn("Unknown cable message:", payload);
  }
};

let subscription: Subscription | null = null;
let subscribedOrderId: string | null = null;

/**
 * Keep exactly one OrderChannel subscription, keyed to the order the payer is
 * looking at. A mobx reaction re-subscribes when the order changes and tears
 * down on start-over.
 */
export function startOrderActionCable(workspace: ShopWorkspace): void {
  reaction(
    () => workspace.order?.data.uuid,
    (orderId) => {
      if (orderId === subscribedOrderId) return;
      if (subscription !== null) {
        subscription.unsubscribe();
        subscription = null;
        subscribedOrderId = null;
      }
      if (orderId === undefined) return;
      subscribedOrderId = orderId;
      subscription = getConsumer().subscriptions.create(
        { channel: "OrderChannel", order_id: orderId },
        {
          received: (payload: CableMessage) => handleMessage(workspace, payload),
          rejected: () => {
            logDemo("cable.rejected", "OrderChannel subscription rejected.", { orderId });
            subscription = null;
            subscribedOrderId = null;
          },
        },
      );
      logDemo("cable.subscribed", "Subscribed to OrderChannel.", { orderId });
    },
    { fireImmediately: true },
  );
}
