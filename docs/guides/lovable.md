# Bitcoin checkout on Lovable

Lovable builds TanStack Start apps that run on Cloudflare Workers, with
Supabase as their database. OpenReceive runs in your app's own server code:
it creates each Lightning invoice, the payment goes straight to your wallet,
and payment attempts are stored in your app's Supabase database. There is no
OpenReceive account, no API key and no background worker.

Optional swaps let customers pay with **USDT, USDC, SOL, and ETH**. A swap
provider you configure converts the payment to **BTC over Lightning**, and it
settles into the same wallet. Available assets and networks depend on the
provider.

Use `@openreceive/*` 0.4.23 or newer. The payment route this guide sets up
runs in OpenReceive's CI as a Cloudflare Worker against Supabase's own
database and API server, and it was checked on an app built with Lovable's
build setup. Lovable's own agent has not run these directions in our tests
yet.

## Before you start

- A Lovable project with **Lovable Cloud** turned on, or a Supabase project
  connected to it. Projects created since May 2026 are TanStack Start apps.
- A receive-only NWC code from your Lightning wallet
  ([get one](https://openreceive.org/get_a_nwc_code_to_receive_payments)).
  It can create invoices and read payments, but it cannot spend.
- Optional: a swap provider code, for USDT, USDC, SOL and ETH
  ([set one up](https://openreceive.org/set_up_swap_provider)).

## Add checkout to your Lovable app

1. Send Lovable this prompt:

<!-- platform-prompt:begin -->
```text
Add Bitcoin Lightning checkout to this app with OpenReceive. Fetch https://openreceive.org/agent-directions/lovable/full.md and follow it exactly, from Step 0: it has the migration, the server route and the checkout page. Ask me for NWC_URI and then LSC_URI_PRIMARY with the secure secret input, one at a time. Use @openreceive packages 0.4.23 or newer.
```
<!-- platform-prompt:end -->

2. Lovable asks for `NWC_URI` with its secure secret input. Paste your
   wallet code there. Then it asks for `LSC_URI_PRIMARY`: paste your swap
   provider code, or answer "Bitcoin only".
3. Lovable writes two Supabase migrations and asks you to apply them. The
   first is OpenReceive's: its two tables, locked away from your app's
   browser key, and the functions that write them. The second is yours:
   `openreceive_on_paid`, which marks an order paid. Apply both.
4. Lovable ends with "Setup is finished" and tells you where to place an
   order.

Bitcoin only, with no swap provider? Then end the prompt with "I want
Bitcoin only, with no swaps." and Lovable asks for `NWC_URI` alone.

## Check it

In the preview, place an order. Its checkout shows the payment methods. Pick
Bitcoin to see a Lightning invoice. Each swap has a minimum amount set by the
provider, so on a small order some coins are greyed out and show their
minimum.

If the checkout cannot load and its requests answer 503, the server log names
the fix. Usually a migration was not applied, or `openreceive_on_paid` is
still the placeholder, which refuses every payment until it is replaced.

Pay a small order from your wallet to see it settle: the checkout shows the
payment as received, and `openreceive_on_paid` marks the order paid.

## How it runs on Lovable

- **Supabase over HTTPS.** A Worker cannot open a Postgres connection to
  Supabase, because Supabase's database certificate comes from its own
  authority. So OpenReceive reaches your database through Supabase's HTTPS
  API, with the `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` that Lovable
  gives your server code. Details: [Supabase over HTTPS](supabase.md#supabase-over-https).
- **Fulfillment is SQL.** `openreceive_on_paid` runs inside the transaction
  that records the payment, once per order. If it fails, nothing is recorded
  and the next request tries again.
- **The buyer is a cookie.** The checkout calls your payment routes with the
  page's cookies. Lovable keeps your users' sign-in in the browser instead,
  so each order carries a buyer token that matches an HttpOnly cookie set
  when the order is created. Only that browser can pay for the order.
- **No worker or cron job.** Each request to the payment routes also checks
  the wallet for settled invoices, through a lock in your database. A payer
  who closes the tab is settled on the next request.
- **Your secrets stay on the server.** `NWC_URI` and `LSC_URI_PRIMARY` are
  Lovable secrets, read only by server code. They never go into `.env`, which
  Lovable commits, or into a `VITE_` variable, which ends up in the browser.

Each payment request makes several calls to Supabase's API, one after
another: 4 to 8 to create a checkout. That is the slower part of a checkout
on Lovable, not the wallet.

## Keep it intact: AGENTS.md

Lovable reads `AGENTS.md` at the root of your project on every change. Add
this to it, so later edits keep the payment setup safe:

```markdown
## Payments (OpenReceive)

- The payment routes are src/routes/openreceive.$.ts and
  src/lib/openreceive.server.ts. Fulfillment is the SQL function
  public.openreceive_on_paid. There is no JavaScript onPaid.
- NWC_URI and LSC_URI_PRIMARY are secrets. Never put them in .env, code or a
  VITE_ variable.
- Never grant anon or authenticated anything on openreceive_* tables or
  functions, and never edit OpenReceive's migration.
- Full directions: https://openreceive.org/agent-directions/lovable/full.md
```

## Next

- [TanStack Start recipe](../recipes/tanstack-start.md): the code Lovable
  writes, explained
- [Supabase](supabase.md): Supabase over HTTPS, and what the server checks
- [Supabase migration](supabase-migration.md): the SQL Lovable applies
- [Frontend checkout](frontend-checkout.md): the checkout's options
- [Security](security.md)
