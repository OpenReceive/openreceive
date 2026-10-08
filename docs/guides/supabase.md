# Bitcoin checkout with Supabase

Supabase gives your app a Postgres database, and OpenReceive keeps its
payment attempts in it, next to your orders. Your own server code creates
each Lightning invoice, and the payment goes straight to your wallet. Your
server reaches Supabase through its transaction pooler, and Supabase Auth can
decide who may pay for an order. There is no OpenReceive account, no API key
and no background worker.

Optional swaps let customers pay with **USDT, USDC, SOL, and ETH**. A swap
provider you configure converts the payment to **BTC over Lightning**, and it
settles into the same wallet. Available assets and networks depend on the
provider.

Use OpenReceive 0.4.19 or newer. This guide adds the Supabase parts to a
framework quickstart, so start from yours:
[Next.js](quickstart-next.md), [Express](quickstart-node.md),
[Fastify](quickstart-fastify.md), [FastAPI](quickstart-fastapi.md) or
[Django](quickstart-django.md).

## Where your server can run

| Server | With Supabase |
| --- | --- |
| Node: Next.js (on Vercel or elsewhere), Express, Fastify | Yes |
| Python: FastAPI, Django | Yes |
| Cloudflare Workers, including Lovable's TanStack Start apps | Not yet |
| Supabase Edge Functions (Deno), including Bolt's | Not yet |

Supabase signs its database certificate with its own certificate authority.
A Node or Python server can be told to trust it. A Cloudflare Worker cannot:
Workers check a database's certificate against public authorities only, so
the connection fails. OpenReceive's engine has not been tested on Deno.

## 1. Get the connection strings

Open your project and click **Connect** at the top of the page.

- **Transaction pooler**, port `6543`: use this for your app. Its user is
  `postgres.<project-ref>`, and it works over IPv4.
- **Session pooler**, port `5432` on the same pooler host: use this for
  migrations, which may need a connection to themselves.

The **Direct connection** (`db.<project-ref>.supabase.co`) works over IPv6
only, unless you buy Supabase's IPv4 add-on. Most hosts reach the poolers
more easily.

OpenReceive locks each order inside a transaction
(`pg_advisory_xact_lock`), which the transaction pooler supports. Its
storage is tested through a transaction pooler with `pg`, Knex, Prisma (with
`@prisma/adapter-pg`) and TypeORM.

On Vercel, the Supabase integration sets `POSTGRES_URL` to the transaction
pooler and `POSTGRES_URL_NON_POOLING` to session mode. Both carry
`sslmode=require`, which fails in Node until you take step 2.

## 2. Trust Supabase's certificate

In the Supabase dashboard, open **Database Settings**. Under **SSL
Configuration**, click **Download Certificate** to get `prod-ca-2021.crt`.
While you are there, turn on **Enforce SSL on incoming connections**.

### Node

`pg` reads `sslmode=require` as "verify the server's certificate", and Node
does not know Supabase's authority. A URL with `sslmode=require` fails with
`self-signed certificate in certificate chain`. The URL's `sslmode` also wins
over the `ssl` option you pass. So remove it from the URL, and give `pg` the
certificate:

```ts
// lib/db.ts
import { Pool } from "pg";

let pool: Pool | undefined;

// Supabase's transaction pooler, verified against Supabase's certificate
// authority. DATABASE_URL is the pooler URL (Vercel's integration names it
// POSTGRES_URL); SUPABASE_CA_CERT is the text of prod-ca-2021.crt.
export function db(): Pool {
  if (pool) return pool;
  const databaseUrl = process.env.DATABASE_URL;
  const ca = process.env.SUPABASE_CA_CERT;
  if (!databaseUrl || !ca) throw new Error("Set DATABASE_URL and SUPABASE_CA_CERT.");
  const url = new URL(databaseUrl);
  url.searchParams.delete("sslmode");
  pool = new Pool({ connectionString: url.toString(), ssl: { ca }, max: 5 });
  return pool;
}
```

Paste the whole certificate file, `-----BEGIN CERTIFICATE-----` line
included, into the `SUPABASE_CA_CERT` environment variable. The certificate
is public; it is not a secret. Pass this pool as `db`, as your quickstart
shows. Do not set `rejectUnauthorized: false`: it encrypts the connection,
but anyone between your server and Supabase could stand in for the
database.

### Python

psycopg reads the certificate from a file. Commit `prod-ca-2021.crt` to
your app, then add this to the pooler URL:

```text
?sslmode=verify-full&sslrootcert=prod-ca-2021.crt
```

A relative path is read from the directory the server starts in. The
transaction pooler cannot keep prepared statements, so turn psycopg's off on
the engine you give OpenReceive:

```python
from sqlalchemy import create_engine

engine = create_engine(
    os.environ["DATABASE_URL"],  # postgresql+psycopg://…:6543/postgres?sslmode=verify-full&sslrootcert=…
    connect_args={"prepare_threshold": None},
)
```

Django already turns prepared statements off for PostgreSQL. If your own
code uses `.iterator()`, add `"DISABLE_SERVER_SIDE_CURSORS": True` to the
database settings.

## 3. Create the tables, then keep them private

Create OpenReceive's two tables the way your app runs migrations: the
scaffold for your ORM, `openreceive scaffold payments --sql` (Python) pasted
into a Supabase migration, or Django's `migrate`. See
[Payment storage](storage.md).

Then lock both tables away from Supabase's Data API. On many projects, a new
table in the `public` schema can be read and changed by anyone with your
project's anon key, which every visitor's browser has. That would expose
`swap_data`, which must stay on your server. Run this once, in the SQL
Editor or a migration:

```sql
alter table openreceive_payments enable row level security;
alter table openreceive_meta enable row level security;
revoke all on table openreceive_payments, openreceive_meta from anon, authenticated;
```

With no policies, row level security refuses every Data API request. Your
server still works: it connects as `postgres`, which bypasses row level
security and owns the tables. If you renamed the tables, use your names.

## 4. Use Supabase Auth in `authorize`

The drop-in checkout calls your payment routes from the page, with the
page's cookies. Supabase keeps a server-side session in cookies when the app
uses `@supabase/ssr`, so `authorize` can read the user from them:

```ts
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

async function currentUserId(): Promise<string | undefined> {
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} } },
  );
  // getClaims verifies the session's token; never trust getSession on a server.
  const { data } = await supabase.auth.getClaims();
  return data?.claims.sub;
}

// In openReceiveNextHandlers({ ... }):
authorize: async ({ resource }) => {
  const userId = await currentUserId();
  const order = resource.reference ? await findOrder(resource.reference) : null;
  return Boolean(userId && order && order.user_id === userId);
},
```

`setAll` does nothing here because the payment routes never refresh a
session; your app's own `proxy.ts` or `middleware.ts` does. With Express,
build the client from the request's `cookie` header with `parseCookieHeader`
from `@supabase/ssr`. In Python, read the session from your framework's own
request. More on what `authorize` sees:
[Authorization and the host](authorization.md).

## How it runs on Supabase

- **No worker or cron job.** Each request to the payment routes also checks
  the wallet for settled invoices, through a lock in your database. A payer
  who closes the tab is settled on the next request.
- **One database.** Orders and payment attempts share it, so `onPaid` marks
  the order paid in the same transaction that records the payment.
- **No service role key.** OpenReceive talks SQL through the pooler. It never
  uses the Data API or Supabase's service role key.

More detail: [Payment storage](storage.md), [Deploying](deploying.md),
[Security](security.md).
