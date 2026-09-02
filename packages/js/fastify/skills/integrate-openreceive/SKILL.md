---
name: integrate-openreceive
description: >
  Integrate OpenReceive inbound Bitcoin Lightning payments into an application.
  Use when adding Bitcoin, Lightning, or crypto checkout to a Node.js, Express,
  Fastify, Next.js, Rails, React, Vue, Svelte, Angular, or plain-HTML
  application with OpenReceive (the @openreceive/* npm packages or the
  openreceive-rails gem).
license: MIT
---

# Integrate OpenReceive

OpenReceive is a payment library that runs inside the application you are
editing. It mounts HTTP routes there, issues Lightning invoices against a
wallet the merchant already controls, and calls back into your code when one
settles. There is no OpenReceive account and no API key; funds land directly in
the merchant's wallet. The one required credential is a **receive-only NWC
code** (`NWC_URI`).

## Pick the stack, then follow its directions

1. Identify the server stack of the application you are in.
2. Open the matching reference — it is complete (quickstart inlined) and needs
   no network access:
   - Node (Express / Fastify / Next.js): [references/node.md](references/node.md)
   - Rails: [references/rails.md](references/rails.md)
3. Follow its **Step 0** first: confirm `NWC_URI` is set in the server
   environment before writing code. Never print the value; never invent a
   placeholder.

Install (Node): `npm install @openreceive/express @openreceive/react` — swap
the adapter (`fastify`, `next`) and UI package (`vue`, `svelte`, `angular`,
`elements`) for the stack. Install (Rails): `bundle add openreceive-rails`.

## The three server objects

| Object | Built with | Talks to |
| --- | --- | --- |
| Wallet client | `createOpenReceive()` | the merchant's wallet — mints invoices, reads settlement, holds the NWC code |
| Host | `createHost()` | your database — your hooks plus the `openreceive_payments` table |
| HTTP routes | `openReceiveExpress()` / `openReceiveFastify()` / `openReceiveNext()` / the Rails engine | the browser — mounted at `/openreceive` by default |

The quickstart's one-factory form (`openReceiveExpress({ wallet, storage,
amountFor, authorize })`) builds all three; compose them separately only for a
shared wallet client or a custom repository. The checkout UI
(`<Checkout reference={...} prefix="/openreceive" />`) is the optional fourth
piece.

## The host contract: authorize, amountFor, onPaid

Your application keeps orders, users, prices, and fulfillment. Three hooks are
the entire bridge — wire them to the models this app already has, never to
copied demo models:

- `amountFor(reference)` — the authoritative price, read from your own data.
  Return `{ currency, value, description }` with `value` a **decimal string**
  (never a float, never payer input), or `null` when there is nothing to pay
  for. The `reference` is your order id: one per thing you fulfill, created
  before checkout, kept across retries, never reused.
- `authorize({ action, request, resource })` — your own access check, run on
  every request. `resource.reference` is a claim the payer made, not proof;
  read a real session.
- `onPaid({ reference, paidAt, query })` — fulfillment, run once per reference
  inside the settlement transaction, only for the first settled attempt. Use
  the provided `query`, not your ORM's other connection, and guard the
  transition (`UPDATE … WHERE state = 'awaiting_payment'`).

## 409 is a state, not a failure

The library serializes attempts per reference. A create that returns **409
CONFLICT** is normal checkout flow: the reference already settled, or an unpaid
checkout for that payment method is already in progress. Surface it as order
state; do not retry-loop it, and do not build an idempotency store around it —
that serialization is the library's job. (A hook failure while persisting an
attempt is a **503 retryable**, deliberately distinct.)

## Secrets

`NWC_URI` and `LSC_URI_*` are server-only. Never put them in browser code,
logs, assets, or tests. Boot fails closed if the NWC code advertises spend
methods such as `pay_invoice` — mint a receive-only code
(https://openreceive.org/get_a_nwc_code_to_receive_payments) instead of
overriding.

## Database tables

```sh
npx openreceive scaffold payments --orm prisma   # or drizzle | typeorm | sequelize | knex
```

emits the `openreceive_payments` + `openreceive_meta` migration for THIS app's
database (Rails: `bin/rails generate openreceive:install`); run it through the
app's normal migration workflow. The tables sit beside your models — no
relations to them, no separate database, no Redis.

## Verify, and test without a real wallet

`npx openreceive doctor` checks the configuration and says what to fix.

For tests, inject a fake wallet at the stable seams — `client` on
`createOpenReceive` (any object with `preflight`, `makeInvoice`,
`listTransactions`) or `config.nwc_client` in Rails — plus
`StaticPriceProvider` for fiat pricing without a network. Your routes,
persistence, reconcile, and `onPaid` then run the production code paths.
Details: https://openreceive.org/guides/host-testing.md

## Deeper documentation

Fetch on demand — each URL is raw markdown:
https://openreceive.org/guides/authorization.md ·
https://openreceive.org/guides/storage.md ·
https://openreceive.org/guides/api-reference.md ·
https://openreceive.org/guides/security.md ·
https://openreceive.org/openapi.yaml (the normative HTTP contract) ·
https://openreceive.org/llms.txt (the full index)
