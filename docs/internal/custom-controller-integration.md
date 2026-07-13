# Custom Controller Integration

**99% of apps should mount the shipped routes** — see the
[Node](../guides/quickstart-node.md) / [Rails](../guides/quickstart-rails.md)
quickstarts and [Authorization](../guides/authorization.md).

Use this escape hatch only when you create a checkout server-side and pass the
snapshot into `<Checkout checkout={…} />`, or when you must own the HTTP surface
yourself. Prefer `openReceiveExpress` / `createOpenReceiveHttpHandler` /
`openReceiveNextHandlers` so you do not hand-write a multiplexer.

OpenReceive performs no authentication on service method calls. Treat
`order_id` and `attempt_id` as non-secret identifiers, not capabilities —
authorize the caller in your route before calling the service. Amounts you pass
to `getOrCreateCheckout` are trusted because they come from your server, not
from a public create body. The mounted create route never trusts a client price.

## Service method surface

| Method | Job |
| --- | --- |
| `getOrCreateCheckout` | Create / reuse / renew a priced checkout under your order id |
| `getOrder` | Refresh settlement + read stored order |
| `getCheckout` | Read one checkout by id |
| `swapOptions` / `swapQuote` / `startSwap` / `refundSwap` | Swap actions |
| `sweepPendingInvoices` | Explicit global settlement sweep |
| `listRates` / `quoteRates` | Fiat quotes |

Wire fields stay snake_case on HTTP; the JS SDK is camelCase. Full signatures:
[API Reference](../guides/api-reference.md). Route contract:
[Shipped Routes](shipped-routes.md).

## Express: create + order multiplexer

```ts
import express from "express";
import { createOpenReceive, OpenReceiveServiceError } from "@openreceive/node";

const checkoutRoutes = express.Router();
checkoutRoutes.use(express.json());

const openreceive = await createOpenReceive({
  onPaid: async ({ orderId }) => {
    await markOrderPaidInYourApp(orderId);
  }
});

// Your app's order route — not OpenReceive's create-checkout HTTP body.
checkoutRoutes.post("/create_order", async (req, res, next) => {
  try {
    const order = await createOrderFromCart(req.user, req.body.cart);
    const checkout = await openreceive.getOrCreateCheckout({
      orderId: order.uuid,
      amount: { currency: "USD", value: order.total_amount.value },
      memo: `Order ${order.number}`
    });
    res.status(201).json({ order, checkout });
  } catch (error) {
    if (error instanceof OpenReceiveServiceError) {
      res.status(error.status).json(error.body);
      return;
    }
    next(error);
  }
});

checkoutRoutes.post("/order", async (req, res, next) => {
  try {
    // Authorize the caller for req.body.order_id here (session or ownership
    // check) before calling the service. order_id is an identifier, not a capability.
    const orderId = req.body.order_id;
    const action = req.body.action ?? "status";
    if (action === "status") {
      const order = await openreceive.getOrder({ orderId });
      const swap = await openreceive.swapOptions({ orderId });
      res.json({
        ...order,
        swapsEnabled: swap.enabled,
        swapPayOptions: swap.enabled ? swap.options : [],
      });
      return;
    }
    if (action === "swap_quote") {
      res.json({
        quote: await openreceive.swapQuote({
          orderId,
          payInAsset: req.body.pay_in_asset,
        }),
      });
      return;
    }
    if (action === "start_swap") {
      res.json({
        attempt: await openreceive.startSwap({
          orderId,
          payInAsset: req.body.pay_in_asset,
        }),
      });
      return;
    }
    if (action === "refund_swap") {
      res.json({
        attempt: await openreceive.refundSwap({
          attemptId: req.body.attempt_id,
          refundAddress: req.body.refund_address,
          refundNonce: req.body.refund_nonce,
          confirm: req.body.confirm === true,
        }),
      });
      return;
    }
    res.status(400).json({
      code: "INVALID_REQUEST",
      message: 'Unknown order action. Expected "status", "swap_quote", "start_swap", or "refund_swap".',
    });
  } catch (error) {
    if (error instanceof OpenReceiveServiceError) {
      res.status(error.status).json(error.body);
      return;
    }
    next(error);
  }
});
```

Point the checkout element at your route with `order-url` / `orderUrl`:

```html
<openreceive-checkout order-id="order_123" order-url="/order"></openreceive-checkout>
```

## Next.js: server-side create

```ts
// app/create_order/route.ts
import { createOpenReceive, OpenReceiveServiceError } from "@openreceive/node";

export const runtime = "nodejs";

const openreceiveReady = createOpenReceive({
  onPaid: async ({ orderId }) => {
    await markOrderPaidInYourApp(orderId);
  }
});

export async function POST(request: Request) {
  const openreceive = await openreceiveReady;

  try {
    const body = await request.json();
    const order = await createOrderFromCart(body.cart);
    const checkout = await openreceive.getOrCreateCheckout({
      orderId: order.uuid,
      amount: { currency: "USD", value: order.total_amount.value },
      memo: `Order ${order.number}`
    });
    return Response.json({ order, checkout }, { status: 201 });
  } catch (error) {
    if (error instanceof OpenReceiveServiceError) {
      return Response.json(error.body, { status: error.status });
    }
    throw error;
  }
}
```

For App Router mounts of the shipped routes, use
`openReceiveNextHandlers({ service, prepareCheckout })` under
`app/openreceive/[...openreceive]/route.ts` — see the
[Node Quickstart](../guides/quickstart-node.md).

## Swap actions on a custom route

When you own the route, the HTTP `action` maps to service methods the same way
the shipped handler does; an unrecognized `action` is rejected with 400:

| `action` (HTTP) | routes to | returns |
| --- | --- | --- |
| omitted / `"status"` | `getOrder` + `swapOptions` | order + `swaps_enabled` + `swap_pay_options` |
| `"swap_quote"` | `swapQuote` | `{ quote }` |
| `"start_swap"` | `startSwap` | `{ attempt }` |
| `"refund_swap"` | `refundSwap` | `{ attempt }` |

`startSwap` and `refundSwap` return a first-class `SwapAttempt`: deposit fields
are top-level; the backing shadow Lightning invoice is `shadowInvoice`. Refunds
target `attemptId`, not order id plus asset. Operator lifecycle detail:
[Swap Operations](swap-operations.md).

## Checkout component snapshot mode

```tsx
<Checkout
  checkout={checkout}
  orderUrl="/order"
  onSettled={() => showThankYou()}
/>
```

`orderUrl` is optional. Apps without a status route can render a static surface
with `polling={false}`. See [Frontend Checkout](../guides/frontend-checkout.md).
