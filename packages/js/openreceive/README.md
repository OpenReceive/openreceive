# openreceive

Umbrella package for OpenReceive: server, browser, UI frameworks, provider data,
contracts, and CLI.

## Happy path (Node + Express + React)

```sh
npm install openreceive @openreceive/express express react react-dom
```

```ts
import { createOpenReceive, openReceiveExpress } from "openreceive/express";
import { Checkout } from "openreceive/react";

// 1. Price the order (create-checkout only — never trusts a client price)
const getCheckoutAmount = async ({ orderId }) => {
  const order = await loadOrder(orderId);
  if (!order) return null; // → 404
  return { amount: { currency: "USD", value: order.total_usd } };
};

// 2. Handle payment (settlement → your fulfillment)
const onPaid = async ({ orderId, checkoutId, metadata }) => {
  await fulfill({ orderId, checkoutId, metadata });
};

// 3. Mount
const service = await createOpenReceive({ onPaid });
app.use(openReceiveExpress({ service, getCheckoutAmount }));

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
