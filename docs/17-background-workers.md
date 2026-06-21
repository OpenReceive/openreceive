# Background Process Deployment

OpenReceive needs your web server plus one lightweight backend worker in
production:

```text
web                 npm start
openreceive-worker  npx openreceive worker
```

A background process is just a command your hosting provider keeps running from
the same codebase, with the same server-only environment variables as the web
app. It is not browser code. Do not run it inside an HTTP request.

Always run `openreceive worker` on hosts that can keep a backend process alive.
It starts both settlement polling and payment notification listening inside one
Node process. You do not need a wallet-specific notification decision in your
deploy checklist: if no notifications arrive, polling remains the recovery and
settlement fallback.

OpenReceive loads `./openreceive.config.mjs` by default. Use `--config` only
when your config lives somewhere else.

The poll process must recover invoices even after their local `expires_at`
timestamp has passed. OpenReceive only closes an invoice as expired after it
has asked the wallet after expiry and settlement is still not proven.

Add these scripts:

```json
{
  "scripts": {
    "openreceive:worker": "openreceive worker",
    "openreceive:poll:once": "openreceive poll --once"
  }
}
```

## Persistent Node Hosts

Use this shape on hosts that support always-running services, processes, dynos,
or workers.

### Railway

Create two services from the same repo:

```text
web                 npm start
openreceive-worker  npx openreceive worker
```

Attach the same Postgres database and the same server-only environment
variables to both services. Expose only the `web` service to the public
internet.

### Render

Create one Web Service and one Background Worker:

```yaml
services:
  - type: web
    name: web
    env: node
    buildCommand: npm ci && npm run build
    startCommand: npm start
  - type: worker
    name: openreceive-worker
    env: node
    buildCommand: npm ci && npm run build
    startCommand: npx openreceive worker
```

Give both services the same `OPENRECEIVE_NWC` and database environment.

### Heroku

Add a `Procfile`:

```Procfile
web: npm start
openreceive-worker: npx openreceive worker
```

Then scale the two process types:

```sh
heroku ps:scale web=1 openreceive-worker=1
```

### Fly.io

Use Fly process groups. Only the `web` process needs an HTTP service:

```toml
[processes]
web = "npm start"
openreceive-worker = "npx openreceive worker"

[[services]]
processes = ["web"]
internal_port = 3000
protocol = "tcp"
```

Deploy with the same secrets available to each process group.

### DigitalOcean App Platform

Create one Web Service and one Worker component from the same repo:

```text
Web Service command: npm start
Worker command:      npx openreceive worker
```

Connect both components to the same database and environment variables.

### VPS Or Hostinger

With PM2, create `ecosystem.config.cjs`:

```js
module.exports = {
  apps: [
    {
      name: "web",
      script: "npm",
      args: "start"
    },
    {
      name: "openreceive-worker",
      script: "npm",
      args: "run openreceive:worker"
    }
  ]
};
```

Then run:

```sh
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

With systemd, create one service for the worker and keep `Restart=always`:

```ini
[Unit]
Description=OpenReceive worker
After=network.target

[Service]
WorkingDirectory=/var/www/myapp
EnvironmentFile=/var/www/myapp/.env
ExecStart=/usr/bin/npm run openreceive:worker
Restart=always

[Install]
WantedBy=multi-user.target
```

Start and enable it:

```sh
sudo systemctl enable --now openreceive-worker
```

### Coolify, Dokploy, And Kamal

Create two app services or roles from the same image/repo and assign these
commands:

```text
web                 npm start
openreceive-worker  npx openreceive worker
```

Route traffic only to `web`. Give both the same `OPENRECEIVE_NWC`,
database URL, and other server-only app secrets.

## Serverless And Frontend Hosts

Serverless functions are short-lived. Use a scheduled function to run polling
once when you do not have a persistent worker. If you want notification wakeups
too, run one persistent companion service with `npx openreceive worker`; that
worker handles both polling and listening.

Create a one-shot polling helper in server-only code:

```ts
import { createOpenReceiveExpressSettlementPollingRunner } from "@openreceive/express";
import { openreceive } from "@/server/openreceive-config";

export async function runOpenReceivePollOnce() {
  const runner = createOpenReceiveExpressSettlementPollingRunner(openreceive);
  try {
    return await runner.recoverOpenInvoices();
  } finally {
    runner.stop();
  }
}
```

### Vercel

Add a Node.js route:

```ts
// src/app/api/openreceive/poll/route.ts
import { runOpenReceivePollOnce } from "@/server/openreceive-poll";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const result = await runOpenReceivePollOnce();
  return Response.json(result);
}
```

Add a cron entry:

```json
{
  "crons": [
    {
      "path": "/api/openreceive/poll",
      "schedule": "* * * * *"
    }
  ]
}
```

For notification wakeups, deploy one persistent companion worker on Railway,
Render, Fly.io, or a VPS:

```sh
npx openreceive worker
```

### Netlify

Create a scheduled function:

```ts
// netlify/functions/openreceive-poll.ts
import { runOpenReceivePollOnce } from "../../src/server/openreceive-poll";

export default async () => {
  const result = await runOpenReceivePollOnce();
  return new Response(JSON.stringify(result), {
    headers: {
      "content-type": "application/json"
    }
  });
};

export const config = {
  schedule: "* * * * *"
};
```

For notification wakeups, use one persistent companion host running:

```sh
npx openreceive worker
```

### Cloudflare Pages Or Workers

If your OpenReceive backend runs inside a Worker-compatible Node bundle, call
the same one-shot polling helper from the `scheduled` handler. Otherwise, have
a Cron Trigger call a protected polling endpoint on your Node backend:

```ts
export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      fetch("https://api.example.com/api/openreceive/poll", {
        headers: {
          authorization: `Bearer ${env.OPENRECEIVE_CRON_SECRET}`
        }
      })
    );
  }
};
```

Keep the NWC connection string server-only. Do not put it in Pages client
bundles.

### Google Cloud Run

Use a Cloud Run Service for the web app. For polling, use a Cloud Run Job or a
Cloud Scheduler request that runs:

```sh
npx openreceive poll --once
```

For notification wakeups, use an always-running container host, VM, or GKE
deployment running `npx openreceive worker`. Cloud Run Jobs are
run-to-completion jobs, not long-running notification listeners.

### AWS Lambda, SST, Or OpenNext

Use the same serverless shape as Vercel:

```text
HTTP route       /api/openreceive/poll
scheduled event  calls runOpenReceivePollOnce()
worker process   npx openreceive worker on ECS, EC2, App Runner, or another persistent host
```

Do not depend on browser polling or client-side timers for settlement. The
scheduled backend poll is what recovers invoices after deploys, restarts, and
missed notifications.
