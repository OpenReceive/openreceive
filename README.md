# OpenReceive

OpenReceive is a storage-free receive-checkout toolkit for Nostr Wallet Connect. It creates
Lightning invoices, verifies settlement, and drives optional swap-provider workflows. Your
application owns orders and payment records.

There is no OpenReceive database, Redis instance, migration, table, storage adapter, or
durable worker state to configure.

## The host contract

Add two fields to the order model you already have:

```text
payment_hash  nullable, unique
paid_at       nullable timestamp
```

For swaps, optionally add one opaque `openreceive_swap_recovery_token` field. The required
sequence is:

1. Your app creates/prices its order.
2. OpenReceive creates a checkout for that exact amount.
3. Your app stores `payment_hash` before returning the checkout to the payer.
4. OpenReceive verifies wallet settlement and calls `onPaid` at least once.
5. Your app finds the order by `payment_hash` and sets `paid_at` only when it is null.

The order row is also the invoice-creation idempotency guard. Concurrent/retried create calls
must converge on that row; never display an invoice whose hash the host did not commit.

## Direct Node API

```ts
import { createOpenReceive } from "@openreceive/node";

const openreceive = await createOpenReceive({
  nwc: process.env.OPENRECEIVE_NWC,
  tokenKeys: [{ id: "2026-07", key: process.env.OPENRECEIVE_TOKEN_KEY }],
  onPaid: async ({ paymentHash, paidAt }) => {
    await orders.markPaidOnce({ paymentHash, paidAt });
  },
});

const existing = order.paymentHash
  ? await openreceive.recoverCheckout({ orderId: order.id, paymentHash: order.paymentHash })
  : null;

if (existing) return existing;

const checkout = await openreceive.createCheckout({
  orderId: order.id,
  amount: { currency: "USD", value: order.total.toString() },
});

if (!(await orders.storePaymentHashIfEmpty(order.id, checkout.paymentHash))) {
  throw new Error("Concurrent checkout won; retry without exposing this invoice.");
}
return checkout;
```

`checkPayment({ paymentHash })` verifies a known order. `reconcilePayments` checks unresolved
host rows, and `watchPayments({ onPaid })` scans overlapping NIP-47 creation-time windows and
delivers verified settlements at least once.

## Mounted HTTP routes

Browser integrations mount `@openreceive/http` through Express, Fastify, Next, or Rails. A
create request never supplies its own amount; the required host hook resolves it from the
order:

```ts
app.use(openReceiveExpress({
  service: openreceive,
  authorize: createDefaultAuthorize(),
  resolveCheckoutAmount: async ({ orderId }) => {
    const order = await orders.find(orderId);
    if (!order) throw hostError("Order not found.", 404, "NOT_FOUND");
    return {
      amount: { currency: order.currency, value: order.total.toString() },
      ...(order.paymentHash ? { paymentHash: order.paymentHash } : {}),
      ...(order.swapRecoveryToken ? { swapRecoveryToken: order.swapRecoveryToken } : {}),
    };
  },
  onCheckoutCreated: async ({ orderId, paymentHash, swapRecoveryToken }) => {
    await orders.commitPaymentAttempt({ orderId, paymentHash, swapRecoveryToken });
  },
}));
```

`onCheckoutCreated` completes before the payer receives the invoice. A failed host write gets
a 409 response with no payer instructions.

## Settlement and swaps

Wallet notifications only wake reconciliation. Final settlement requires `settled_at` or a
wallet transaction state of `settled`; a preimage alone is insufficient.

Swap recovery is independent of wallet settlement. The payment hash proves that the merchant
wallet was paid. The opaque recovery token contains authenticated encrypted provider workflow
credentials so an unresolved swap can be queried after restart. Refund calls refresh provider
state and require a short-lived confirmation token.

See [the Node quickstart](docs/guides/quickstart-node.md), [Rails quickstart](docs/guides/quickstart-rails.md),
and the normative [HTTP contract](spec/openapi/openreceive-http.v1.yaml).
