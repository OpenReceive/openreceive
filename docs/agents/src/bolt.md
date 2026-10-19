# OpenReceive agent directions (Bolt)

Add OpenReceive to this Bolt app: a Vite React app on Bolt Cloud, with Bolt
Database or a connected Supabase project as its database, and Supabase Edge
Functions as its server functions. These directions are written for Bolt's
agent. Every step is a file edit, a package, a Supabase migration, a server
function or a secret. Never ask the user to run a command. The Supabase Edge
Functions recipe is appended to this file in full: its code is the code to
follow.

An app with its own Node server (Express, Next.js and the like) is not this
shape: follow that framework's directions from https://openreceive.org/agents
instead.

Do not clone the OpenReceive repository, and do not copy a demo's models over
tables that already exist. Find this app's orders and products, whatever they
are named, and map the hooks onto those. Keep this app's UI, sign-in and
database.

## What OpenReceive is

A payment library that runs inside THIS app's server code. On Bolt it is one
server function, `openreceive`, which issues Lightning invoices against a
wallet the merchant already controls and settles each payment into this
app's database. The page shows the drop-in checkout and calls the function.
There is no OpenReceive account and no API key, and OpenReceive never holds
the funds: the sats land in the merchant's wallet.

The one required credential is a receive-only NWC code (Nostr Wallet
Connect): a string from the merchant's wallet that can create invoices and
read their status, and cannot spend. A swap provider (an "LSC" code)
optionally lets the payer send USDT, USDC, ETH or SOL instead, converted into
that same Lightning payment. Step 0 collects those credentials. You write two
hooks in TypeScript, `amountFor` and `authorize`, and one SQL function,
`openreceive_on_paid`, that marks the order paid. OpenReceive supplies
invoices, polling, settlement and the checkout UI. It never owns orders,
users, prices, or fulfillment.

The function keeps OpenReceive's payment rows in this app's database through
Supabase's HTTPS API, with the service role key Supabase gives every
function. The page is on another site than the function, so it sends the
buyer's Supabase access token, and `authorize` checks it.

## Step 0 — the codes are secrets the user adds

If the user says the codes are already saved as this project's secrets
(`NWC_URI`, and `LSC_URI_PRIMARY` unless they want Bitcoin only), believe
them: do not ask for them, and go to Step 1. You cannot read a secret's value,
and you do not need to.

Otherwise, before anything else, your next action is a question to the user.
Do not add packages, write migrations or edit files before asking it. A new
shop has neither code yet.

Two secrets are needed. Only the user can add a secret: in Bolt, the database
icon at the top → **Secrets** → Name and Value → **Create secret**.

- `NWC_URI` — a receive-only Nostr Wallet Connect code,
  `nostr+walletconnect://…`. Required for Bitcoin.
- `LSC_URI_PRIMARY` — a Lightning Swap Connect URI,
  `lightning+swapconnect://…`. Required for USDT, USDC, ETH and SOL. Skip it
  only when the user says they want Bitcoin alone.

Ask one question per message, and never repeat a code back.

1. **First message — the NWC code, and nothing else.** Ask the user to add
   the secret `NWC_URI` and walk them through getting it:

   > To receive payments I need a receive-only wallet code. In Rizful: open
   > the menu, tap NWC, choose Receive-only NWC code, and tap Copy
   > (https://openreceive.org/get_a_nwc_code_to_receive_payments). If you would
   > rather run your own wallet, Alby Hub works too: Connections → Add
   > Connection → Read Only. Then click the database icon at the top, open
   > Secrets, and create a secret named NWC_URI with the code as its value.
   > Tell me when it is saved.

2. **If the user pastes a code into the chat** instead, do not write it into
   any file, code or log: you have no place to keep it. Thank them, and ask
   them to create the secret with that value in Secrets. Do not suggest
   replacing the code.
3. **Second message — swaps.** If the user asked for stablecoins, USDT, USDC,
   ETH, SOL, altcoins or "crypto" (as in "Bitcoin and stablecoin payments"),
   this message IS the walkthrough below: send it as it is, and do not ask yes
   or no first. Otherwise ask whether payers should also be able to pay with
   USDT, USDC, ETH or SOL, then give the walkthrough. The walkthrough:

   > Go to https://lightning-swap.com, sign in for API keys, create a key, and
   > copy the whole URI (https://openreceive.org/set_up_swap_provider). Add it
   > in Secrets as LSC_URI_PRIMARY — or say "Bitcoin only" and I will continue
   > without it.

   Mention FixedFloat only if they already use it. Swaps on means the refund
   route back is part of this integration (the swap non-negotiable below).
4. **The database.** Supabase gives every server function `SUPABASE_URL`,
   `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`. Do not ask for them
   or add them as secrets. If this project has no database yet, create it the
   way Bolt does when an app needs one.

Never put a code in `.env` (Vite builds `VITE_` values into the page, and the
file travels with the project), never give one a `VITE_` prefix, and never
write one into code or a log. Do not invent placeholder codes. Start Step 1
only once the user says `NWC_URI` is saved and `LSC_URI_PRIMARY` is saved or
explicitly declined.

## Step 1 — the packages

Add `@openreceive/react` at {{release}} or newer to the app's
`package.json`. The function imports `npm:@openreceive/http@^{{release}}`
and `npm:@supabase/supabase-js@2` directly; add nothing else. (The recipe
below writes `^0.4.27`, the oldest release with the `cors` option; both
resolve to the newest 0.4.x.) No `pg`, no
Postgres driver, no OpenReceive scaffold.

## Step 2 — the migration

Fetch https://openreceive.org/guides/supabase-migration.md and copy its SQL
block, unchanged, into one new migration in `supabase/migrations/`, then
apply it the way this project applies migrations. Do not edit it, split it,
rename anything in it, or drop its `revoke` lines. It creates
`openreceive_payments` and `openreceive_meta` with row level security on and
every grant revoked from `anon` and `authenticated`, the functions the server
calls to write them, and `openreceive_on_paid` as a placeholder that refuses
every settlement.

## Step 3 — the order and its buyer

- **The order's id is the `reference`.** Create the order before checkout,
  keep it across retries, never reuse it. A fresh id per page load lets one
  order be paid twice.
- **The price is the database's, never the browser's.** In a Bolt app the
  page usually inserts the order itself with supabase-js, so the browser
  chose its total and status. In your second migration (Step 4), add the
  recipe's `before insert` trigger that copies each price from the products
  table and sets the unpaid status, adapted to this app's tables; with order
  lines, price each line and sum them. Keep the app's order flow as it is.
  Check the orders table's policies: a buyer may insert and read their own
  orders, never update an order's total or status.
- **The buyer is the signed-in user.** The page sends the buyer's Supabase
  access token, and `authorize` allows only the order's own user. If the app
  has no sign-in yet, add email sign-up and log-in with Supabase Auth first,
  and store the user's id on each order. Keep the app's sign-in if it has
  one.
- **The order is unpaid or paid.** Do not copy attempt statuses (`pending`,
  `expired`, `failed`, `attention`) onto it, and do not add a relation to
  `openreceive_payments`.
- **A paid order's page says it is paid and shows no checkout.** Nothing is
  left to pay, and a checkout cannot start a new payment for a paid order.
  Mount the checkout only while the order is unpaid. When it settles on the
  page, update the page's status line from `onSettled` on `<Checkout>`:
  `openreceive_on_paid` has already marked the order paid. Keep that
  checkout mounted, because it is the payer's receipt.

## Step 4 — `openreceive_on_paid` and the price trigger

In a second new migration, replace the placeholder with the SQL that marks
this app's order paid, and add the price trigger from Step 3. Use
`create or replace`, and this app's own table, column and status names:

```sql
create or replace function public.openreceive_on_paid(
  p_reference text, p_payment_hash text, p_paid_at bigint
) returns void language plpgsql as $$
begin
  update public.orders
     set status = 'paid'
   where id = p_reference::uuid   -- or just p_reference, if the ids are text
     and status = 'awaiting_payment';
end
$$;
```

It runs inside the transaction that records the payment, for the order's
first settled payment only. If it raises, nothing is recorded, and the next
request retries it. Its `WHERE` on the unpaid status is the guard against a
second fulfillment. Keep it to database writes.

## Step 5 — the server function

Write `supabase/functions/openreceive/index.ts` exactly as the recipe's
"The function" section shows:

- Name the function `openreceive`, so the routes live under
  `/functions/v1/openreceive/`.
- `storage: { supabase: { url: SUPABASE_URL, key: SUPABASE_SERVICE_ROLE_KEY } }`,
  read with `Deno.env.get` inside the request handler.
- No `onPaid` and no `db`: `openreceive_on_paid` is the fulfillment.
- `findOrder` reads the order with the service role client, its total as
  `total::text`; `authorize` checks the request's bearer token with
  `supabase.auth.getUser(token)` and compares the user with the order's.
- `cors: { origins: shopOrigins(request) }`, with the recipe's `BOLT_PAGE`
  pattern: Bolt's preview changes host every session. A custom domain goes in
  a `SHOP_ORIGINS` secret the user adds; tell them so only if they mention
  one.
- Build the stack inside each request and close it in `finally`.
- Never add CORS headers of your own to these routes, and never wrap the
  handler in the usual `corsHeaders` boilerplate: OpenReceive answers its own
  preflights.

## Step 6 — the checkout page

On the order's page, render `<Checkout>` from `@openreceive/react` with
`prefix` set to `` `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/openreceive` ``
and `fetch` set to the recipe's `withSupabaseToken`, and import
`@openreceive/react/styles.css` there. The order's page must have its own
URL (a route such as `/orders/:id`). After the order is created, navigate to
it. Use the drop-in; do not build your own checkout UI.

## After setup — hand over, then stop

You cannot pay the invoice: the code is receive-only. Do not pay, settle or
mark an order paid, and do not look for a way to.

If the checkout answers 503, the function's log names the fix: usually the
migration is not applied, or `openreceive_on_paid` is still the placeholder.
A 403 "Cross-site requests are not accepted" means the page's origin is not
in `shopOrigins`; a 403 from `authorize` means the buyer is not signed in, or
the order is someone else's.

Setup ends here. Your last message starts "Setup is finished" and has at most
five short lines: that a buyer signs in and places an order in the preview,
the methods the checkout offers, and that a small real payment from their own
wallet marks the order paid. Send nothing after it. Do not list what changed,
offer more work, or end the message on a question. Name the methods: Bitcoin,
plus USDT, USDC, ETH and SOL when `LSC_URI_PRIMARY` is saved. Do not mention
minimums, and never say a coin will not work or will not be offered.

## Non-negotiables

The recipe below has the code. These are the rules it cannot state for
itself.

- OpenReceive never owns orders, users, prices, or fulfillment.
- Keep `NWC_URI` / `LSC_URI_*` in Bolt's Secrets, read with `Deno.env.get` in
  the server function. Never a `VITE_` variable, `.env`, page code or a log.
- Do not suggest rotating, revoking or replacing a code because it was pasted
  into this chat; ask the user to save it as a secret instead.
- `SUPABASE_SERVICE_ROLE_KEY` reads and writes every table. Use it only in
  the server function, never in the page.
- Never grant `anon` or `authenticated` anything on an `openreceive_*` table
  or function, and never add a row level security policy to those tables.
  The server refuses to serve while they can reach them.
- The host owns the price. The database sets it, `amountFor` reads it from
  the order, and payer-supplied amounts are rejected.
- `authorize` runs on every request, and the `resource` it receives is a CLAIM
  the payer made, not proof. Check the bearer token against the order's user.
- Receive-only NWC is required; a spend-capable code fails closed unless
  explicitly overridden. Never set that override.
- There is NO merchant-initiated refund of a settled Lightning payment, because
  the wallet cannot spend. Swap refunds — a payer reclaiming a deposit that
  never converted — are the only refund OpenReceive performs. Do not build,
  promise, or imply a Lightning refund path.
- IF YOU TURN SWAPS ON, BUILD THE ROUTE BACK. A deposit that arrives short or
  late is refunded on a SECOND visit, so the order needs its own URL, with
  `syncUrl` on `<Checkout>`, and the attempt must come back with it: keep the
  `payment_hash` from `onState` and pass it as `resumePaymentHash`.
  https://openreceive.org/guides/swap-refunds.md
- Show the payer what they are buying: return a `description` beside the
  price from `amountFor`.
- HTTP JSON is snake_case; TypeScript APIs are camelCase.
- Money is integers or decimal strings — never binary floats.

## More documentation

Fetch one when the moment comes. Each is raw markdown, so a plain GET is
enough.

- https://openreceive.org/guides/bolt.md — what the user does on Bolt around these steps
- https://openreceive.org/guides/supabase.md — Supabase over HTTPS: how the storage works, and what the server checks before it serves
- https://openreceive.org/guides/supabase-migration.md — the migration for Step 2
- https://openreceive.org/guides/authorization.md — before you write `authorize`, and how cross-site requests are checked
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
