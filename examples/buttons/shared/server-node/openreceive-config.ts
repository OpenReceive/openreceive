/**
 * THE THREE HOOKS. The whole bridge between the engine and this application's
 * data, mirroring config/initializers/openreceive.rb line for line.
 *
 * OpenReceive never sees an order, a product, a visitor, the cart or the
 * download. If a future change to this demo needs a fourth hook, that is a
 * signal the boundary moved, and it is worth stopping over.
 */

import type { Authorize } from "@openreceive/http";
import type { CreateOpenReceiveOptions } from "@openreceive/node";
import type { PaymentSettlement } from "@openreceive/http";
import { visitorIdFrom } from "./shop-routes.ts";
import {
  checkoutDescription,
  claimShopOrderPaid,
  formatAmount,
  type ShopStore,
} from "./store.ts";

/**
 * Non-secret service settings, shared by the three Node stacks.
 *
 * Credentials do not belong here: NWC_URI, LSC_URI_PRIMARY and LSC_URI_BACKUP
 * come from the process environment.
 */
export const config = {
  priceCurrencies: ["USD"],
  logging: {
    enabled: true,
    directory: "./logs",
    filename: "openreceive.log",
    maxFileSizeMb: 10,
    maxFiles: 5,
  },
} satisfies Pick<CreateOpenReceiveOptions, "priceCurrencies" | "logging">;

/**
 * THE HOST AUTHORIZES EVERY REQUEST; OpenReceive mints no tokens.
 *
 * Runs on every engine route: checkout.prepare/create, payment.check and
 * swap.quote/create/read/refund. Return true to allow, false for a 403.
 *
 * This shop's policy: an order id is a uuid, so it is not enumerable — but it
 * travels in every request body the payer's browser sends, so possession of one
 * is a CLAIM, not proof. The order has to belong to THIS browser, which is the
 * same check the shop's own routes make.
 *
 * The cookie is read straight off the request and verified against the app
 * secret. A tampered value fails the signature and reads as absent, which lands
 * in the same `false` as a missing one.
 */
export const createShopAuthorize = (store: ShopStore, secret: string): Authorize =>
  ({ request, resource }) => {
    const record = store.orderByReference(resource.reference);
    if (record === null) return false;

    const visitorId = visitorIdFrom(request.headers.get("cookie") ?? undefined, secret);
    return visitorId !== undefined && record.order.shop_user_id === visitorId;
  };

/**
 * The price for a reference — here the order id — read from OUR OWN ROW.
 * Nothing a payer sends can reach this number: the create body cannot carry an
 * amount at all. `null` means there is nothing to pay for (a 404).
 *
 * `value` is a decimal STRING formatted from integer cents. Never a float.
 *
 * `description` beside the price is what the payer is BUYING, in our own
 * words — the one display string the checkout renders above the amount.
 * Without it the payer sees a QR code and "$4.00" and no sign of what the four
 * dollars is for.
 */
export const createShopAmountFor =
  (store: ShopStore) =>
  (reference: string) => {
    const record = store.orderByReference(reference);
    if (record === null) return null;

    return {
      currency: record.order.currency,
      value: formatAmount(record.order.total_cents),
      description: checkoutDescription(record),
    };
  };

/**
 * Runs INSIDE the settlement transaction, only for the order's first settled
 * attempt.
 *
 * Across every settlement path OpenReceive owns (wallet notifications, the
 * opportunistic reconcile pass, an explicit reconcile job) this runs AT MOST
 * ONCE per reference. What OpenReceive cannot see is a second fulfillment path
 * of OURS, so the transition is still the guarded conditional UPDATE in
 * `claimShopOrderPaid` — the WHERE clause is the lock.
 *
 * Fulfillment for a virtual product: flipping the order to `paid` IS the
 * delivery, because the download handler serves the artwork only from a paid
 * row.
 *
 * DATABASE WRITES ONLY. An email, a webhook or a push sent from here would
 * survive a rollback: the payer's browser would be told about an order that no
 * longer exists. `settlement.query` is used rather than the store's own
 * connection precisely so the order transition and the payment record commit
 * together.
 */
export const createShopOnPaid =
  (log: (event: string, message: string, fields?: Record<string, unknown>) => void) =>
  async (settlement: PaymentSettlement): Promise<void> => {
    const claimed = await claimShopOrderPaid({
      reference: settlement.reference,
      paidAt: settlement.paidAt,
      paymentHash: settlement.paymentHash,
      query: settlement.query,
    });
    if (!claimed) return;

    log("openreceive.on_paid", "Checkout settled — the order is paid and its downloads unlocked.", {
      reference: settlement.reference,
      paymentHash: settlement.paymentHash,
    });
  };
