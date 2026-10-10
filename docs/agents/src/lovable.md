# OpenReceive agent directions (Lovable)

Add OpenReceive to this Lovable app: a TanStack Start app on Cloudflare
Workers, with Lovable Cloud or a connected Supabase project as its database.
These directions are written for Lovable's agent. You have no terminal, so
every step is a file edit, a package, a Supabase migration or a secret. Never
ask the user to run a command. The TanStack Start recipe is appended to this
file in full; its "On Supabase (Lovable)" section is the code to follow.

Do not clone the OpenReceive repository, and do not copy a demo's models over
tables that already exist. Find this app's orders and products, whatever they
are named, and map the hooks onto those. Keep this app's UI, sign-in and
database.

## What OpenReceive is

A payment library that runs inside THIS app's server code. It mounts as one
TanStack Start server route (`src/routes/openreceive.$.ts`), issues Lightning
invoices against a wallet the merchant already controls, and settles each
payment into this app's Supabase database. There is no OpenReceive account
and no API key, and OpenReceive never holds the funds: the sats land in the
merchant's wallet.

The one required credential is a receive-only NWC code (Nostr Wallet
Connect): a string from the merchant's wallet that can create invoices and
read their status, and cannot spend. A swap provider (an "LSC" code)
optionally lets the payer send USDT, USDC, ETH or SOL instead, converted into
that same Lightning payment. Step 0 collects those credentials. You write two
hooks in TypeScript, `amountFor` and `authorize`, and one SQL function,
`openreceive_on_paid`, that marks the order paid. OpenReceive supplies
invoices, polling, settlement and the checkout UI. It never owns orders,
users, prices, or fulfillment.

On Lovable, OpenReceive keeps its payment rows in this app's Supabase
database and reaches it over Supabase's HTTPS API with the project's secret
key, because a Worker cannot open a Postgres connection to Supabase.

## Step 0 — ask for the two codes, one secret at a time

Before anything else, your next action is a question to the user. Do not add
packages, write migrations or edit files before asking it. A new shop has
neither code yet.

Two server-only secrets are needed before the integration:

- `NWC_URI` — a receive-only Nostr Wallet Connect code,
  `nostr+walletconnect://…`. Required for Bitcoin.
- `LSC_URI_PRIMARY` — a Lightning Swap Connect URI,
  `lightning+swapconnect://…`. Required for USDT, USDC, ETH and SOL. Skip it
  only when the user says they want Bitcoin alone.

Ask for each one with Lovable's secure secret input, named exactly as above.
The user never edits a file: they paste each code into this chat or into
that secret input, and Lovable stores it as a project secret. A code pasted
into the chat is saved as a secret too. Never repeat a code back. Ask one
question per message.

1. **First message — the NWC code, and nothing else.** Ask for the secret
   `NWC_URI` and walk them through getting it:

   > To receive payments I need a receive-only wallet code. In Rizful: open
   > the menu, tap NWC, choose Receive-only NWC code, and tap Copy
   > (https://openreceive.org/get_a_nwc_code_to_receive_payments). If you would
   > rather run your own wallet, Alby Hub works too: Connections → Add
   > Connection → Read Only. Paste it into the secret input for NWC_URI.

2. **When it is saved.** If the user pasted it into the chat and it does not
   start with `nostr+walletconnect://`, ask them to copy the receive-only code
   again. Reply only that it is saved, then ask the next question.
3. **Second message — swaps.** If the user asked for stablecoins, USDT, USDC,
   ETH, SOL, altcoins or "crypto" (as in "Bitcoin and stablecoin payments"),
   this message IS the walkthrough below: send it as it is, and do not ask yes
   or no first. Otherwise ask whether payers should also be able to pay with
   USDT, USDC, ETH or SOL, then give the walkthrough. The walkthrough:

   > Go to https://lightning-swap.com, sign in for API keys, create a key, and
   > copy the whole URI (https://openreceive.org/set_up_swap_provider). Paste
   > it into the secret input for LSC_URI_PRIMARY — or say "Bitcoin only" and
   > I will continue without it.

   Mention FixedFloat only if they already use it. Swaps on means the refund
   route back is part of this integration (the swap non-negotiable below).
4. **Supabase.** Lovable sets `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
   for server code when Lovable Cloud, or a connected Supabase project, is on.
   Do not ask for them or try to create them: Lovable reserves the
   `SUPABASE_` prefix. If this project has no backend yet, ask the user to
   turn on Lovable Cloud, and wait until they have.

Never give a code a `VITE_` prefix, never put one in `.env` (Lovable commits
that file), and never write one into code or a log. Do not invent placeholder
codes. Start Step 1 only once `NWC_URI` is saved and `LSC_URI_PRIMARY` is
saved or explicitly declined.

## Step 1 — the packages

Add `@openreceive/http` and `@openreceive/react` at {{release}} or newer.
Nothing else: no `pg`, no Postgres driver, no OpenReceive scaffold. Do not
change the Vite or Wrangler configuration.

## Step 2 — the migration

Fetch https://openreceive.org/guides/supabase-migration.md and copy its SQL
block, unchanged, into one new Supabase migration, then apply it. Do not edit
it, split it, rename anything in it, or drop its `revoke` lines. It creates
`openreceive_payments` and `openreceive_meta` with row level security on and
every grant revoked from `anon` and `authenticated`, the functions the server
calls to write them, and `openreceive_on_paid` as a placeholder that refuses
every settlement.

## Step 3 — the order and its buyer

- **The order's id is the `reference`.** Create the order before checkout,
  keep it across retries, never reuse it. A fresh id per page load lets one
  order be paid twice.
- **The order row is the price.** Order creation copies live prices into the
  order. `amountFor` reads only that order and returns
  `{ currency, value, description }`, the value a decimal string such as
  `"12.50"`, and `null` for an order that is not payable.
- **The buyer is a cookie.** The checkout calls the payment routes from the
  browser with the page's cookies and nothing else, and a Lovable app keeps
  its Supabase sign-in in the browser, not in a cookie. So in a migration add
  `buyer_token text` to the orders table, and create orders in a server
  function (`createServerFn`) that reads the `buyer` cookie, or sets one to
  `crypto.randomUUID()` (HttpOnly, Secure, SameSite=Lax, path `/`, one
  year) with `getCookie` and `setCookie` from `@tanstack/react-start/server`,
  then inserts the order with `buyer_token` set to it through `supabaseAdmin`
  from `@/integrations/supabase/client.server`, and returns the id. If the app
  creates orders in the browser today, move that insert into this function.
  Keep the order's user column too, if the app has sign-in.
- **The order is unpaid or paid.** Do not copy attempt statuses (`pending`,
  `expired`, `failed`, `attention`) onto it, and do not add a relation to
  `openreceive_payments`.

## Step 4 — `openreceive_on_paid`

In a second new migration, replace the placeholder with the SQL that marks
this app's order paid. Use `create or replace`, and this app's own table,
column and status names:

```sql
create or replace function public.openreceive_on_paid(
  p_reference text, p_payment_hash text, p_paid_at bigint
) returns void language plpgsql as $$
begin
  update public.orders
     set status = 'paid'
   where id = p_reference::uuid   -- or just p_reference, if the ids are text
     and status = 'pending';
end
$$;
```

It runs inside the transaction that records the payment, for the order's
first settled payment only. If it raises, nothing is recorded, and the next
request retries it. Its `WHERE` on the unpaid status is the guard against a
second fulfillment. Keep it to database writes.

## Step 5 — the payment route

Write `src/routes/openreceive.$.ts` and `src/lib/openreceive.server.ts`
exactly as the recipe's "On Supabase (Lovable)" section shows:

- `storage: { supabase: { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY } }`,
  read inside the handler, never at module scope.
- No `onPaid` and no `db`: `openreceive_on_paid` is the fulfillment.
- `findOrder` reads the order with `supabaseAdmin`; `authorize` compares the
  request's `buyer` cookie with the order's `buyer_token`.
- Build the stack inside each request and close it in `finally`.
- Import the server module only inside the route's handlers, so it never
  reaches the browser bundle.

## Step 6 — the checkout page

Add `src/routes/checkout.$reference.tsx` with `<Checkout reference={reference}
prefix="/openreceive" />` from `@openreceive/react`, and import
`@openreceive/react/styles.css` there. After the order is created, navigate
to `/checkout/<id>`. Use the drop-in; do not build your own checkout UI.

## After setup — hand over, then stop

You cannot pay the invoice: the code is receive-only. Do not pay, settle or
mark an order paid, and do not look for a way to.

If the checkout answers 503, the server log names the fix: usually the
migration is not applied, or `openreceive_on_paid` is still the placeholder.

Setup ends here. Your last message starts "Setup is finished" and has at most
five short lines: where to place an order in the preview, the methods the
checkout offers, and that a small real payment from their own wallet marks
the order paid. Send nothing after it. Do not list what changed, offer more
work, or end the message on a question. Name the methods: Bitcoin, plus
USDT, USDC, ETH and SOL when `LSC_URI_PRIMARY` is saved. Do not mention
minimums, and never say a coin will not work or will not be offered.

## Non-negotiables

The recipe below has the code. These are the rules it cannot state for
itself.

- OpenReceive never owns orders, users, prices, or fulfillment.
- Keep `NWC_URI` / `LSC_URI_*` server-only: secrets read with `process.env`
  in `.server.ts` modules. Never a `VITE_` variable, `.env`, browser code or
  a log.
- Do not suggest rotating, revoking or replacing a code because it was pasted
  into this chat; that is the supported path.
- `SUPABASE_SERVICE_ROLE_KEY` reads and writes every table. Read it only in
  server modules.
- Never grant `anon` or `authenticated` anything on an `openreceive_*` table
  or function, and never add a row level security policy to those tables.
  The server refuses to serve while they can reach them.
- The host owns the price. `amountFor` reads it from the order; reject
  payer-supplied amounts.
- `authorize` runs on every request, and the `resource` it receives is a CLAIM
  the payer made, not proof. Check the `buyer` cookie against the order.
- Receive-only NWC is required; a spend-capable code fails closed unless
  explicitly overridden. Never set that override.
- There is NO merchant-initiated refund of a settled Lightning payment, because
  the wallet cannot spend. Swap refunds — a payer reclaiming a deposit that
  never converted — are the only refund OpenReceive performs. Do not build,
  promise, or imply a Lightning refund path.
- IF YOU TURN SWAPS ON, BUILD THE ROUTE BACK. A deposit that arrives short or
  late is refunded on a SECOND visit, so the order needs its own URL
  (`/checkout/$reference`, with `syncUrl` on `<Checkout>`), and the attempt
  must come back with it: keep the `payment_hash` from `onState` and pass it
  as `resumePaymentHash`. https://openreceive.org/guides/swap-refunds.md
- Show the payer what they are buying: return a `description` beside the
  price from `amountFor`.
- HTTP JSON is snake_case; TypeScript APIs are camelCase.
- Money is integers or decimal strings — never binary floats.

## More documentation

Fetch one when the moment comes. Each is raw markdown, so a plain GET is
enough.

- https://openreceive.org/guides/lovable.md — what the user does on Lovable around these steps
- https://openreceive.org/guides/supabase.md — Supabase over HTTPS: how the storage works, and what the server checks before it serves
- https://openreceive.org/guides/supabase-migration.md — the migration for Step 2
- https://openreceive.org/guides/authorization.md — before you write `authorize`
- https://openreceive.org/guides/storage.md — the payment tables and the attempt state machine
- https://openreceive.org/guides/frontend-checkout.md — the drop-in's props, including `syncUrl` and `resumePaymentHash`
- https://openreceive.org/guides/checkout-ux.md — the rules the drop-in already follows
- https://openreceive.org/guides/provider-registry.md — where the wallet logos and pay tutorials come from: inside the JavaScript, nothing to serve
- https://openreceive.org/guides/automated-swaps.md — only if `LSC_URI_PRIMARY` is set
- https://openreceive.org/guides/swap-refunds.md — the refund flow, and the route back to it
- https://openreceive.org/guides/lightning-swap-connect.md — what an `LSC_URI_*` code actually is
- https://openreceive.org/guides/environment-variables.md — every variable, and what is deliberately not one
- https://openreceive.org/guides/price-feeds.md — where the fiat→sats rate comes from
- https://openreceive.org/guides/rate-limiting.md — before a public shop goes live
- https://openreceive.org/guides/security.md and https://openreceive.org/guides/deploying.md — before this goes anywhere real
- https://openreceive.org/guides/api-reference.md — every route, option and error code
- https://openreceive.org/guides.md — the index, if what you need is not above

Questions, or a problem with the library itself:
https://openreceive.org/contact
