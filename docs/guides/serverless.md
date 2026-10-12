# Bitcoin checkout on serverless hosts

Serverless hosts run your server code in short-lived instances that start on
demand and stop when traffic does. OpenReceive runs in them as is, because it
has no process of its own: each request to its payment routes does its own
work, and everything it keeps is in your app's database. Your server code
creates each Lightning invoice, and the payment goes straight to your wallet.
There is no OpenReceive account, no API key and no background worker.

Optional swaps let customers pay with **USDT, USDC, SOL, and ETH**. A swap
provider you configure converts the payment to **BTC over Lightning**, and it
settles into the same wallet. Available assets and networks depend on the
provider.

Start from your framework's quickstart: [Next.js](quickstart-next.md),
[Express](quickstart-node.md), [Fastify](quickstart-fastify.md),
[FastAPI](quickstart-fastapi.md) or [Django](quickstart-django.md). This
guide covers what changes when the server is serverless.

## What every serverless app needs

- **One database that every instance shares.** Payment attempts, the
  settlement record and the lock on wallet scans all live in it. SQLite does
  not work here: each instance has its own disk, which is wiped when the
  instance stops, and no two instances see the same file. Use Postgres,
  reached through its pooler.
- **No cron job and no worker.** Each request to the payment routes first
  checks the wallet for settled invoices, through a lock in your database, so
  a payer who closes the tab is settled by the next request from anyone. See
  [the durable scan gate](deploying.md#the-durable-scan-gate). A cron job
  cannot stand in for that, and nothing needs one: a scheduled run every few
  minutes is not a checkout, and a once-a-day run is far too slow.
- **A Node or Python server runtime.** Node 22 or newer, or Python 3.10 or
  newer. An Edge runtime is not a Node server: keep the payment route on Node.
  For Cloudflare Workers, see the [TanStack Start recipe](../recipes/tanstack-start.md).
- **The codes in the host's environment variables.** Put `NWC_URI` (and
  `LSC_URI_PRIMARY` for swaps) in the host's settings for secrets, never in
  the code or a chat. Every instance reads the same values.
- **A function timeout of 30 seconds.** Creating an invoice is a round trip
  to your wallet through a relay, and a request may also scan the wallet for
  payments, which OpenReceive cuts off at 9 seconds. In our tests a checkout
  request took one to four seconds.

## Pooled connection strings

A serverless app can start many instances at once, and each one opens its own
database connections. A pooler sits between them and the database and shares
a few real connections among them. Use the pooled connection string for your
app, and the direct one for migrations.

OpenReceive locks each order inside a transaction (`pg_advisory_xact_lock`),
which transaction poolers support. Session-level locks, which poolers break,
are never used. CI runs the payment storage through PgBouncer in transaction
mode with prepared statements off, as strict as the strictest host below:
Node with `pg`, Knex, Prisma (with `@prisma/adapter-pg`) and TypeORM, and
Python with SQLAlchemy and psycopg.

| Database | Pooled connection for the app | Notes |
| --- | --- | --- |
| Neon, including Vercel's Neon integration | The host with `-pooler` in its name. On Vercel that is `DATABASE_URL`; `DATABASE_URL_UNPOOLED` is the direct one | PgBouncer in transaction mode |
| Supabase | The transaction pooler, port `6543` | Node and Python must trust Supabase's own certificate authority: see [Supabase](supabase.md) |
| Cloud SQL for PostgreSQL | Managed Connection Pooling in transaction mode (Enterprise Plus edition), or the instance's Unix socket with a small pool | Cloud Run allows 100 connections to Cloud SQL per instance |
| Amazon RDS and Aurora PostgreSQL | RDS Proxy | AWS documents that transaction-level advisory locks, the only kind OpenReceive takes, do not pin a connection |
| Aurora DSQL | Not supported | It has no advisory locks, and it resolves conflicts at commit instead |

Keep each instance's pool small: `max: 1` to `5` with `pg`, `pool_size=1` to
`5` with SQLAlchemy. Many instances times a large pool runs the database out
of connections.

### Python on a pooler

A transaction pooler hands each transaction whichever database connection is
free. Once a statement has run five times on a connection, psycopg prepares
it on the database, and under load a later transaction fails with
`prepared statement "_pg3_0" already exists`. Turn preparing off on the
engine you give OpenReceive:

```python
from sqlalchemy import create_engine

engine = create_engine(
    os.environ["DATABASE_URL"],  # postgresql+psycopg://… the pooled URL
    connect_args={"prepare_threshold": None},
    pool_size=2,
)
```

Django does not prepare statements on PostgreSQL by default, so it needs no
change. If your own code uses `.iterator()`, add
`"DISABLE_SERVER_SIDE_CURSORS": True` to the database settings.

## Vercel

Vercel runs Next.js route handlers as Node functions, and OpenReceive's
Next.js package works there as is. [Vercel and v0](vercel.md) covers it, with
a starter that deploys with a Neon database.

## Netlify

- **Next.js**: Netlify's Next.js adapter runs route handlers as Netlify
  Functions on Node, so the [Next.js quickstart](quickstart-next.md) applies.
  Keep the payment route on Node, never `runtime = "edge"`.
- **Node version**: functions use the Node version of your build. Set Node 22
  or 24.
- **Timeout**: synchronous functions run for up to 60 seconds on every plan,
  which is enough.
- **Database**: use a pooled URL from your Postgres provider (Neon, Supabase).
  Netlify Database sets `NETLIFY_DB_URL`. Its docs do not say whether that URL
  is pooled, and we have not tested it.
- **No scheduled function**: the payment routes settle payments themselves.

## AWS Lambda

- **Your server, unchanged**: run the Express or Fastify app with the
  [AWS Lambda Web Adapter](https://github.com/aws/aws-lambda-web-adapter),
  which passes Lambda's requests to an ordinary HTTP server. In a container
  image it is one line:

  ```dockerfile
  COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:1.1.0 /lambda-adapter /opt/extensions/lambda-adapter
  ```

  Use the `nodejs22.x` or `nodejs24.x` runtime, or a Node 22 or newer image.
- **Timeout**: Lambda's default is 3 seconds, which is too short. Set 30
  seconds. An API Gateway HTTP API stops waiting at 30 seconds and a REST API
  at 29; a function URL waits as long as the function runs.
- **Between requests**: Lambda freezes an instance when a request ends.
  Payment attempts and the scan lock are in your database, and OpenReceive
  starts no timer on a web request, so a frozen instance loses nothing.
- **Database**: RDS Proxy for RDS or Aurora PostgreSQL, or a pooled URL from
  Neon or Supabase. Not Aurora DSQL.

## Google Cloud Run

- **Your server, unchanged**: deploy the Docker image from your stack's
  section in [Deploying](deploying.md).
- **Billing**: the default request-based billing gives an instance CPU only
  while it serves a request. That is all OpenReceive needs. Leave out the
  optional notifications worker: it runs all the time and serves no
  requests, which is not what a Cloud Run service does.
- **Timeout**: requests may run for 5 minutes by default, which is enough.
- **Disk**: an instance's files live in its memory and vanish when it stops,
  so no SQLite.
- **Cloud SQL**: with a Cloud SQL connection added to the service, the
  instance's Unix socket is at `/cloudsql/PROJECT:REGION:INSTANCE`. Point
  the driver at it, and keep the pool small:

  ```ts
  import pg from "pg";

  const pool = new pg.Pool({
    host: `/cloudsql/${process.env.INSTANCE_CONNECTION_NAME}`,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    max: 5,
  });
  ```

  Cloud SQL's Managed Connection Pooling runs in transaction mode with
  prepared statements off. OpenReceive's lock works there; Python needs
  `prepare_threshold=None`, as above.

## Google AI Studio

AI Studio's Build mode makes full-stack apps with a Node server, and each
one it deploys is a Cloud Run service, so the Cloud Run notes above apply.

- **Ask for Cloud SQL.** AI Studio can give an app Cloud SQL for PostgreSQL
  or Firestore. OpenReceive keeps payments in SQL, so it needs Cloud SQL.
- **Codes go in Secrets.** Put `NWC_URI` in the app's secrets in the
  **Settings** tab, never in the chat. The server code reads it from the
  environment.

## Cloudflare Workers

A Worker is not a Node server, and it cannot keep a database pool between
requests. The [TanStack Start recipe](../recipes/tanstack-start.md) shows the
route, which builds and closes its pool and its OpenReceive stack in each
request. With Supabase, it stores payments through Supabase's HTTPS API
instead: see [Lovable](lovable.md).

## What we test

- **Vercel**: coding agents integrated a Next.js shop from our directions,
  and the shop, deployed to Vercel with Neon, issued a real invoice and
  refused a stranger on the live site. See [Vercel and v0](vercel.md).
- **Transaction poolers**: every CI run, for Node and Python, as above.
- **Cloudflare Workers**: every CI run, with a wallet on a local relay and
  Postgres behind PgBouncer, and Supabase over HTTPS.
- **Netlify, AWS Lambda and Google Cloud Run**: not yet run by us. Each runs
  an ordinary Node or Python server, which the quickstarts cover, and the
  notes above are what differs.

More detail: [Deploying](deploying.md), [Payment storage](storage.md),
[Supabase](supabase.md), [Security](security.md).
