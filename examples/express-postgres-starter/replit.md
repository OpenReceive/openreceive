# OpenReceive shop

A one-product shop on Express and Postgres that takes bitcoin over Lightning
with OpenReceive. Payments go straight to the owner's own wallet. Optional
swaps let customers pay with USDT, USDC, SOL and ETH; a swap provider converts
them to BTC over Lightning into the same wallet.

## Layout

- `server.js`: pages, order creation, and the payment routes under
  `/openreceive` (`openReceiveExpress`).
- `lib/orders.js`: the `orders` table. An order's id is the payment reference.
- `lib/schema.js`: creates `orders` and OpenReceive's tables at every start.
- `lib/db.js`: one `pg` pool on `DATABASE_URL`.

## Rules for changes

- Keep the three payment hooks in `server.js` pointed at the orders table:
  `amountFor` reads the price from the order row, `authorize` lets only the
  browser that created an order pay for it, and `onPaid` marks the order paid.
- Never take a price from the browser. Create the order on the server first,
  then show `<openreceive-checkout reference="<order id>">` on the order's page.
- `NWC_URI` and `LSC_URI_PRIMARY` are Secrets. Never put them in code, files,
  logs or chat, and never print the environment. Publishing links them to the
  published app; check Publishing, Advanced settings, Deployment secrets.
- Do not add a worker, cron job or timer for payments. Each request to the
  payment routes also settles paid invoices.
- Keep `/orders/:id` reachable: a payer comes back there to finish a payment or
  claim a swap refund.
- Full directions for further OpenReceive changes:
  https://openreceive.org/agent-directions/node/full.md
