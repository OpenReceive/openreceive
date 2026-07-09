# @openreceive/fastify

Fastify plugin for the OpenReceive shipped routes. A thin wrapper over
[`@openreceive/http`](../http).

```ts
import { createOpenReceive, openReceiveFastify } from "openreceive/fastify";
// or scoped: @openreceive/node + @openreceive/fastify

// 1. Price the order (create-checkout only)
const getCheckoutAmount = async ({ orderId }) => ({
  amount: { currency: "USD", value: await priceForOrder(orderId) },
});

// 2. Mount (add onPaid on createOpenReceive when you need fulfillment)
const service = await createOpenReceive();
await fastify.register(openReceiveFastify, {
  service,
  getCheckoutAmount,
  prefix: "/openreceive",
});
```

`getCheckoutAmount` is required. See `docs/guides/authorization.md` for auth
presets. Contributor route contract: `docs/internal/shipped-routes.md`.
