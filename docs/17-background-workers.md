# Route-Driven Recovery

OpenReceive v0.1-v2 does not require a backend worker, notification listener,
webhook bridge, or in-memory event bus. Mount the HTTP routes in your app,
configure server-side NWC, and use durable OpenReceive storage as the
coordination point.

```text
web process        mounts /openreceive/v1
browser checkout   polls /openreceive/v1/invoices/lookup
optional scheduler POSTs /openreceive/v1/poll
```

Settlement is discovered only by `lookup_invoice`. The interactive lookup route
checks one invoice through store-enforced gates. A bounded background sweep may
run after route responses, and an optional scheduler can call `/poll` for one
recovery pass. There is no long-running process to deploy.

## Node

Use a durable store, usually through `OPENRECEIVE_STORE`:

```sh
OPENRECEIVE_STORE=local-sqlite
OPENRECEIVE_NAMESPACE=default
OPENRECEIVE_NWC=...
```

The Node CLI keeps only one-shot poll support:

```json
{
  "scripts": {
    "openreceive:poll": "openreceive poll --once"
  }
}
```

Run it from a platform scheduler only when you want extra recovery beyond
route-triggered lookup and sweep behavior. The scheduler request must be
authorized with your `auth.poll` hook or `OPENRECEIVE_CRON_SECRET`.

## Common Hosts

- Vercel, Netlify, Cloudflare, Fly Machines, Railway, Render, Heroku, ECS, and
  systemd deployments can run just the web service.
- If the platform supports scheduled jobs, schedule `openreceive poll --once`
  or an authenticated `POST /openreceive/v1/poll`.
- Do not deploy a notification listener. NWC `payment_received` notifications
  are passive hints and are not settlement authority.
- Do not run checkout settlement from frontend code. Browsers receive only
  display-safe invoices and call backend lookup routes.

## Settlement Hooks

Settlement hooks are delivered at least once. OpenReceive uses a store-backed
CAS lease to prevent concurrent duplicate execution, but a crash after your
hook succeeds and before OpenReceive records completion can replay the hook.
Deduplicate by `payment_hash` or make the effect conditional in your app store.

## Production Checklist

- Use a durable `OPENRECEIVE_STORE`, not memory storage.
- Configure `OPENRECEIVE_NAMESPACE` when multiple apps share one store.
- Protect create/read/lookup/poll routes with app auth and CSRF rules.
- Keep `OPENRECEIVE_NWC` server-side only.
- Make settlement hooks idempotent by `payment_hash`.
- Run `openreceive doctor` during deploy checks.
