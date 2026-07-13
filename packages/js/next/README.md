# @openreceive/next

Next.js App Router handlers for the OpenReceive shipped routes. A thin pass-through over
[`@openreceive/http`](../http) (Next route handlers already speak Web Request/Response).

```ts
// app/openreceive/[...openreceive]/route.ts
import { createOpenReceive, openReceiveNextHandlers } from "openreceive/next";

const prepareCheckout = async ({ body }) => {
  const cart = validateCart(body);
  return {
    amount: { currency: "USD", value: cart.totalUsd },
    summary: cart.summary,
  };
};

const service = await createOpenReceive({ onPaid });
export const { GET, POST } = openReceiveNextHandlers({
  service,
  prepareCheckout,
});
```

`prepareCheckout` is required. See `docs/guides/authorization.md` for auth
presets. Contributor route contract: `docs/internal/shipped-routes.md`.
