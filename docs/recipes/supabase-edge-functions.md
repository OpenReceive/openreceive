# Supabase Edge Functions recipe

OpenReceive ships no Edge Functions package. A Supabase Edge Function takes a
Web-standard `Request` and returns a `Response`, and so does
`@openreceive/http`, so the integration is one function named `openreceive`
plus the React checkout on your page. The function creates each Lightning
invoice, the payment goes straight to your wallet, and payment attempts are
stored in your Supabase database through its HTTPS API. There is no
OpenReceive account and no background worker.

Optional swaps let customers pay with **USDT, USDC, SOL, and ETH**. A swap
provider you configure converts the payment to **BTC over Lightning**, and it
settles into the same wallet. Available assets and networks depend on the
provider.

This is how Bolt apps take payments: Bolt's server functions are Supabase
Edge Functions, and its pages are a Vite React app on another site. The code
below was checked with `@openreceive/*` 0.4.27 in Supabase's edge-runtime
v1.77.4, behind a stand-in for Supabase's API gateway with `verify_jwt` on,
with Supabase Auth v2.197 and PostgREST 14. A signed-in buyer's page, served
as `https://<name>.bolt.host`, got a Lightning invoice through the function,
the same invoice after a reload, and a paid order once the wallet settled it.
A stranger, the bare anon key and an unlisted origin were refused, and a
price the browser wrote into its order was replaced by the catalog's.

Use `@openreceive/*` 0.4.27 or newer: the function needs the `cors` option.

## How it fits together

- The page is on one site (`https://shop.example`, `<name>.bolt.host`), the
  function on another (`https://<project-ref>.supabase.co/functions/v1/openreceive`).
  A browser sends no cookies across sites, so the page sends the buyer's
  Supabase access token, and `authorize` checks it.
- The function builds an OpenReceive stack for each request and closes it
  before it answers. Edge Functions run each request in a short-lived
  worker, and a stack's wallet connection must not outlive it.
- Payments live in your database's `openreceive_payments` table, written
  through Supabase's HTTPS API with the service role key. That key is set for
  every function by Supabase; it never reaches the page.
- Your SQL function `openreceive_on_paid` marks the order paid, inside the
  transaction that records the payment.

## 1. The migration

Save the SQL from [Supabase migration](../guides/supabase-migration.md),
unchanged, as a new migration (`supabase/migrations/<timestamp>_openreceive.sql`)
and apply it. It creates OpenReceive's tables with row level security on and
every grant revoked from `anon` and `authenticated`, and the functions the
server calls to write them.

## 2. `openreceive_on_paid`

In a migration of your own, replace the migration's placeholder with the SQL
that marks your order paid:

```sql
create or replace function public.openreceive_on_paid(
  p_reference text, p_payment_hash text, p_paid_at bigint
) returns void language plpgsql as $$
begin
  update public.orders
     set status = 'paid'
   where id = p_reference::uuid
     and status = 'awaiting_payment';
end
$$;
```

It runs for the order's first settled payment only, inside the transaction
that records it, so a failure here records nothing and the next request
retries. The `status` condition is the guard against a second fulfillment.

## 3. Keep the price out of the browser's hands

`amountFor` charges what the order row says. In many Supabase apps the page
inserts the order itself, under a row level security policy, so the browser
also chose its price and status. Make the database set both. With one product
per order:

```sql
create or replace function public.orders_take_catalog_price() returns trigger
language plpgsql set search_path = public as $$
begin
  select p.name, p.price, p.currency
    into new.title, new.total, new.currency
    from public.products p
   where p.id = new.product_id;
  if not found then
    raise exception 'unknown product %', new.product_id;
  end if;
  new.status := 'awaiting_payment';
  return new;
end
$$;

create trigger orders_take_catalog_price
  before insert on public.orders
  for each row execute function public.orders_take_catalog_price();
```

With order lines, do the same for each line and sum them into the order. Or
compute the amount in `amountFor` from the catalog instead of reading the
order's total. Either way, the browser must not be able to update an order's
total or status: no `update` policy for `authenticated` on those columns.

## 4. The function

`supabase/functions/openreceive/index.ts`. Name it `openreceive`: Supabase
hands a function its requests under `/<name>/`, and the routes live under
`/openreceive/`.

```ts
import { createStack } from "npm:@openreceive/http@^0.4.27";
import { createClient } from "npm:@supabase/supabase-js@2";

const env = (name: string) => Deno.env.get(name) ?? "";

// The pages that call this function from another site. Bolt serves its
// preview from a new *.local-credentialless.webcontainer-api.io host each
// session and a published app from <name>.bolt.host; drop BOLT_PAGE when
// your pages are elsewhere. List any other origin in the SHOP_ORIGINS
// secret, comma-separated: "https://shop.example".
const BOLT_PAGE = /^https:\/\/[a-z0-9-]+\.(?:bolt\.host|local-credentialless\.webcontainer-api\.io)$/;

function shopOrigins(request: Request): string[] {
  const listed = env("SHOP_ORIGINS").split(",").map((origin) => origin.trim()).filter(Boolean);
  const origin = request.headers.get("origin") ?? "";
  return BOLT_PAGE.test(origin) ? [...listed, origin] : listed;
}

Deno.serve(async (request) => {
  // Supabase sets SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for every function.
  const supabase = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });
  const findOrder = async (id: string) => {
    const { data } = await supabase
      .from("orders")
      .select("id, user_id, status, title, currency, total::text")
      .eq("id", id)
      .maybeSingle();
    return data;
  };

  const stack = createStack({
    wallet: { nwc: env("NWC_URI") },
    storage: {
      supabase: { url: env("SUPABASE_URL"), key: env("SUPABASE_SERVICE_ROLE_KEY") },
    },
    // The price comes from the order row, never from the request.
    amountFor: async (reference) => {
      const order = await findOrder(reference);
      return order?.status === "awaiting_payment"
        ? { currency: order.currency, value: order.total, description: order.title }
        : null;
    },
    // Only the signed-in buyer may pay for their order.
    authorize: async ({ request, resource }) => {
      const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
      if (!token || !resource.reference) return false;
      const { data } = await supabase.auth.getUser(token);
      const order = await findOrder(resource.reference);
      return Boolean(data.user && order && order.user_id === data.user.id);
    },
    cors: { origins: shopOrigins(request) },
  });
  try {
    return await stack.handler(request);
  } finally {
    await stack.close();
  }
});
```

- `total::text` hands `amountFor` the price as a decimal string: PostgREST
  returns a `numeric` column as a JSON number otherwise.
- There is no `onPaid`: `openreceive_on_paid` is the fulfillment.
- `LSC_URI_PRIMARY`, when set, turns swaps on; OpenReceive reads it from the
  environment.

## 5. Which pages may call it

`cors` takes exact origins: scheme, host and port, with no path or trailing
slash. A listed origin passes the cross-site check, and the function answers
its preflights. Every other origin is refused. `shopOrigins` lists the
request's own origin when it is a Bolt page, because a Bolt preview's host
changes from session to session.

The origin list is not what keeps one buyer out of another's order: the token
is. OpenReceive never allows credentials across sites, so no cookie reaches
the function, and a page on any listed origin can only send the tokens it
holds. `authorize` decides with the token, on every request. Never answer
these routes with CORS headers of your own, and never remove the token check.
More: [Cross-site requests](../guides/authorization.md#cross-site-requests).

## 6. The secrets

The function reads the wallet code, and the swap provider's code for swaps,
from the project's secrets:

```sh
supabase secrets set NWC_URI="nostr+walletconnect://…"
supabase secrets set LSC_URI_PRIMARY="lightning+swapconnect://…"
supabase functions deploy openreceive
```

On Bolt, add them under the database icon → **Secrets**; Bolt deploys the
function itself. A secret never goes in `.env`, which Vite builds into the
page, or in a `VITE_` variable.

## 7. The checkout page

The page points the checkout at the function and sends the buyer's token on
every request it makes, polling and swaps included. Only the React
`<Checkout>` takes a `fetch`, so the page must use it.

```tsx
import { Checkout } from "@openreceive/react";
import "@openreceive/react/styles.css";
import { supabase } from "../lib/supabase";

// The payment routes run in the `openreceive` server function.
const prefix = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/openreceive`;

// Every checkout request carries the buyer's Supabase session.
const withSupabaseToken: typeof fetch = async (input, init) => {
  const { data } = await supabase.auth.getSession();
  const headers = new Headers(init?.headers);
  if (data.session) headers.set("Authorization", `Bearer ${data.session.access_token}`);
  return fetch(input, { ...init, headers });
};

// On the order's page, while the order is unpaid:
<Checkout
  reference={order.id}
  prefix={prefix}
  fetch={withSupabaseToken}
  onSettled={() => setOrder({ ...order, status: "paid" })}
/>;
```

The buyer must be signed in: the token is their Supabase session. Mount the
checkout only for an unpaid order, and keep it mounted once it settles on the
page, as the payer's receipt.

## How it runs

- **No worker or cron job.** Each request to the payment routes also checks
  the wallet for settled invoices. The open checkout polls, so a payer who
  waits sees the order paid; a payer who closes the tab is settled on the
  next request.
- **About a second a request.** Each request boots a stack, connects to the
  wallet's relay and asks Supabase Auth about the token. The first request
  after a deploy also downloads the packages, which took about 5 s in our
  check.
- **Inside the limits.** Supabase gives a request 2 s of CPU. One checkout
  request used 100 to 600 ms in our benchmark, the high end with a wallet
  holding 980 recent transactions.

## What we test

OpenReceive's CI runs both storage routes in Supabase's edge-runtime under
the hosted limits, including a cross-site page with a bearer token. The trial
harness runs coding agents through a Bolt-shaped shop on a local Supabase
stack (see [How we test platforms](../guides/how-we-test-platforms.md)). We
have not deployed to Supabase's hosted platform: its own API gateway, its
`verify_jwt` check and its handling of preflights are untested. If something
there does not work as this recipe says,
[open an issue](https://github.com/OpenReceive/openreceive/issues/new).
