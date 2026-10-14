# Agent trials

An agent trial is one coding agent adding OpenReceive to a plain shop from our published directions, the way a merchant's agent would. It is not part of CI. The agent follows the directions in a disposable copy of the shop, and the harness answers as the merchant, pasting a test wallet's codes when asked. A trial spends model tokens and takes several minutes.

- **Agent trial**: one run of this harness on one shop, by one coding agent and model. A platform passes after three trials in a row (`--runs 3`).
- **Filmed trial**: the same job on camera, by a separate agent, for a video.
- **Builder trial**: one run on a hosting platform itself, by that platform's own agent (Replit below). Bitcoin is the required payment; a configured swap provider can also convert USDT, USDC, SOL, and ETH into BTC over Lightning in the merchant's wallet. Asset and network availability depends on the provider.

## By hand, with any agent

[`by-hand.md`](by-hand.md) is a prompt for a coding agent the harness cannot
drive (any model, in any tool). The agent integrates each Docker-only shop
itself, playing the merchant from a fixed script, and writes its findings to
`zz-agent-tests-results-<name>.txt` at the repo root. `npm run trial:by-hand`
does the harness's part around it: `prepare` starts a plain shop wired to the
trial wallet and writes the codes to files, `check` runs the live checks
below plus a swap-methods check, and `stop` removes the shop.

## One shop

```sh
npm run trial -- --platform woocommerce --smoke
```

This copies `platforms/woocommerce/fixture` to a fresh directory, starts stock WordPress, WordPress CLI, and MySQL, seeds five products, and checks:

- the documented `docker compose run --rm -T cli wp` command works
- GMP is missing, which is what the directions tell the agent to fix
- OpenReceive is not installed and no wallet code is in the environment

The directory name is the Compose project name, so the stack has its own network, volumes, and published port.

## Several at once

```sh
npm run trial -- --platform woocommerce --smoke --runs 2 --parallel 2
```

`--parallel` is how many runs are in flight, smoke or live. WordPress is heavy, so at most two of those stacks run together even if `--parallel` is higher. `--keep` leaves the containers up.

## What the agent did

```sh
npm run trial -- --platform woocommerce --runs 1 --parallel 1 \
  --directions-url https://raw.githubusercontent.com/OpenReceive/openreceive/v0.4.16/docs/agents/woocommerce.md
```

That URL is the 0.4.16 directions, which the dry run saw fail. To test this working tree instead, serve its directions. Wired shops besides WooCommerce: Express (`node`), Fastify, Next.js, NestJS, SvelteKit, Nuxt, Astro, React Router, TanStack Start on Node (`tanstack-start`), Vercel (Next.js on Neon), Replit (Express on Postgres), Supabase (Express on a real Supabase project), Rails, Django, FastAPI, Flask, plain PHP, and Laravel. None of them include OpenReceive.

```sh
npm run trial -- --platform php --smoke
npm run trial -- --platform laravel --smoke
npm run trial -- --platform laravel --serve-directions
```

The default URL is the live `https://openreceive.org/agent-directions/<slug>.md`. Each trial picks its coding agent at random from `--agent` (default `random`: Cursor with `grok-4.7-medium-fast`, or Codex with its default model), so a sweep spreads across agents. `--agent cursor`, `codex` or `claude` runs every trial with one agent; `--model` sets its model (`agent --list-models` lists Cursor's). Cursor needs `agent status` to show a login, Codex `codex login status`, Claude Code a login. Codex and Claude Code run with no MCP servers and no user-level config, and the harness deletes their saved sessions for the shop after each trial. Each `passed.json` entry lists the agents and models that ran its trials (`agent/model`). It runs on the host with its workspace set to the shop copy, because the directions tell it to run `docker compose`.

## The test wallet

A trial never uses the merchant's wallet. `trials/wallet/compose.yml` runs a
testkit NWC wallet service (in memory, receive-only) connected to a real
public relay, `wss://relay-nwc.rizful.com/v1`, and a test swap provider that
speaks the FixedFloat protocol over TLS with a private CA. The harness starts
the stack once (`startTrialWallet`), and each shop's code reaches it the way a
merchant's would: the NWC URI and the `lightning+swapconnect://` URI are what
the merchant pastes, one at a time, only when the agent asks. Every trial gets
the same throwaway codes; a backup swap code is answered with "I don't have a
backup code". The shop's services that run OpenReceive join the
`openreceive-trial` network and trust the private CA through a Compose
override beside the shop (`<shop>.wallet.yml`, merged through `COMPOSE_FILE`).

The wallet can also pay: after the buyer's invoice, the harness marks it paid
(`settle`), waits for the shop's checkout to report it settled, then reads the
shop's own order row with the fixture's `bin/order-status` probe. A shop whose
`onPaid` is still the logging-only placeholder settles but never marks the
order paid, and `live_order_paid` fails.

A swap pays a second order the same way. The buyer orders the $12 product
(the test provider prices BTC at a fixed $100,000 and takes at least 10
USDT), and the checkout must offer the provider's pay-in methods
(`live_swap_methods`). The buyer starts a USDT-on-Solana swap through the
shop's own `/openreceive/swaps`. The harness scripts that order to `completed`
on the test provider (`POST /__testkit/script`, by order id, so other
trials' orders stay put), settles the swap's invoice on the wallet, polls as
the swap view does, and reads the order (`live_swap_paid`). It runs when the
merchant gave the test provider's code, and never on a platform whose
`swap_provider` is `"live"`.

WordPress's HTTP API trusts only the CA bundle WordPress ships, not the
system store. The WooCommerce fixture mounts a must-use plugin,
`trust-system-cas.php`, into both its `wordpress` and `cli` services, and it
points WordPress at the system store, which the override extends with the
private CA. Both services join the trial network (`wallet_services`), so
WooCommerce gets the test swap provider like every other shop. A trial does
not create swaps.

Stop the stack with `docker compose -f trials/wallet/compose.yml down -v`. A
restart makes a new wallet key, so the codes change.

Trials run together with `--parallel` (`--platform fastify,next,php --runs 3
--parallel 8`). Only one trial process runs at a time. WooCommerce allows 30
turns: the 0.4.16 run used 20, and a swap quote needs the extra room.

Exit 0 when every blocker passed, 1 when a directions check failed, 2 when Docker, the agent's CLI, or a missing code failed.

Reports land in `trials/reports/` and are not committed. `<slug>/summary.md` lists each run's blockers with the quoted line, its polish findings and its minutes, and, when every run passed, the `passed.json` entry. `commands.txt` prefixes each command with its exit code. `transcript.md` has the codes replaced by `<NWC>` and `<LSC>`.

## What a run checks

Besides the code questions and the secret rules, every run checks what the
video takes kept finding after a pass:

- `openreceive_command_clean`: no OpenReceive command (install, scaffold,
  configure, doctor) failed inside OpenReceive's own code: a traceback
  through the installed package, or an `openreceive.E…` system check. A
  chain that failed elsewhere (a missing venv, the framework's own migrate)
  is only polish. Cursor files a failed command under `failure`; the
  harness read only `success` until 2026-10-09, so it never saw one.
- `no_workaround_flag`: nothing forced its way past a failure
  (`--skip-checks`, `--legacy-peer-deps`, `--ignore-platform-reqs`…). Every
  0.4.21 Django agent retried `openreceive_install` with `--skip-checks`.
- `no_package_patch`: nothing rewrote OpenReceive's installed files or
  patched a class so the package would import. Two 0.4.21 Django agents got
  past the admin `TypeError` that way, one by rewriting `admin.py` from the
  shop's Dockerfile, one by setting `ModelAdmin.__class_getitem__` in
  settings.py, and each then passed every other check.
- `openreceive_raised` (polish): a command's output showed a stack frame
  inside OpenReceive's own code, for example a crash in `docker compose logs`.
- `doctor_clean`: doctor ran, and its last run exited 0.
- `closing_says_finished`, `closing_short`, `closing_no_question`,
  `closing_no_minimum`: the last message says "Setup is finished", has
  at most five lines, asks nothing and never calls a coin unavailable.
- `secret_not_in_command_output`: no command printed a code (`cat .env`, an
  unfiltered grep).
- `pkill`, `killall` and `source .env` are forbidden.
- On the framework shops (`"live": true`), after the agent finishes: the shop's
  own order form makes an order, its buyer gets a real Lightning invoice, and a
  second visitor with a session and CSRF token of their own is refused. So
  the check fails when the allow-all `authorize` placeholder is left in place.
  A failed live check carries the shop's log (`logs` in `platform.json`).
- `live_reload`: the buyer loads the order page twice and asks for its
  checkout again, and gets the same invoice. Where the page names its
  checkout's `reference` (the element's attribute, or a React prop in the
  page's payload), both loads name the same one, so a page that makes a new
  order on every load fails.
- `live_swap_methods`, `live_swap_paid`: the swap above.
- `live_one_scan_back_to_back`: on a live shop, four `payments/check` calls
  in a row, as a checkout makes them, run at most one wallet scan between
  them. A check that ran the scan answers with the wallet's `details`. When a
  scan outlasted the reconcile gate's interval, the 0.4.24 PHP checkout
  scanned on every request: 3 s a click, 15 s a reload. The evidence lists
  each call's time, so a slow shop shows up even when the check passes.
- `failed_commands` (polish) lists every command that exited nonzero.

A candidate run (`--serve-directions`) tests this tree's directions against
the packages the registries serve, which is the latest release. A fix in a
package needs its unit tests now and a released run after it ships.

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

By default the Vercel trial checks the shop where it already runs, here: the
source checks below, then the same live checks as the framework shops, paid
path included. With `--deploy`, the harness instead deploys the shop to the
`openreceive-eval` project in the OpenReceive Vercel team. It wipes that
project's Neon database first and sets `NWC_URI` (the test wallet's, which a
deployed app reaches over the public relay) and `LSC_URI_PRIMARY` (the
repo-root `.env`'s, since the test swap provider is local) there. Then it
checks the live site:

- the payment route is not on the Edge runtime;
- no cron job or notifications worker was added;
- the deploy built and `/health` answers;
- an order gets a Lightning invoice;
- a stranger's checkout for that order is refused.

`--deploy` needs these in the repo-root `.env`:

- `VERCEL_TOKEN`, scoped to the team;
- `VERCEL_TEAM_ID`;
- `LSC_URI_PRIMARY`.

One-time setup: create the `openreceive-eval` project and connect a Neon database
to it. Accepting Neon's Marketplace terms needs a person in the browser.

```sh
npm run trial -- --platform vercel --smoke
npm run trial -- --platform vercel --serve-directions
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
npm run trial -- --platform replit --smoke
npm run trial -- --platform replit
```

## Lovable

`--platform lovable` tests what a Lovable user gets. The shop is a TanStack
Start app on Lovable's own build setup (`@lovable.dev/vite-tanstack-config`),
with its products and orders in Supabase, reached over Supabase's HTTPS API
the way Lovable's generated `supabaseAdmin` client reaches it. Supabase here is
its own Postgres image, PostgREST and a stand-in for its API gateway, and the
shop runs under the Vite dev server. The opening message is the prompt from
`docs/guides/lovable.md`. The codes are already the project's secrets, so, as
on Vercel, asking for a code or repeating one fails the run.

Lovable applies a migration the agent writes only when the owner approves it,
and its agent cannot run SQL. So `psql` is forbidden, the shop's README names
`docker compose run --rm migrate` as the approval, and after the agent
finishes the harness runs the platform's `before_live` steps: apply every
pending migration, then rebuild and restart the web service. Lovable's agent
has no terminal at all, and a trial's agent does, so the opening message
says what Lovable allows: edit files and add npm packages, but no SQL and no
container management. The first 0.4.23 run without that line had two Cursor
agents query the database with `psql` to check their work, and one rebuilt
the web container by hand with `docker run`. Then come the
live checks, paid path included: `openreceive_on_paid` must mark the shop's own
order paid. Lovable's directions have no doctor, so `doctor_clean` is not
checked here.

A pass here is not a run on Lovable: its agent, its migration approval and
Cloudflare Workers are not part of it. The Supabase route's Workers run is in
CI (`tests/supabase/lovable.test.mjs`). Trials install the published packages,
so this one can pass from the release that ships Supabase storage, 0.4.23.

```sh
npm run trial -- --platform lovable --smoke
npm run trial -- --platform lovable --serve-directions
```

## Supabase

`--platform supabase` tests what a developer gets whose app already keeps its
data in Supabase. The shop is the Express store, with its products, users and
orders in a real Supabase project, reached through Supabase's transaction
pooler (Supavisor, port 6543) with Supabase's own certificate authority, as
`docs/guides/supabase.md` connects it. The agent follows the Express
directions; the codes are pasted as on any library shop.

The project is the maintainer's, so the harness treats it differently from
the throwaway test wallet:

- The pooler URL comes from the repo-root `.env` (`SUPABASE_TRIAL_POOLER_URL`,
  which `supabase_project` names) and reaches the shop's server as
  `DATABASE_URL`, with `tests/supabase/prod-ca-2021.crt` as `SUPABASE_CA_CERT`,
  through a Compose override beside the shop, as a host would set them.
- Reports print the password as `<SECRET>`, and a run fails when it reaches
  the agent at all (`database_password_not_in_output`).
- Before each run the harness empties the project's `public` schema, so runs
  go one at a time, and the plain shop creates its own tables at start. The
  schema itself stays, with Supabase's default grants to `anon` and
  `authenticated`, as on a new project. Use a project that holds nothing else,
  and never run `npm run test:live:supabase` at the same time.

After the live checks, `supabase_tables_private` reads the catalog: every
`openreceive_` table must have row level security on, and neither `anon` nor
`authenticated` may hold a privilege on it. That is step 3 of the Supabase
guide. Without it, anyone with the project's anon key, which every visitor's
browser has, could read `swap_data` through Supabase's Data API.

```sh
npm run trial -- --platform supabase --smoke
npm run trial -- --platform supabase --runs 3
```

## BTCPay Server

`--platform btcpay` tests the BTCPay plugin the way a merchant installs it.
The shop is a stock BTCPay Server 2.4.5 on mainnet with its own Postgres. The
harness plays the merchant who set it up: an admin, the Widget Shop store, a
Point of Sale app with five products, and an admin's Greenfield key in the
deployment's `.env`. There is no app code, so the agent configures the store
through Greenfield and installs nothing itself. BTCPay installs plugins only
from its UI. When the agent asks, the merchant installs OpenReceive from the
Plugin Directory: the harness stages the published package the way BTCPay's
Install button does (`tools/dotnet/published-plugin.mjs`) and restarts BTCPay.
Copying a plugin in or downloading it from the plugin builder is forbidden.

BTCPay's health check is a page in its UI, so `doctor_clean` is not checked.
The harness reads the store with its own key instead: the wallet must be the
store's Lightning node without the spend override, and swaps must be on. The
live checks buy a product through the Point of Sale. The invoice's `BTC-LN`
method must be the trial wallet's BOLT11. After the wallet settles it, BTCPay's
checkout and its invoice must both say Settled.

BTCPay expects an NBXplorer, and `GET /api/v1/server/info` fails with a 500
without one. Every BTCPay trial shares the trial chain (`trials/chain/compose.yml`):
a pruned mainnet bitcoind and NBXplorer, reached on the trial wallet's network
as `trial-nbxplorer`. The harness starts it after the wallet. Its first sync
takes hours, and trials need not wait: a store that takes Lightning from a
remote wallet mints invoices while the node syncs. Its network keeps an MTU
of 1380, which lets large downloads through on this machine's network path.
Stop it with `docker compose -f trials/chain/compose.yml down`. Leave off `-v`
to keep the synced chain.

```sh
npm run trial -- --platform btcpay --smoke
npm run trial -- --platform btcpay --serve-directions
```

## Passed

A platform counts as passed after three live runs in a row exit 0
(`--runs 3`). The video takes run three agents per platform, and one failure in
three is common: one pass proves little. The reports stay gitignored.
[`passed.json`](passed.json) is the public record: one entry per platform with the
date and release of its latest passing runs, how many runs passed, the mode,
and the hash of the directions file they followed. Copy the entry from that
platform's `summary.md`. openreceive.org shows the entries as Tested badges.
The site-contract generator refuses an entry with fewer than three runs or
no directions hash, except a `builder` entry: one run on the platform itself,
by its own agent (Replit, above).

The fixtures are the apps people build today: Django 6.1 with the admin
`startproject` installs, Next.js 16, Express 5, Rails 8.1, Laravel 13. Move a
fixture to a new framework major when it ships: the Next 16 break and the
Django admin crash both passed on older or trimmed fixtures.
