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

const service = await createOpenReceive({ onPaid: fulfill });
app.use(openReceiveExpress({
  service,
  resolveOrder: async ({ orderId }) => {
    const order = await loadOrder(orderId);
    return order ? { usd: order.total_usd } : null;
  },
}));

// <Checkout orderId={order.id} />
```

`resolveOrder` is **required**. The create-checkout HTTP body never carries a
client price. See `docs/guides/quickstart-node.md` and `docs/guides/routes.md`.

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
