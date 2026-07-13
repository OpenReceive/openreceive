# @openreceive/express

Express adapter for the OpenReceive shipped routes. A thin wrapper over
[`@openreceive/http`](../http); all routing, authorization, capability-token, and
error-mapping logic lives there.

```ts
import express from "express";
import { createOpenReceive, openReceiveExpress } from "openreceive/express";
import { guestCheckout } from "@openreceive/http";

const service = await createOpenReceive({
  onPaid: async ({ orderId, checkoutId, metadata }) => {
    await fulfill({ orderId, checkoutId, metadata });
  },
});

const app = express();
app.use(express.json());
app.use(
  openReceiveExpress({
    service,
    authorize: guestCheckout(),
    prepareCheckout: async ({ body }) => {
      const cart = validateCart(body);
      return {
        amount: { currency: "USD", value: cart.totalUsd },
        summary: cart.summary,
      };
    },
  }),
);
```

See `docs/guides/quickstart-node.md` for the full walkthrough and
`docs/guides/authorization.md` for auth presets and amount authority.
Contributor route contract: `docs/internal/shipped-routes.md`.
