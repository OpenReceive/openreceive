# Using OpenReceive with coding agents

OpenReceive publishes machine-readable specifications and installable agent
skills, so a coding agent can add Bitcoin Lightning checkout to your
application — or debug one — without guessing.

## Building an integration?

Install the **integrate-openreceive** skill (it detects your stack and carries
the full quickstart), or paste the one-prompt agent directions:

- Claude Code: `/plugin marketplace add OpenReceive/openreceive`, then
  `/plugin install openreceive`
- Skills CLI (Codex, Cursor, and other SKILL.md-compatible tools):
  `npx skills add OpenReceive/openreceive`
- For GitHub Copilot and other agents, install into **your application's**
  `.agents/skills/` with `npx skills add OpenReceive/openreceive` or the
  package command below. The OpenReceive repository's own `.agents/skills/`
  is only discovered when that repository is the workspace.
- No installer? Copy the agent directions for your stack and paste them into
  your agent: [Node (Express)](https://openreceive.org/agent-directions/node/full.md) ·
  [Fastify](https://openreceive.org/agent-directions/fastify/full.md) ·
  [Next.js](https://openreceive.org/agent-directions/next/full.md) ·
  [Rails](https://openreceive.org/agent-directions/rails/full.md) ·
  [PHP](https://openreceive.org/agent-directions/php/full.md) ·
  [Laravel](https://openreceive.org/agent-directions/laravel/full.md) ·
  [Django](https://openreceive.org/agent-directions/django/full.md) ·
  [FastAPI](https://openreceive.org/agent-directions/fastapi/full.md) ·
  [WordPress + WooCommerce](https://openreceive.org/agent-directions/woocommerce/full.md) ·
  [BTCPay Server](https://openreceive.org/agent-directions/btcpay/full.md). Each
  is self-contained, quickstart included. To hand an agent a link instead, drop
  `/full` from the URL: that short page tells it to download the full file with
  its shell.

One package per ecosystem bundles an offline copy: `@openreceive/node`, the
core `openreceive` gem, Python's `openreceive`, and Composer's
`openreceive/openreceive`. From your application's directory, install that copy
where your agent can discover it:

| Stack | Install bundled skills |
| --- | --- |
| Node | `npx openreceive skills install` |
| Python (Django or FastAPI) | `openreceive skills install` |
| Rails | `bin/rails openreceive:skills` |
| Laravel | `php artisan openreceive:skills` |

These commands write both skills to `.agents/skills/`; add
`--dir .claude/skills` for Claude Code. Re-running replaces only the two
OpenReceive skill folders, removing obsolete files and leaving other skills
alone. Plain PHP, non-Rails Ruby, and WordPress projects can use
`npx skills add OpenReceive/openreceive`. Installing a library alone does not
make its bundled skills discoverable.

A **debug-openreceive-payment** skill ships alongside: boot failures, 403/404/
409 semantics, settlement timing, swap refunds, each with its fix.

## Working on OpenReceive itself?

Read
[AGENTS.md](https://github.com/OpenReceive/openreceive/blob/master/AGENTS.md)
in the repository — the architectural invariants a change must not violate.

## Generating an HTTP client, or verifying routes?

Use the normative OpenAPI contract:
[https://openreceive.org/openapi.yaml](https://openreceive.org/openapi.yaml).
It is the exact `spec/openapi/openreceive-http.v1.yaml` file from the
repository — the same contract the shipped adapters and the Rails engine are
tested against.

## Giving an agent documentation context?

Start from [https://openreceive.org/llms.txt](https://openreceive.org/llms.txt)
— every guide as raw markdown, one fetch away. Any guide page is also
available as markdown by appending `.md` to its URL.

Questions, or a problem with the library itself:
[https://openreceive.org/contact](https://openreceive.org/contact)
