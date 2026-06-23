# Background Process Deployment

OpenReceive does not require a worker, wallet notification listener, webhook
bridge, or in-memory event bus. Mount `/openreceive/v1` in your web app and let
the browser checkout call backend lookup routes.

```text
web process        mounts /openreceive/v1
browser checkout   polls /openreceive/v1/invoices/lookup
optional scheduler runs openreceive poll --once
```

Settlement is discovered by backend `lookup_invoice`. A route lookup checks the
requested invoice, and an optional scheduler can run one bounded recovery pass.

## Scheduler Command

Add a package script when your host supports scheduled jobs:

```json
{
  "scripts": {
    "openreceive:poll": "openreceive poll --once"
  }
}
```

Use `OPENRECEIVE_CRON_SECRET` or `authorize.scheduler` for scheduler access.
Do not expose `OPENRECEIVE_NWC` to browser code or scheduled HTTP clients.

## Common Hosts

Vercel:

- Deploy the Next.js App Router route under `/openreceive/v1`.
- Use Vercel Cron to call an authenticated `POST /openreceive/v1/poll`, or run
  no scheduler and rely on checkout lookups.
- Use Postgres or another durable store for production.

Cloudflare:

- Use a Node-compatible runtime for the OpenReceive server route.
- Schedule an authenticated `POST /openreceive/v1/poll` with Cron Triggers when
  you want extra recovery.
- Do not use Workers KV as invoice storage.

Netlify:

- Mount OpenReceive routes in a Node function or framework adapter.
- Use Scheduled Functions for an authenticated `POST /openreceive/v1/poll`.
- Use durable external storage for production.

Railway and Render:

- Run the normal web service.
- Add a cron/scheduled job that runs `npm run openreceive:poll` when desired.
- Configure `OPENRECEIVE_NWC`, `OPENRECEIVE_STORE`, and
  `OPENRECEIVE_NAMESPACE` as server-only environment variables.

Heroku:

- Run only the web dyno for checkout.
- Use Heroku Scheduler for `npm run openreceive:poll` if you want extra
  recovery.
- Use Heroku Postgres for production storage.

Fly.io:

- Run the web app on Machines.
- Use Fly Machines, a platform scheduler, or an authenticated HTTP call for
  `openreceive poll --once`.
- Use Postgres for multi-machine deployments.

ECS:

- Run the web service behind your load balancer.
- Use EventBridge Scheduler to run a one-shot task or call
  `POST /openreceive/v1/poll`.
- Store secrets in your normal server-side secret manager.

systemd or VPS:

- Run your web app as the normal service.
- Add a timer for `npm run openreceive:poll`.
- `local-sqlite` is acceptable for single-machine self-hosting; use Postgres
  before adding more machines.

Coolify, Dokploy, and Kamal:

- Deploy the web container normally.
- Add a scheduled command or authenticated HTTP poll call only when you want
  extra recovery.
- Keep `OPENRECEIVE_NWC` and database credentials in server-side secrets.

## Settlement Hooks

Your `onPaid` hook may run again after a crash. For example, the hook
could mark an order paid successfully, then the process could stop before
OpenReceive records that the hook completed.

Make the hook idempotent. Use `payment_hash`, invoice id, or your app's order id
to ensure repeated calls do not double-ship, double-credit, or double-email.

## Production Checklist

- Keep `OPENRECEIVE_NWC` server-side only.
- Use durable storage for production.
- Configure `OPENRECEIVE_NAMESPACE` when multiple apps share one store.
- Protect create, read, lookup, refresh, and poll routes with app auth and CSRF
  rules.
- Make `onPaid` idempotent by `payment_hash` or order id.
- Run `openreceive doctor` during deploy checks.
