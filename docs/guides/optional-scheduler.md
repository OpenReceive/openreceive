# Optional Scheduler

OpenReceive runs inside your normal web process. The browser checkout watches
backend payment status while the visitor is present. For extra recovery after a
visitor closes the page, run a small server-side recovery job on a schedule:

```sh
npx openreceive poll --once
```

The scheduler is optional. It uses the same server-only config as your web app
and runs your idempotent `onPaid` hook for newly paid invoices.

```text
web process        mounts /openreceive/v1
browser checkout   watches backend payment status
optional scheduler runs openreceive poll --once
```

## Package Script

Add a script so every platform runs the same command:

```json
{
  "scripts": {
    "openreceive:poll": "openreceive poll --once"
  }
}
```

The command imports `openreceive.config.mjs` by default. If your config lives
elsewhere, pass `--config path/to/openreceive.config.mjs`.

## Vercel

Vercel Cron invokes HTTP routes, not arbitrary commands. Create a server-only
cron route that runs the CLI in-process:

```ts
// app/api/openreceive-poll/route.ts
import { runOpenReceiveCli } from "@openreceive/node/cli";
import { openreceive } from "@/server/openreceive";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const output: string[] = [];
  const code = await runOpenReceiveCli({
    argv: ["poll", "--once", "--config", "server/openreceive.ts"],
    env: process.env,
    cwd: process.cwd(),
    stdout: { write: (message) => output.push(message) },
    stderr: { write: (message) => output.push(message) },
    loadConfigModule: async () => ({ openreceive })
  });

  return Response.json({ ok: code === 0, output }, { status: code === 0 ? 200 : 500 });
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

Set `OPENRECEIVE_NWC`, `OPENRECEIVE_STORE=postgres://...`, and
`OPENRECEIVE_NAMESPACE` in Project Settings -> Environment Variables.

## Cloudflare Workers

Use a Postgres-backed store. Do not use Workers KV for invoice storage.

```toml
compatibility_flags = [ "nodejs_compat" ]
compatibility_date = "2026-06-23"

[triggers]
crons = [ "*/10 * * * *" ]
```

```sh
wrangler secret put OPENRECEIVE_NWC
wrangler secret put OPENRECEIVE_STORE
```

In the scheduled handler:

```ts
import { runOpenReceiveCli } from "@openreceive/node/cli";
import { openreceive } from "./server/openreceive";

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runOpenReceiveCli({
      argv: ["poll", "--once", "--config", "server/openreceive.ts"],
      env: env as unknown as NodeJS.ProcessEnv,
      cwd: ".",
      stdout: { write: console.log },
      stderr: { write: console.error },
      loadConfigModule: async () => ({ openreceive })
    }));
  }
};
```

## Netlify

Set `OPENRECEIVE_NWC`, `OPENRECEIVE_STORE=postgres://...`, and
`OPENRECEIVE_NAMESPACE` in Site configuration -> Environment variables.

```ts
// netlify/functions/openreceive-poll.ts
import { runOpenReceiveCli } from "@openreceive/node/cli";
import { openreceive } from "../../server/openreceive";

export default async () => {
  const code = await runOpenReceiveCli({
    argv: ["poll", "--once"],
    env: process.env,
    cwd: process.cwd(),
    stdout: { write: console.log },
    stderr: { write: console.error },
    loadConfigModule: async () => ({ openreceive })
  });

  return new Response(null, { status: code === 0 ? 204 : 500 });
};

export const config = {
  schedule: "*/10 * * * *"
};
```

## Railway And Render

Deploy the web service normally with `/openreceive/v1` mounted. Add a scheduled
job that runs:

```sh
npm run openreceive:poll
```

Set `OPENRECEIVE_NWC`, `OPENRECEIVE_STORE=postgres://...`, and
`OPENRECEIVE_NAMESPACE` as service secrets.

## Heroku

Attach Heroku Postgres and set:

```sh
heroku config:set OPENRECEIVE_NWC=nostr+walletconnect://...
heroku config:set OPENRECEIVE_STORE="$DATABASE_URL"
heroku config:set OPENRECEIVE_NAMESPACE=prod
```

Add Heroku Scheduler and run:

```sh
npm run openreceive:poll
```

## Fly.io

Set secrets:

```sh
fly secrets set OPENRECEIVE_NWC=nostr+walletconnect://...
fly secrets set OPENRECEIVE_STORE=postgres://...
fly secrets set OPENRECEIVE_NAMESPACE=prod
```

Run a one-shot Machine or platform scheduler command:

```sh
npm run openreceive:poll
```

## ECS

Store `OPENRECEIVE_NWC`, `OPENRECEIVE_STORE`, and `OPENRECEIVE_NAMESPACE` in
your server-side secret manager. Add an EventBridge Scheduler target that runs
the same container image with:

```sh
npm run openreceive:poll
```

## systemd Or VPS

`local-sqlite` is acceptable for one machine on durable disk. If more than one
machine, process, or scheduler can touch the same namespace, point all of them
at one shared durable OpenReceive store. In v0.1 Node, use Postgres for that.

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

## Coolify, Dokploy, And Kamal

Deploy the web container normally. Configure the platform scheduler to run:

```sh
npm run openreceive:poll
```

Store `OPENRECEIVE_NWC`, `OPENRECEIVE_STORE`, and `OPENRECEIVE_NAMESPACE` in
the platform's server-side secret store.

## Settlement Hooks

Your `onPaid` hook may run again after a crash. For example, the hook could
mark an order paid successfully, then the process could stop before
OpenReceive finishes recording that work.

`orderUuid` is guaranteed to be the unique app order key for this checkout, so
use it for idempotent fulfillment. That prevents repeated calls from
double-shipping, double-crediting, or double-emailing. Invoice details are
available only if your app wants extra audit or correlation data.

## Production Checklist

- Keep `OPENRECEIVE_NWC` server-side only.
- Use durable storage for production.
- Configure `OPENRECEIVE_NAMESPACE` when multiple apps share one store.
- Use your app's normal route protection when needed.
- Use `orderUuid` for idempotent fulfillment.
- Run `npm run typecheck && npm run test:js` before deploy.
