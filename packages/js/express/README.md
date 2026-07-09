# @openreceive/express

Express adapter for the OpenReceive shipped routes. A thin wrapper over
[`@openreceive/http`](../http); all routing, authorization, capability-token, and
error-mapping logic lives there.

```ts
import express from "express";
import { createOpenReceive, openReceiveExpress } from "openreceive/express";
// or scoped: @openreceive/node + @openreceive/express

const service = await createOpenReceive();
const app = express();
app.use(express.json());
app.use(
  openReceiveExpress({
    service,
    // Required — create-checkout never trusts a client price.
    resolveOrder: async ({ orderId }) => {
      const order = await loadOrder(orderId);
      return order ? { usd: order.total_usd } : null;
    },
  }),
);
```

See `docs/guides/routes.md` for the route contract, tiers, and capability tokens.
