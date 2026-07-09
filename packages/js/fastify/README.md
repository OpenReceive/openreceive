# @openreceive/fastify

Fastify plugin for the OpenReceive shipped routes. A thin wrapper over
[`@openreceive/http`](../http).

```ts
import { openReceiveFastify } from "@openreceive/fastify";
await fastify.register(openReceiveFastify, {
  service, authorize, getOrderAmount, prefix: "/openreceive",
});
```

See `docs/guides/routes.md` for the route contract, tiers, and capability tokens.
