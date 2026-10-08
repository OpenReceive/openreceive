# Directions eval

On-demand check of what a coding agent does with a published OpenReceive directions file. It is not part of CI. Cursor follows the directions in a disposable copy of the shop, and the harness answers as the merchant, pasting live codes from the repo-root `.env` when asked. A run spends model tokens and takes several minutes. Bitcoin is the required payment; a configured swap provider can also convert USDT, USDC, SOL, and ETH into BTC over Lightning in the merchant's wallet. Asset and network availability depends on the provider.

## One shop

```sh
npm run eval:directions -- --platform woocommerce --smoke
```

This copies `platforms/woocommerce/fixture` to a fresh directory, starts stock WordPress, WordPress CLI, and MySQL, seeds five products, and checks:

- the documented `docker compose run --rm -T cli wp` command works
- GMP is missing, which is what the directions tell the agent to fix
- OpenReceive is not installed and no wallet code is in the environment

The directory name is the Compose project name, so the stack has its own network, volumes, and published port.

## Several at once

```sh
npm run eval:directions -- --platform woocommerce --smoke --runs 2 --parallel 2
```

`--parallel` is how many smoke runs are in flight. WordPress is heavy, so at most two of those stacks run together even if `--parallel` is higher. A live run refuses `--parallel` above 1. `--keep` leaves the containers up.

## What the agent did

```sh
npm run eval:directions -- --platform woocommerce --runs 1 --parallel 1 \
  --directions-url https://raw.githubusercontent.com/OpenReceive/openreceive/v0.4.16/docs/agents/woocommerce.md
```

That URL is the 0.4.16 directions, which the dry run saw fail. To test this working tree instead, serve its directions. Wired shops besides WooCommerce: Express (`node`), Fastify, Next.js, Vercel (Next.js on Neon), Replit (Express on Postgres), Rails, Django, FastAPI, plain PHP, and Laravel. None of them include OpenReceive.

```sh
npm run eval:directions -- --platform php --smoke
npm run eval:directions -- --platform laravel --smoke
npm run eval:directions -- --platform laravel --serve-directions
```

The default URL is the live `https://openreceive.org/agent-directions/<slug>.md`. The agent is Cursor (`agent status` must show a login). It runs on the host with its workspace set to the shop copy, because the directions tell it to run `docker compose`.

`NWC_URI` and `LSC_URI_PRIMARY` are read from the repo-root `.env` when the eval starts. The merchant pastes each one only after the agent asks for that code. `LSC_URI_BACKUP` is pasted only when the agent asks for a backup and that key is set. The values are not placed in the Cursor process environment. A live run uses one wallet, so `--parallel` must be 1. WooCommerce allows 30 turns: the 0.4.16 run used 20, and a real swap quote needs the extra room.

Exit 0 when every blocker passed, 1 when a directions check failed, 2 when Docker, the Cursor CLI, or a missing code failed.

Reports land in `evals/directions/reports/` and are not committed. `summary.md` lists blockers with the quoted line. `transcript.md` has the codes replaced by `<NWC>` and `<LSC>`.

## Vercel

`--platform vercel` tests what a v0 or Vercel user gets. The shop is a Next.js
store on Postgres, and the opening message is the prompt from
`docs/guides/vercel.md`. The codes are already the project's environment
variables, so the merchant never pastes one: asking for a code, or repeating
one, fails the run. Locally the shop runs behind PgBouncer in transaction mode,
like Neon's pooler.

On a hosting platform the variables come from outside the code, so no file in
the shop names them. The harness writes them, and a Compose override that
loads them, beside the shop directory. Every `docker compose`, the agent's
included, merges that override through `COMPOSE_FILE`.

Agents check that the codes exist in their own ways: listing variable names,
filtering `docker compose config`, testing a file. That is not judged. A run
fails when a code's value reaches the agent: in a command, a command's output,
a message or its reasoning (`secret_not_in_output`), or in a tracked file.

When the agent finishes, the harness deploys the shop to the `openreceive-eval`
project in the OpenReceive Vercel team. It wipes that project's Neon database
first and sets `NWC_URI` and `LSC_URI_PRIMARY` there. Then it checks the live
site:

- the payment route is not on the Edge runtime;
- no cron job or notifications worker was added;
- the deploy built and `/health` answers;
- an order gets a real Lightning invoice;
- a stranger's checkout for that order is refused.

It needs these in the repo-root `.env`, besides the usual codes:

- `VERCEL_TOKEN`, scoped to the team;
- `VERCEL_TEAM_ID`;
- `NWC_URI_VERCEL`, a separate receive-only code. Vercel stores it, so it can be
  revoked without touching `NWC_URI`.

One-time setup: create the `openreceive-eval` project and connect a Neon database
to it. Accepting Neon's Marketplace terms needs a person in the browser.

```sh
npm run eval:directions -- --platform vercel --smoke
npm run eval:directions -- --platform vercel --serve-directions
```

## Replit

`--platform replit` tests what a Replit Agent user gets. The shop is an
Express store on Postgres 16 with a direct connection, as Replit gives an app.
The opening message is the prompt from `docs/guides/replit.md`. The codes are
already the app's Secrets, so, as on Vercel, asking for a code or repeating
one fails the run.

Replit has no deploy API, so the harness plays a publish on this machine
instead. A published Replit app gets its own empty production database, so
the harness creates one, points `DATABASE_URL` at it, rebuilds and restarts
the web service, and checks the shop:

- no notifications worker was added, because Autoscale scales to zero;
- the shop starts on the empty database, which means the integration creates
  its tables at start;
- an order gets a real Lightning invoice;
- a stranger's checkout for that order is refused.

A pass here is not a Tested badge: nothing ran on Replit. The `replit` entry
in `passed.json` comes from a run on Replit itself, with Replit Agent as the
agent:

1. Import this fixture as a ZIP (without the Docker files) into a new Replit
   app, and let Agent get it running.
2. Add `NWC_URI` (from `NWC_URI_REPLIT`) and `LSC_URI_PRIMARY` in the app's
   Secrets, never in the chat.
3. Send Agent the prompt from `docs/guides/replit.md`, verbatim. Accept Power
   mode if Agent asks; nothing else is said to it.
4. Publish on Autoscale, then run the live checks in `harness/live.ts` against
   the `replit.app` address, and read the code Agent wrote: no worker, tables
   created at start, codes read only from `process.env`.

The 2026-10-08 run on 0.4.19 passed: Agent finished in 11 minutes on Power
without asking for or reading a code; the published app answered `/health`,
issued an invoice for the buyer's order (201) and refused a stranger (403).
The guide's screenshots come from that run.

```sh
npm run eval:directions -- --platform replit --smoke
npm run eval:directions -- --platform replit
```

## Passed

A platform counts as passed after one live run exits 0. The reports stay
gitignored. [`passed.json`](passed.json) is the public record: one entry per eval
with the date and release of its latest passing run. openreceive.org shows those
entries as Tested badges. Update the entry after each passing run.
