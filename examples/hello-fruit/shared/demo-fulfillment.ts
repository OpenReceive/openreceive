/** Host fulfillment is a write-once transition keyed only by payment_hash. */

import { markHelloFruitPaid } from "./openreceive-store.ts";

export async function fulfillHelloFruitOrder(input: {
  readonly paymentHash: string;
  readonly paidAt: number;
}): Promise<{ readonly fulfilled: boolean; readonly orderId?: string }> {
  const order = markHelloFruitPaid(input.paymentHash, input.paidAt);
  return order === null
    ? { fulfilled: false }
    : { fulfilled: true, orderId: order.summary.uuid };
}
