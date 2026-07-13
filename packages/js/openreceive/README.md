# openreceive

Umbrella package for OpenReceive: server, browser, UI frameworks, provider data,
contracts, and CLI.

## Happy path (Node + Express + React)

```sh
npm install openreceive @openreceive/express @openreceive/http express react react-dom
```

```ts
import { createOpenReceive, openReceiveExpress } from "openreceive/express";
import { createHostOrderStore } from "openreceive/node";
import { guestCheckout } from "@openreceive/http";
import { Checkout } from "openreceive/react";

const onPaid = async ({ orderId, checkoutId, metadata }) => {
  await fulfill({ orderId, checkoutId, metadata });
};

const service = await createOpenReceive({ onPaid });
const orders = createHostOrderStore(service.store);

app.use(
  openReceiveExpress({
    service,
    authorize: guestCheckout(),
    getCheckoutAmount: orders.createGetCheckoutAmount(),
  }),
);

// Your /prepare_order persists amount authority, then:
// <Checkout orderId={order.id} />
```

`getCheckoutAmount` is **required**. The create-checkout HTTP body never carries a
client price. See `docs/guides/quickstart-node.md` and
`docs/guides/authorization.md`.

## Subpath exports

| Import | Surface |
| --- | --- |
| `openreceive/node` | `@openreceive/node` (service, `startSweeper`, …) |
| `openreceive/express` | `createOpenReceive` + `openReceiveExpress` |
| `openreceive/fastify` | `createOpenReceive` + `openReceiveFastify` |
| `openreceive/next` | `createOpenReceive` + `openReceiveNextHandlers` |
| `openreceive/react` | `@openreceive/react` |
| `openreceive/vue` / `svelte` / `angular` / `elements` | UI packages |
| `openreceive/browser` | `@openreceive/browser` |
| `openreceive/provider-data` / `contracts` | shared data |

Express / Fastify / Next adapters are **optional peer dependencies** so a
browser-only or React-only install never pulls the server graph.
