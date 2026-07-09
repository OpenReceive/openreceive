# @openreceive/express

Express adapter for the OpenReceive shipped routes. A thin wrapper over
[`@openreceive/http`](../http); all routing, authorization, capability-token, and
error-mapping logic lives there.

```ts
import express from "express";
import { createOpenReceive, openReceiveExpress } from "openreceive/express";
// or scoped: @openreceive/node + @openreceive/express

// 1. Price the order (create-checkout only — never trusts a client price)
const getCheckoutAmount = async ({ orderId }) => {
  const order = await loadOrder(orderId);
  if (!order) return null; // → 404
  return { amount: { currency: "USD", value: order.total_usd } };
};

// 2. Handle payment (optional — settlement → your fulfillment)
const service = await createOpenReceive({
  onPaid: async ({ orderId, checkoutId, metadata }) => {
    await fulfill({ orderId, checkoutId, metadata });
  },
});

// 3. Mount
const app = express();
app.use(express.json());
app.use(openReceiveExpress({ service, getCheckoutAmount }));
```

See `docs/guides/authorization.md` for auth presets and amount authority.
Contributor route contract: `docs/internal/shipped-routes.md`.
