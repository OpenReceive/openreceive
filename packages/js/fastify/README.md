# @openreceive/fastify

Fastify plugin for the OpenReceive shipped routes. A thin wrapper over
[`@openreceive/http`](../http).

```ts
import Fastify from "fastify";
import { createOpenReceive, openReceiveFastify } from "openreceive/fastify";
import { guestCheckout } from "@openreceive/http";

const service = await createOpenReceive({ onPaid });
const fastify = Fastify();

await fastify.register(openReceiveFastify, {
  service,
  authorize: guestCheckout(),
  prepareCheckout: async ({ body }) => {
    const cart = validateCart(body);
    return { amount: { currency: "USD", value: cart.totalUsd }, summary: cart.summary };
  },
  prefix: "/openreceive",
});
```

`prepareCheckout` is required. See `docs/guides/authorization.md`.
