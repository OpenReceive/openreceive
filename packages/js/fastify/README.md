# @openreceive/fastify

Fastify plugin for the OpenReceive shipped routes. A thin wrapper over
[`@openreceive/http`](../http).

```ts
import { createOpenReceive, openReceiveFastify } from "openreceive/fastify";
// or scoped: @openreceive/node + @openreceive/fastify

const service = await createOpenReceive();
await fastify.register(openReceiveFastify, {
  service,
  resolveOrder: async ({ orderId }) => ({ usd: await priceForOrder(orderId) }),
  prefix: "/openreceive",
});
```

`resolveOrder` is required. See `docs/guides/routes.md` for the route contract, tiers, and
capability tokens.
