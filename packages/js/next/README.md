# @openreceive/next

Next.js App Router handlers for the OpenReceive shipped routes. A thin pass-through over
[`@openreceive/http`](../http) (Next route handlers already speak Web Request/Response).

```ts
// app/openreceive/[...openreceive]/route.ts
import { createOpenReceive, openReceiveNextHandlers } from "openreceive/next";
// or scoped: @openreceive/node + @openreceive/next

// 1. Price the order (create-checkout only)
const getCheckoutAmount = async ({ orderId }) => ({
  amount: { currency: "USD", value: await priceForOrder(orderId) },
});

// 2. Mount (add onPaid on createOpenReceive when you need fulfillment)
const service = await createOpenReceive();
export const { GET, POST } = openReceiveNextHandlers({
  service,
  getCheckoutAmount,
});
```

`getCheckoutAmount` is required. See `docs/guides/authorization.md` for auth
presets. Contributor route contract: `docs/internal/shipped-routes.md`.
