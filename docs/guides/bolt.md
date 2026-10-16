# Bitcoin checkout on Bolt

Bolt builds Vite React apps on Bolt Cloud, with Bolt Database (or a Supabase
project you connect) as the database and Supabase Edge Functions as server
functions. OpenReceive runs in one server function of your app: it creates
each Lightning invoice, the payment goes straight to your wallet, and payment
attempts are stored in your app's database. There is no OpenReceive account,
no API key and no background worker.

Optional swaps let customers pay with **USDT, USDC, SOL, and ETH**. A swap
provider you configure converts the payment to **BTC over Lightning**, and it
settles into the same wallet. Available assets and networks depend on the
provider.

Use `@openreceive/*` 0.4.27 or newer.

What we test, and what we don't:

- **Tested.** The server function runs in OpenReceive's CI in Supabase's
  edge-runtime, the Deno runtime Supabase Edge Functions run on, under the
  hosted limits. Coding agents given this guide's prompt add checkout to a
  shop built the way Bolt builds one: a Vite React app on a local Supabase
  with Supabase Auth, PostgREST and edge-runtime. In each run a signed-in
  buyer's own page, served as a `bolt.host` site, gets a Lightning invoice
  from the function, and a paid order is marked paid.
- **Not tested.** Bolt's own agent, Bolt Cloud, and Supabase's hosted API
  gateway in front of the function. If Bolt does something this guide does
  not describe,
  [open an issue](https://github.com/OpenReceive/openreceive/issues/new) and
  say what it did.

## Before you start

- A Bolt project with a database: Bolt Database, which Bolt creates when an
  app needs one, or a Supabase project connected to it.
- Sign-in. Each order belongs to a signed-in buyer, and only that buyer can
  pay for it. If your app has no sign-in yet, Bolt adds email sign-up and
  log-in as part of the setup. Bolt's own Stripe integration asks for the
  same.
- A receive-only NWC code from your Lightning wallet
  ([get one](https://openreceive.org/get_a_nwc_code_to_receive_payments)).
  It can create invoices and read payments, but it cannot spend.
- Optional: a swap provider code, for USDT, USDC, SOL and ETH
  ([set one up](https://openreceive.org/set_up_swap_provider)).

## Add checkout to your Bolt app

1. Click the **database icon** at the top of your project, then **Secrets**.
   Create a secret named `NWC_URI` with your wallet code, then, for swaps,
   `LSC_URI_PRIMARY` with your swap provider code. Secrets reach your server
   functions and never the browser
   ([Bolt: Secrets](https://support.bolt.new/bolt-cloud/database/secrets)).
   On a team plan, only the project's owner, co-owners and team admins can
   add them.
2. Send Bolt this prompt:

<!-- platform-prompt:begin -->
```text
Add Bitcoin Lightning checkout to this app with OpenReceive. Fetch https://openreceive.org/agent-directions/bolt/full.md and follow it exactly: it has the migrations, the server function and the checkout page. NWC_URI and LSC_URI_PRIMARY are already saved as this project's secrets, so do not ask me for them. Use @openreceive packages 0.4.27 or newer.
```
<!-- platform-prompt:end -->

3. Bolt writes two migrations and a server function named `openreceive`. The
   first migration is OpenReceive's: its two tables, locked away from your
   app's browser key, and the functions that write them. The second is
   yours: `openreceive_on_paid`, which marks an order paid, and a trigger
   that takes each order's price from your products, so the browser cannot
   choose it.
4. Bolt ends with "Setup is finished" and tells you where to place an order.

Bitcoin only, with no swap provider? Then in the prompt, replace
`NWC_URI and LSC_URI_PRIMARY are already saved` with
`I want Bitcoin only, with no swaps. NWC_URI is already saved`.

Not saved the secrets yet? Leave out the sentence about secrets. Bolt then
asks you to add each one in Secrets, one at a time. Do not paste a code into
the chat: Bolt has nowhere safe to keep it.

## Check it

In the preview, sign in and place an order. Its checkout shows the payment
methods. Pick Bitcoin to see a Lightning invoice. Each swap has a minimum
amount set by the provider, so on a small order some coins are greyed out and
show their minimum.

If the checkout cannot load:

- **503.** The function's log names the fix: the database icon → **Server
  Functions** → **View Logs**. Usually a migration was not applied, or
  `openreceive_on_paid` is still the placeholder, which refuses every payment
  until it is replaced.
- **403, "Cross-site requests are not accepted".** The page's address is not
  one the function accepts. The preview and your `bolt.host` site are
  accepted as they are. For a custom domain, add a secret `SHOP_ORIGINS` with
  its address, such as `https://shop.example` (several, comma-separated).
- **403 from the authorize hook.** The buyer is not signed in, or the order
  is someone else's.

Pay a small order from your wallet to see it settle: the checkout shows the
payment as received, and `openreceive_on_paid` marks the order paid.

## How it runs on Bolt

- **One server function.** Your pages are on `bolt.host` (or your domain)
  and the function is on `<project>.supabase.co`. The page sends the buyer's
  sign-in token with every checkout request, and the function checks it
  before it touches an order. A browser sends no cookies to another site,
  and OpenReceive never asks it to.
- **Your database keeps the payments.** OpenReceive reaches it through
  Supabase's HTTPS API with the service role key that every server function
  gets. Details: [Supabase over HTTPS](supabase.md#supabase-over-https).
- **Fulfillment is SQL.** `openreceive_on_paid` runs inside the transaction
  that records the payment, once per order. If it fails, nothing is recorded
  and the next request tries again.
- **The price comes from your products.** Bolt apps usually create orders
  from the page, so a trigger copies each price from your products table
  into the order. Whatever the browser sends, it pays the catalog price.
- **No worker or cron job.** Each request to the payment routes also checks
  the wallet for settled invoices. A payer who closes the tab is settled on
  the next request.
- **Your secrets stay on the server.** `NWC_URI` and `LSC_URI_PRIMARY` are
  Bolt secrets, read only by the server function. They never go into `.env`
  or a `VITE_` variable, which end up in the browser.

Each request starts the function's payment code afresh, connects to your
wallet and checks the buyer with Supabase Auth: about a second. The first
request after Bolt deploys the function also downloads its packages.

## Keep it intact: project knowledge

Bolt follows your project's knowledge on every prompt: the gear icon →
**All project settings** → **Knowledge**. Add this to it, so later edits
keep the payment setup safe:

```markdown
## Payments (OpenReceive)

- The payment routes are the server function supabase/functions/openreceive.
  Fulfillment is the SQL function public.openreceive_on_paid. Order prices
  come from the products table through a trigger, never from the page.
- NWC_URI and LSC_URI_PRIMARY are secrets. Never put them in .env, code or a
  VITE_ variable.
- Never add CORS headers to the openreceive function, never grant anon or
  authenticated anything on openreceive_* tables or functions, and never edit
  OpenReceive's migration.
- Full directions: https://openreceive.org/agent-directions/bolt/full.md
```

## Next

- [Supabase Edge Functions recipe](../recipes/supabase-edge-functions.md):
  the code Bolt writes, explained
- [Supabase](supabase.md): Supabase over HTTPS, and what the server checks
- [Supabase migration](supabase-migration.md): the SQL Bolt applies
- [Frontend checkout](frontend-checkout.md): the checkout's options
- [Security](security.md)
