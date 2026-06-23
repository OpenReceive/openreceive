# Deployment And Recovery

OpenReceive runs inside your normal web process. Mount `/openreceive/v1`, and
the browser checkout polls a backend lookup route to learn when an invoice
settles. For extra recovery, optionally call `POST /openreceive/v1/poll` or
`openreceive poll --once` on a schedule.

```text
web process        mounts /openreceive/v1
browser checkout   polls /openreceive/v1/invoices/lookup
optional scheduler POST /openreceive/v1/poll or openreceive poll --once
```

Settlement is discovered by backend `lookup_invoice`. Route lookups and
scheduled poll passes coordinate through the OpenReceive store.

## Package Script

Add a package script when your host supports scheduled commands:

```json
{
  "scripts": {
    "openreceive:poll": "openreceive poll --once"
  }
}
```

Set `OPENRECEIVE_CRON_SECRET` or `authorize.scheduler` before exposing
`/openreceive/v1/poll`.

## Vercel

1. Put the catch-all route at `app/openreceive/v1/[...openreceive]/route.ts`:

```ts
import { openreceive } from "@/server/openreceive";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const handle = (request: Request) => openreceive.handleFetch(request);

export const GET = handle;
export const POST = handle;
```

2. In Project -> Settings -> Environment Variables, set:

```sh
OPENRECEIVE_NWC=nostr+walletconnect://...
OPENRECEIVE_STORE=postgres://...
OPENRECEIVE_NAMESPACE=prod
OPENRECEIVE_CRON_SECRET=replace-with-a-random-secret
```

3. Optional recovery: add a GET cron shim because Vercel Cron calls a GET
   path from `vercel.json`.

```ts
// app/api/openreceive-poll/route.ts
import { openreceive } from "@/server/openreceive";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.OPENRECEIVE_CRON_SECRET;
  if (secret === undefined || secret.length === 0) {
    return new Response("OPENRECEIVE_CRON_SECRET is required", { status: 500 });
  }

  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  return openreceive.handleFetch(new Request(
    new URL("/openreceive/v1/poll", request.url),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`
      }
    }
  ));
}
```

```json
{
  "crons": [
    {
      "path": "/api/openreceive-poll",
      "schedule": "*/10 * * * *"
    }
  ]
}
```

## Cloudflare Workers

1. Enable Node compatibility in `wrangler.toml`:

```toml
compatibility_flags = [ "nodejs_compat" ]
compatibility_date = "2026-06-23"
```

2. Set server-side secrets:

```sh
wrangler secret put OPENRECEIVE_NWC
wrangler secret put OPENRECEIVE_STORE
wrangler secret put OPENRECEIVE_CRON_SECRET
```

Use a Postgres URL for `OPENRECEIVE_STORE`. Do not use Workers KV as the
invoice store.

3. Optional recovery: add a Cron Trigger in `wrangler.toml`:

```toml
[triggers]
crons = [ "*/10 * * * *" ]
```

4. In the Worker `scheduled()` handler, call the OpenReceive poll route:

```ts
import { openreceive } from "./server/openreceive";

export default {
  fetch(request: Request): Promise<Response> {
    return openreceive.handleFetch(request);
  },

  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const secret = env.OPENRECEIVE_CRON_SECRET;
    ctx.waitUntil(openreceive.handleFetch(new Request(
      "https://worker.internal/openreceive/v1/poll",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`
        }
      }
    )));
  }
};
```

## Netlify

1. Mount OpenReceive routes in a Node function or framework adapter.
2. Set `OPENRECEIVE_NWC`, `OPENRECEIVE_STORE=postgres://...`,
   `OPENRECEIVE_NAMESPACE`, and `OPENRECEIVE_CRON_SECRET` in Site
   configuration -> Environment variables.
3. Optional recovery: add a Scheduled Function that calls your mounted route:

```ts
export default async () => {
  await fetch(`${process.env.URL}/openreceive/v1/poll`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENRECEIVE_CRON_SECRET}`
    }
  });
};

export const config = {
  schedule: "*/10 * * * *"
};
```

## Railway And Render

1. Deploy the normal web service with `/openreceive/v1` mounted.
2. Set `OPENRECEIVE_NWC`, `OPENRECEIVE_STORE=postgres://...`,
   `OPENRECEIVE_NAMESPACE`, and `OPENRECEIVE_CRON_SECRET` as service secrets.
3. Optional recovery: add a scheduled job that runs:

```sh
npm run openreceive:poll
```

## Heroku

1. Deploy the web dyno with `/openreceive/v1` mounted.
2. Attach Heroku Postgres and set:

```sh
heroku config:set OPENRECEIVE_STORE="$DATABASE_URL"
heroku config:set OPENRECEIVE_NAMESPACE=prod
heroku config:set OPENRECEIVE_CRON_SECRET="$(openssl rand -hex 32)"
```

3. Optional recovery: add Heroku Scheduler and run:

```sh
npm run openreceive:poll
```

## Fly.io

1. Deploy the web app on Machines with `/openreceive/v1` mounted.
2. Set secrets:

```sh
fly secrets set OPENRECEIVE_NWC=nostr+walletconnect://...
fly secrets set OPENRECEIVE_STORE=postgres://...
fly secrets set OPENRECEIVE_NAMESPACE=prod
fly secrets set OPENRECEIVE_CRON_SECRET=replace-with-a-random-secret
```

3. Optional recovery: run a one-shot Machine or platform scheduler command:

```sh
npm run openreceive:poll
```

## ECS

1. Run the web service behind your load balancer with `/openreceive/v1`
   mounted.
2. Store `OPENRECEIVE_NWC`, `OPENRECEIVE_STORE`, `OPENRECEIVE_NAMESPACE`, and
   `OPENRECEIVE_CRON_SECRET` in your server-side secret manager.
3. Optional recovery: add an EventBridge Scheduler target that runs the same
   container command:

```sh
npm run openreceive:poll
```

## systemd Or VPS

1. Run your web app as the normal service.
2. Set `OPENRECEIVE_NWC`, `OPENRECEIVE_STORE`, and `OPENRECEIVE_NAMESPACE` in
   the service environment.
3. Optional recovery: add a timer:

```ini
[Unit]
Description=OpenReceive one-shot poll

[Service]
Type=oneshot
WorkingDirectory=/srv/shop
EnvironmentFile=/srv/shop/.env
ExecStart=/usr/bin/npm run openreceive:poll
```

```ini
[Unit]
Description=Run OpenReceive one-shot poll every 10 minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=10min
Unit=openreceive-poll.service

[Install]
WantedBy=timers.target
```

`local-sqlite` is acceptable for single-machine self-hosting on durable disk.
Use Postgres before adding more machines.

## Coolify, Dokploy, And Kamal

1. Deploy the web container normally with `/openreceive/v1` mounted.
2. Store `OPENRECEIVE_NWC`, `OPENRECEIVE_STORE`, `OPENRECEIVE_NAMESPACE`, and
   `OPENRECEIVE_CRON_SECRET` in the platform's server-side secret store.
3. Optional recovery: configure the platform scheduler to run:

```sh
npm run openreceive:poll
```

## Settlement Hooks

Your `onPaid` hook may run again after a crash. For example, the hook could
mark an order paid successfully, then the process could stop before
OpenReceive records that the hook completed.

Make the hook idempotent. Use `payment_hash`, invoice id, or your app's order
id to ensure repeated calls do not double-ship, double-credit, or double-email.

## Production Checklist

- Keep `OPENRECEIVE_NWC` server-side only.
- Use durable storage for production.
- Configure `OPENRECEIVE_NAMESPACE` when multiple apps share one store.
- Protect create, read, lookup, refresh, and poll routes with app auth and CSRF
  rules.
- Make `onPaid` idempotent by `payment_hash` or order id.
- Run `openreceive doctor` during deploy checks.
