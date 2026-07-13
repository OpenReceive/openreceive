# openreceive

Umbrella package for OpenReceive: server, browser, UI frameworks, provider data,
contracts, and CLI.

## Happy path (Node + Express + React)

```sh
npm install openreceive @openreceive/express @openreceive/http express react react-dom
```

```ts
import { createOpenReceive, openReceiveExpress } from "openreceive/express";
import { guestCheckout } from "@openreceive/http";
import { Checkout } from "openreceive/react";

const service = await createOpenReceive({
  onPaid: async ({ orderId, checkoutId, metadata }) => {
    await fulfill({ orderId, checkoutId, metadata });
  },
});

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

// Browser: POST /openreceive/prepare → then
// <Checkout orderId={orderId} onSummary={…} onSettled={…} />
```

`prepareCheckout` is **required**. POST `/prepare` is the sole price authority;
the create-checkout HTTP body never carries a client price. See
`docs/guides/quickstart-node.md` and `docs/guides/authorization.md`.
