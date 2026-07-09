# @openreceive/next

Next.js App Router handlers for the OpenReceive shipped routes. A thin pass-through over
[`@openreceive/http`](../http) (Next route handlers already speak Web Request/Response).

```ts
// app/openreceive/[...openreceive]/route.ts
import { createOpenReceive, openReceiveNextHandlers } from "openreceive/next";
// or scoped: @openreceive/node + @openreceive/next

const service = await createOpenReceive();
export const { GET, POST } = openReceiveNextHandlers({
  service,
  resolveOrder: async ({ orderId }) => ({ usd: await priceForOrder(orderId) }),
});
```

`resolveOrder` is required. See `docs/guides/routes.md` for the route contract, tiers, and
capability tokens.
