# Settlement Sweeps

OpenReceive settles invoices by running a server-side sweep over your receive
wallet's incoming transactions. A sweep calls `list_transactions` with
`unpaid: true`, checks one bounded page, matches transactions to stored invoices
by `payment_hash`, and runs your backend `onPaid` hook after wallet-verified
settlement.

The sweep is global. It is not limited to the order that triggered it. If User A
creates an invoice, closes the browser, and then pays, User A no longer has a
frontend polling the order. Later, User B creates a checkout or checks User B's
own order status. That action calls OpenReceive on your server, the global sweep
advances, and if User A's settled transaction is in the scanned page,
OpenReceive settles User A's stored invoice and runs `onPaid` for User A.

The browser never needs the receive-only NWC code for this. The wallet scan,
settlement decision, and fulfillment hook all stay on your backend.

## Automatic Triggers

OpenReceive advances sweeps from normal app traffic:

- `getOrder(...)` awaits one sweep before returning the requested order.
- `getOrCreateCheckout(...)` schedule a best-effort
  sweep after creating an invoice.
- `sweepPendingInvoices()` lets your backend ask for one sweep directly.

All three paths share the same durable global gate. Calling the sweep often is
safe: rapid calls collapse to at most one real wallet scan per configured
interval.

## Low-Traffic Sites

Organic traffic is enough for many demos and active stores. It can be risky for
a low-traffic website with high-value orders.

The risk is simple: User A pays an invoice after closing the browser, then no
other visitor, admin, cron, worker, or app route calls OpenReceive for 48 hours.
During that quiet period, no new sweep runs, so your `onPaid` hook does not run
until something touches OpenReceive again.

For high-value or operationally sensitive orders, add one of these drivers:

1. Call `sweepPendingInvoices()` when loading an admin page, order dashboard, or
   internal order-tracking screen.
2. Run a background task that calls `sweepPendingInvoices()` every few seconds.

These do not replace app-owned order authorization or idempotent fulfillment.
They only make sure settlement discovery does not depend on shopper traffic.

## Admin Page Example

If your admin order dashboard already loads server-side data, run one sweep
before reading the orders you display:

```ts
export async function adminOrders(req, res) {
  await requireAdmin(req);

  await openreceive.sweepPendingInvoices();

  const orders = await loadOrdersForAdmin();
  res.json({ orders });
}
```

The method is globally gated, so refreshing the admin page repeatedly does not
fan out one wallet request per order.

## Background Task Example

On a long-lived Node process, prefer the opt-in helper (keeps the interval out of
adapters and off serverless):

```ts
import { startSweeper } from "@openreceive/node";
// or: import { startSweeper } from "openreceive/node";

const sweeper = startSweeper(openreceive, { intervalMs: 3000 });
// on shutdown:
sweeper.stop();
```

A bare interval is equivalent:

```ts
setInterval(() => {
  void openreceive.sweepPendingInvoices();
}, 3000);
```

Do **not** hide a sweeper inside every adapter by default — organic traffic already
covers the tab-close case, and serverless / Next have no long-lived process.

On serverless platforms, use the platform's cron, scheduled function, queue, or
worker mechanism. The job should call your server-side OpenReceive instance and
must keep the receive-only NWC code out of browser code.

## What To Expect

When the open transaction window fits in one page, a payment is usually noticed
on the next trigger. When the window spans multiple pages, settlement is found
within a full global cursor cycle. OpenReceive intentionally avoids doing one
targeted wallet call per invoice, because that would turn user traffic into
wallet request fan-out.

`onPaid` is at-least-once. Your fulfillment should dedupe by checkout id or your
own order id.
