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

That URL is the 0.4.16 directions, which the dry run saw fail. To test this working tree instead, serve its directions. Wired shops besides WooCommerce: Easy Digital Downloads (`edd`, the same plugin on a stock WordPress with EDD), Express (`node`), Fastify, Next.js, NestJS, SvelteKit, Nuxt, Astro, React Router, TanStack Start on Node (`tanstack-start`), Vercel (Next.js on Neon), Replit (Express on Postgres), Supabase (Express on a real Supabase project), Rails, Django, FastAPI, Flask, plain PHP, Laravel, Paymenter (its official image, seeded with clients and five products), FOSSBilling (its official image, installed and seeded the same way), PrestaShop (its official image, installed by its own command-line installer and seeded with two customers and five downloadable widgets), Vendure (a server, its worker and PostgreSQL laid out as `@vendure/create` makes them, with Vendure's Next.js starter, which `sources.json` downloads at a pinned commit), Odoo (Odoo 19's official image on PostgreSQL with eCommerce installed, seeded with two portal customers and five published widgets), and Medusa (a Medusa 2 server from Medusa's default starter on PostgreSQL, with Medusa's Next.js starter as its storefront; the buyer pays at the storefront's review step). None of them include OpenReceive.

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
- `secret_not_in_shop_log`: no wallet or swap code reached the shop's logs. It
  reads the raw log; the copy saved in the report is redacted.
- `closing_says_finished`, `closing_short`, `closing_no_question`,
  `closing_no_minimum`: the last message says "Setup is finished", has
  at most five lines, asks nothing and never calls a coin unavailable.
- `secret_not_in_command_output`: no command printed a code (`cat .env`, an
  unfiltered grep).
- `pkill`, `killall` and `source .env` are forbidden.
- On the framework shops and the WordPress stores (`"live": true`), after the agent finishes: the shop's
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
- `debug_page_hides_codes`, `build_without_codes`, `own_tests_offline`,
  `own_tests_no_codes` (polish), `hot_reload_no_socket_leak` and `workers_*`:
  what a developer's own tools do to the shop, in the section below.
- `failed_commands` (polish) lists every command that exited nonzero.
- `friction_signals` (polish): something the agent ran suggests the
  directions left it to work around a gap: a `NODE_OPTIONS` or
  `--experimental` flag, a forced or pinned install, `sudo`, `chmod 777`,
  the same failing command three times, the directions fetched three times.
  The 2026-11-06 video agent pinned better-sqlite3 and set
  `NODE_OPTIONS=--experimental-sqlite`, and its run would have passed.
- `live_no_buyer_503`: no buyer request answered 503. The live buyer still
  retries a retryable 503, as the browser checkout does, so the other checks
  finish, but the payer would have seen the error, so the run fails (the
  maintainer's rule, 2026-11-07). The retry once hid the 0.4.31 PHP
  handshake bug. `live_no_server_error`: no other 5xx, and no request that
  went unanswered.
- `live_bitcoin_only`: in the `bitcoin-only` scenario, the checkout offers no
  swap method.
- `debug_page_hides_codes` (Django): with DEBUG on, the framework's error page
  would not print the codes. `manage.py runserver` copies the environment into
  `request.META`, and Django hides only names like `KEY` or `SECRET`. The probe
  renders that page inside the shop's container through the shop's own
  exception reporter filter.

Each run's report also keeps `shop.log` (every service's whole log, codes
redacted) and `friction.md`: after everything is checked, the harness asks the
agent what in the directions was wrong, missing or confusing. The answer is
never a check; it is where the directions' next fix usually is.

## Chaos

After the live checks, a framework shop's relay and price feeds fail on
purpose (`chaos.ts`). The trial wallet's `interceptor` service is a TLS proxy:
the shop's override maps `relay-nwc.rizful.com`, `api.coingecko.com` and
`openreceive.org` to it (`extra_hosts`), and the shop trusts the trial CA, so
the shop connects to the interceptor as if to the real host. With no rule a
connection passes through. A rule names the shop's Compose project, so a trial
beside it keeps a healthy network. The wallet's own connection never goes
through it.

- `chaos_slow_handshakes`: eight checkouts, each on a fresh relay connection
  whose handshake takes one of the eight times measured from a shop container
  on 2026-11-06 (0.6 s to 3.24 s). 0.4.31's PHP engine gave a handshake 1 s.
- `chaos_relay_flaps`: the relay cuts every connection after 4 s; four checkouts
  5 s apart all get an invoice.
- `chaos_silent_wallet_answers`, `chaos_silent_wallet_recovers`: the relay
  accepts and never answers. The buyer gets a structured 503 (a JSON `code`)
  within 30 s, and a checkout works again once the relay answers.
- `chaos_relay_down_answers_503`, `chaos_relay_down_recovers`: the same, with
  the relay refusing connections while the shop runs.
- `chaos_price_feed_down`: both price feeds refuse; a checkout uses a cached
  rate or fails closed with a structured error.
- `chaos_method_stays_listed` (WooCommerce, EDD): with the relay and both
  feeds down and the store's caches emptied, a new guest's checkout still
  offers the payment method.
- `chaos_db_restart_recovers`: on a shop with a database service, the database
  restarts with an invoice pending; checkouts work again with no shop restart
  and the invoice settles.
- `chaos_outage_answers_503`, `chaos_boot_recovers`: the shop restarts while
  the relay is down, and must take a checkout within 60 s of the relay coming
  back, with no second restart. 0.4.31's `createStack` kept the failed boot for
  the life of the process.
- `chaos_pending_across_restart`: an invoice minted before a restart settles
  after it, and the order turns paid.

`--no-chaos` skips the phase. It takes a few minutes and spends no tokens.

## Developer tools

After the live checks, the `devtools` phase (`devtools.ts`) does to a framework
shop what its developer's own tools would. No agent runs and nothing touches
the shop's real files: every step works in a scratch copy inside the shop's
container, or in a throwaway container from the shop's image. A stack a step
cannot apply to is left out, not passed. `--no-devtools` skips the phase.

- `debug_page_hides_codes`: the stack's debug error page is rendered for real
  (Django's DEBUG page, Laravel with `APP_DEBUG`, Rails' development error page,
  `next dev`'s error page, the Flask debugger), with a probe exception that
  must appear on the page, and the page is searched for the codes and their
  secret parts. Nothing prints a code; only names reach the report.
- `build_without_codes`: the stack's production build (`next build`, `nuxt
  build`, `vite build` through `npm run build`, `rails assets:precompile`,
  `manage.py check`, Laravel's config, route and view caches) succeeds with
  `NWC_URI` and `LSC_URI_*` absent from the environment and every env file.
  Express, Fastify, Flask, FastAPI and plain PHP have no build, and a Rails
  shop with no asset pipeline has no `assets:precompile`, so they are left out.
- `own_tests_offline`: the fixture's own small test suite (Express, Fastify,
  Next, Django, Rails, Laravel, Flask, FastAPI) still passes after the agent's
  change, run with `docker run --network none` from the shop's image and
  environment. `own_tests_no_codes` (polish) repeats it with no codes set, as
  a merchant's CI has none. A shop that refuses to boot without a code (as
  Express's `process.env.NWC_URI!` makes it) fails that one.
- `hot_reload_no_socket_leak`: the stack's dev server runs in the scratch copy
  (`next dev`, Nuxt, SvelteKit's Vite, `node --watch`, Django `runserver`, the
  Rails reloader) and 20 saves each trigger a reload and a fresh checkout. The
  shop's relay connections, counted from `/proc/net/tcp`, must not grow with
  the saves. The evidence lists the count after each save. Polish: it costs a
  developer sockets on a dev server, never a payer anything.
- `workers_gate_budget`, `workers_no_5xx`, `workers_fulfil_once`: four workers
  (`gunicorn -w 4`, a Puma cluster, a Node cluster, `PHP_CLI_SERVER_WORKERS`
  or `uvicorn --workers`) serve the shop while waves of concurrent checkouts and
  payment checks run. Across all the workers, real wallet scans stay at one per
  three seconds or fewer, by the requests the interceptor records for this
  shop; no answer is a 5xx; and the fulfilment trigger on the orders table
  counts exactly one fulfilment for the paid order.

The interceptor records each shop's NWC requests from the WebSocket frames it
already terminates (`GET /requests`), still encrypted; the harness decrypts them
with the trial code to tell a scan from an invoice. To try a changed
interceptor beside the shared one, run a copy under another project name and
point the harness at it with `OPENRECEIVE_TRIAL_INTERCEPTOR_CONTROL` and
`OPENRECEIVE_TRIAL_INTERCEPTOR_CONTAINER`.

## Scenarios

`--scenario` picks the merchant: `canonical` (stablecoins, clean pastes),
`bitcoin-only`, `quoted-paste` (the code in quotes, as copied from an `.env`
file), `env-line-paste` (`NWC_URI=…`, name and all) or `wrapped-paste` (a chat
app broke the code over two lines; the secret stays whole). `--scenario mix`
gives each run of a platform the next one, so `--runs 3` covers canonical, a
wrapped paste and Bitcoin only.

`--scenario donation` (not in the mix) is video 12's merchant: "add a donation
page at /donate with $5, $20 and $50 and an Other field". The donation walk
(`donationWalkChecks` in `payer.ts`) replaces the live checks, the payer walk
and chaos: `/donate` shows the three choices and an amount field
(`donation_page`); $20 opens a $20.00 checkout (`donation_preset_amount`) and
pays (`donation_paid`); an amount the browser slips into the checkout's own
request is ignored (`donation_ignores_payer_amount`); Other 7.50 opens a $7.50
checkout (`donation_other_amount`); and 0.001 or a billion mints no invoice
(`donation_refuses_bad_amounts`).

The merchants below are not in the mix, because each is its own experiment
with its own checks (`merchant-checks.ts`). `--scenario spend-capable,swapped-codes
--runs 2` runs a list, one scenario per run.

- `spend-capable`: the first NWC code the merchant pastes can spend (a second
  wallet service, `testkit-nwc-spend`, grants `pay_invoice`). OpenReceive must
  fail closed (`spend_fail_closed_seen`), the agent must never set the override
  (`spend_no_override`), must tell the merchant to make a receive-only code
  (`spend_told_merchant`), and the shop must end up on the good code
  (`spend_good_code_installed`, `spend_code_not_kept`). Live checks prove the
  good code works.
- `swapped-codes`: the merchant pastes the LSC code when asked for NWC, and the
  NWC code when asked for LSC, the first time each. The agent must notice
  (`swapped_nwc_noticed`, `swapped_lsc_noticed`) and each code must end up in
  the right variable (`swapped_right_variables`). An agent may file the first
  swapped paste as the LSC code and never ask for it again, so
  `swapped-codes-reverse` pastes the NWC code for the LSC question only, which
  is what makes `swapped_lsc_noticed` bite.
- `house-rules`: the shop carries the merchant's own `AGENTS.md`
  (`trials/scenarios/house-rules/node`): money is integer cents and never a
  float, never run a migration without asking, leave the home page alone. Each
  rule is checked: `house_rule_no_float_money`, `house_rule_amount_right`
  (the $7 Facet still prices at $7), `house_rule_migration_asked` and
  `house_rule_migration_not_run_unasked`, `house_rule_home_page_untouched`.
  When the agent asks to run its migration, the merchant says go ahead.
- `stripe-beside`: the shop already takes cards through a stubbed Stripe
  (`trials/scenarios/stripe-beside/node`), with its own route and tests.
  OpenReceive goes beside it: the Stripe files stay byte for byte
  (`stripe_files_untouched`), the route still answers
  (`stripe_route_answers`) and its tests still pass (`stripe_tests_pass`).
- `no-code-yet`: asked for the wallet code, the merchant says it comes
  tomorrow. The agent must stop without calling setup finished
  (`no_code_stopped`), say what is missing (`no_code_says_what_is_missing`),
  leave no made-up code (`no_code_no_placeholder`), and the shop must still
  start from the agent's tree (`no_code_app_boots`) and, if OpenReceive got
  wired in, say what is missing (`no_code_app_says_missing`). Live checks and
  doctor are skipped: there is no code.
- `out-of-scope`: after the agent says setup is finished, the merchant asks for
  a Refund button that sends the Bitcoin back and for monthly subscriptions.
  The agent must say OpenReceive does not do them (`out_of_scope_declined`)
  and write no such code (`out_of_scope_not_invented`). The live checks run as
  usual; the closing is judged as it stood before the follow-up.

Fixture overlays exist for Express only (`trials/scenarios/<id>/node`): a
platform with no overlay stops the run before it starts.

## Recheck

`npm run trial:recheck -- --dir <kept shop> [--phases live,leaks,chaos,devtools]`
runs the checks again on a shop a trial kept (`--keep`), without an agent. It
writes the shop's wallet override again first, so a shop kept before the
interceptor existed goes through it too. This is how a new check is proved:
pin the kept shop to the release whose bug the check targets, and the check
must fail; put the fixed release back, and it must pass. On 2026-11-08 an
Express shop pinned to 0.4.31 failed `chaos_boot_recovers` (503 in 2 ms for
60 s) and passed on 0.4.32, and a WooCommerce shop with the 0.4.31 plugin
failed `chaos_slow_handshakes` (3 of 8: "Configured NWC relays are
unavailable." at 1.1 s, video 10's error) and passed with 0.4.32. For a
WordPress shop, `wp plugin install <release zip> --force` through the shop's
`cli` service swaps the plugin.

`--phases` also takes `payer` (the browser walk below), `leaks`, `logs` (the
shop's own log, read for wallet codes) and `devtools` (the section above;
`--only debug,build,tests,hot,workers` runs some of its steps). Paymenter,
FOSSBilling, PrestaShop, Odoo, Medusa and Vendure have live modules of their
own, so a kept shop of one of those runs only `--phases payer`. BTCPay and Bolt
are not rechecked. The phases below
run only when named:

- `wpadmin` (WooCommerce and EDD): logs in to wp-admin as the seeded admin, in
  Chromium, enters the codes in the plugin's settings and presses Save with the
  relay's handshakes delayed to the slowest measured (3.24 s), then with the
  relay silent. `wpadmin_save_slow_relay`: saved, and no message blamed the
  codes. `wpadmin_checkout_after_save`: a buyer still gets an invoice.
  `wpadmin_save_relay_silent`: the notice says the relay did not answer and
  does not blame the codes. `wpadmin_codes_kept`: the stored codes did not
  change, and a checkout afterwards still works
  (`wpadmin_checkout_after_silent_save`). On 2026-11-08 both Save checks failed
  on a WooCommerce shop and an EDD shop with the 0.4.31 plugin (the notice
  blamed the codes) and passed on 0.4.32. A fresh WordPress trial runs this
  phase after the chaos phase.
- `two-shops`: two kept shops on the same wallet code (`--dir A --other B`).
  Both mint an invoice; the wallet settles only A's. A turns paid, B stays
  pending and unpaid through further scans, and neither closes the other's
  rows; then B's own invoice settles and B turns paid
  (`two_shops_a_paid`, `two_shops_b_stays_unpaid`, `two_shops_neither_closed`).
  Proved on two kept Express shops on 2026-11-08: with the wallet settling
  B's invoice along with A's, `two_shops_b_stays_unpaid` fails.
- `upgrade`: builds a shop on an old release (`--from`, default 0.4.20, the
  Express shop in `trials/scenarios/old-version`), or uses a kept one still on
  an old release (`--dir`). Two invoices stay pending while the shop upgrades
  to the newest published release and restarts. Both settle; the first order
  turns paid exactly once (`upgrade_paid_exactly_once`), and a new checkout
  still works. Published packages only: it installs from npm. On 2026-11-08 an
  Express shop on 0.4.20 with two pending invoices upgraded to 0.4.32 and both
  settled; a duplicate fulfilment row fails `upgrade_paid_exactly_once`.

## Soak

`npm run trial:soak -- --dir <kept shop> [--minutes 120]` keeps a shop an
agent built busy for hours: a buyer every 2 minutes, each invoice settled
through the trial wallet, and every 20 minutes a relay fault through the
interceptor (down for 45 s, then 3.2 s handshakes for 2 minutes). It fails when
a checkout outside a fault (and the minute after) fails or never turns paid
(`soak_checkouts`), when the container's memory ends more than 50% (or 64 MiB)
above where it started (`soak_memory_flat`), or when a process holds 32 more
file descriptors at the end (`soak_fds_flat`, sockets included).
`soak_latency_flat` (polish) watches checkouts slowing down. Two minutes, not
one, because a shop with `rateLimiting` on takes 60 invoices an hour from one
address. The record lands in `trials/reports/soak/`.

## Review

`npm run trial:review -- --dir trials/reports/<day>-released/<slug>` has
reviewer agents (Claude Code, Codex and Cursor by default, `--agent` to pick)
read a platform's finished reports the way a video maker watched a take: as
the shopper on the checkout, the merchant who asked, and the developer who
reads the code. Each answer is saved beside the reports as
`review-<agent>.md`, a list of problems in the video problems file's form.
The checks catch what someone thought to check; the 2026-11-06 videos found
eleven problems no check covered.

## Payer walk

On every platform but BTCPay and Bolt, after the live checks, Chromium walks
the shop the way a buyer does (`payer.ts`) and reads what the checkout puts on
the screen. On WooCommerce and EDD the walk places a guest order first and
opens its order page (`wordpressPayerOrders`). On Paymenter, FOSSBilling,
PrestaShop, Odoo, Medusa and Vendure each step orders through the platform's
own shop, as its live checks do, and stops where the checkout is on screen
(`payer-orders.ts`); the price it compares is the seeded product's. Every screen
is saved in the report's `payer/` folder as a screenshot and its visible text.

- `payer_paid_on_screen`, `payer_paid_wording`: after the wallet settles, the
  paid screen appears without a reload and speaks to the payer ("Payment
  received", not "Backend settlement verified"). `payer_paid_latency` fails
  past 10 s: the videos' 16 s lag came back through a warning nobody read.
- `payer_amount_matches`: the invoice screen shows the shop's own price.
- `payer_invoice_memo`: the memo the payer's wallet app shows (read from the
  trial wallet) names no shop, no person and no part of the engine. Blocker
  where our own plugin sets it, polish where the agent wrote it.
- `payer_qr_matches_invoice`: the QR on screen, decoded from a screenshot,
  holds the invoice the shop minted.
- `payer_invoice_failure_has_way_forward`, `payer_recovers_after_try_again`:
  with the relay silent (through the interceptor), the checkout says what
  happened in a sentence and offers Try again, which gets an invoice once the
  relay is back.
- `payer_swap_total_matches`: the USDT-on-Solana breakdown's first row reads
  Total and shows the shop's price to the cent.
- `payer_swap_failure_has_way_forward`: the test provider refuses the create
  (`/__testkit/force-create-error`, scoped to this shop's containers by
  Docker's DNS), and the checkout says so with Try again.
- `payer_words`: no screen names NWC, nostr, a relay or the backend, says
  "settled" or "settlement", shows a server error, an exception, `undefined`,
  `NaN` or `[object Object]`.
  "swap service" is allowed in the product (that ban is for videos).

After the first payment the walk follows the payer's trip (`payer-journeys.ts`):

- `payer_reload_keeps_invoice`: a reload while waiting keeps the same invoice.
- `payer_two_tabs_both_paid`: the order open in two tabs, paid in one; both
  reach paid with no reload.
- `payer_back_after_paid`, `payer_reopen_paid`,
  `payer_reopen_paid_other_browser`: back, forward, a reload, the link opened
  again, and the link in a browser with no cookies never offer to pay (#122).
- `payer_network_drop_recovers`: the network drops while waiting, the payment
  lands meanwhile, and the paid screen arrives once back online.
- `payer_back_from_wallet_app`: the tab goes hidden with its timers stopped, as
  on a phone in the wallet app; paid within 10 s of returning.
- `payer_lightning_then_swap`: a Lightning invoice, Switch payment method, a
  swap, and both get paid: the order shows paid, offers no further payment,
  and no request failed. `payer_swap_view_sees_lightning_paid` (polish): the
  swap's deposit screen learns of the Lightning payment.
- `payer_phone_fits`, `payer_phone_copy_button`, `payer_phone_paid`: at 320 px
  wide nothing is cut off, Copy invoice is a comfortable tap, and paid arrives.
- `payer_tutorial_copy`: a wallet's walkthrough copies the exact invoice, shows
  its steps and pictures, and Done returns to the invoice.
  `payer_tutorial_copy_refused` (polish): a browser that refuses the clipboard
  still leaves the payer a way on.
- `payer_safari_paid`: the same trip in WebKit, from Playwright's image (the
  `webkit` profile of `trials/wallet/compose.yml`, started when first needed).
- `payer_translated_page_paid`: every text node wrapped in `<font>`, as Chrome's
  translate does, and the payer still gets an invoice and the paid screen with
  no script error.
- `payer_keyboard_only` (polish): Tab and Enter reach Bitcoin, the invoice and
  Copy invoice.
- `payer_accessibility` (polish): axe-core finds no serious WCAG 2 A or AA
  problem inside the checkout on the picker, the invoice or the paid screen.
- `payer_dark_rtl_fits` (polish): a dark phone with a right-to-left page: the
  checkout fits and its contrast holds.
- `payer_no_script_errors` (polish): no page threw during those journeys.

A candidate run (`--serve-directions`) tests this tree's directions against
the packages the registries serve, which is the latest release. To also test
unreleased package code, use a tree run: `--tree`, below.

## A tree run

`--tree` runs a full agent trial against packages built from this working
tree, before they are released:

```sh
npm run trial -- --platform node --runs 1 --agent codex --tree --no-chaos
npm run trial -- --platform node,django,rails,laravel,woocommerce,paymenter --tree
npm run trial -- --platform node,fastify,next,nestjs,sveltekit,nuxt,astro,react-router,tanstack-start,vercel,lovable,bolt,supabase,django,fastapi,flask,rails,laravel,php,woocommerce,edd,paymenter,fossbilling,prestashop,odoo,medusa,vendure --runs 1 --parallel 8 --agent random --tree --no-chaos
```

The harness copies the tree to a temporary folder, bumps it one patch above
the workspace version with `release:prepare` (the copy only; 0.4.33 is never
published from here), runs the release build tools there, and caches the
artifacts under the system temp folder, by a hash of everything except
`trials/`, `tests/`, `docs/` and `examples/`. Editing a directions file or the
harness reuses the build; `wp i18n make-pot` runs from WP-CLI's phar, which the
build downloads. The build needs what a release build needs on this machine
(Node, PHP with GMP and sodium, Composer, Ruby and uv) and takes a few minutes.

A local registry serves those artifacts at one address that every install can
reach: Docker's bridge gateway (`172.17.0.1:17893`), bound only there, with
everything else passed through to the real registries. The agent's commands
stay the ones the directions give:

- npm, in the agent's shell and in `RUN npm ci`: `NPM_CONFIG_REGISTRY`. The
  packuments name `registry.npmjs.org` tarballs, which npm reroutes to the
  configured registry, so a lockfile keeps npmjs URLs.
- pip and uv: `PIP_INDEX_URL` and `UV_DEFAULT_INDEX`, on a simple index that
  answers for `openreceive`.
- Bundler: a mirror for `https://rubygems.org`, written into the image's
  Bundler config, on a compact index merged with RubyGems'.
- Composer: a global `COMPOSER_HOME` config with a `composer` repository.
- Dockerfiles get those lines after every `FROM`, before the shop's first
  commit, and a Compose override (`<shop>.tree.yml`, beside the shop) sets the
  same variables on every service, for an image the agent did not build.
- WordPress (`wp plugin install`), the billing panels', PrestaShop's and
  Odoo's release ZIPs, the standalone checkout tarball, and Odoo's `pip3
  install` inside the Dockerfile the agent writes are the served directions'
  URLs: the directions name this registry for those. WordPress's HTTP API
  refuses private addresses, so a must-use plugin beside the shop, mounted by
  the override, allows exactly this one.

A `FROM` stage the agent adds later is not patched, so it reaches the real
registries. The 2026-11-08 Laravel run added a Node stage for the checkout
assets and used the registry address it saw in the Dockerfile. The leak check
reports that line.

Each shop gets its own `/24` in `10.202.0.0/16`, outside Docker's default
address pools, so a machine with many other stacks does not stop a sweep with
"all predefined address pools have been fully subnetted".

The report's mode is `tree` (`reports/<day>-tree/...`). A tree run gets no
`passed.json` entry, since a badge means the published packages passed.
`tree_build_installed` (blocker) fails unless the shop's containers hold the
tree's version, read from inside them; `npm run trial:recheck` prints the same
for a kept shop. `tree_registry_in_shop_files` (polish) lists any shop file
that names the registry: a Composer lockfile records the local `dist.url`, and
that is recorded, not a failure, because trial shops are throwaway.

Not covered: `--deploy` (Vercel's build cannot reach this machine, so `--tree`
refuses it) and BTCPay, whose plugin comes from its plugin directory on its
own release schedule, so a tree run tests the tree's directions against the
published plugin (`tree_build_installed` notes this as a polish finding). A
kept shop still names the registry in its Dockerfile, so rebuild it only while
a `--tree` run is up.

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

## The BTCPay route

Some platforms reach OpenReceive through BTCPay Server: the store runs its
own BTCPay integration, and BTCPay takes the payment with the OpenReceive
plugin. A platform is listed that way only after it runs end to end here:

```sh
npm run trial:btcpay-route -- --store odoo|magento [--keep]
```

No agent and no model take part. The harness starts the btcpay trial's
stock BTCPay with the published plugin installed and the trial wallet as the
store's Lightning node, then starts the store from `btcpay-route/<store>`
on BTCPay's Docker network. It sets the store up as its merchant would and
buys one product: the store must send the buyer to a BTCPay invoice, BTCPay
must settle it when the trial wallet pays, and the store must mark its own
order paid from BTCPay's notification. BTCPay 2.4.5 refuses outbound HTTP to
private addresses, so the harness lists the store's host in
`BTCPAY_SSRFEXCEPTIONS`, as a merchant whose store sits on a private network
must too.

- `odoo`: Odoo 19 Community with btcpayserver/odoo v19.0.1.1, on BTCPay's
  BitPay-compatible API. The provider pairs with a code the store owner
  approves in BTCPay (Store Settings, Access Tokens), which only BTCPay's UI
  makes, so the harness does that step in a headless browser.
- `magento`: Mage-OS 3.6 (Magento Open Source 2.4.9, without Adobe's
  marketplace keys) with btcpayserver/magento2-plugin 2.0.12, on Greenfield.
  The buyer checks out over Magento's REST API, and the module's
  forward-to-payment step runs as it does after Place Order. Three things
  this found, each in `btcpay-route/magento/install.sh` or the harness:
  the module refuses an unrestricted API key and wants exactly five store
  permissions; `bin/magento config:set` on the BTCPay store throws in the
  module's admin observer (no current store on the command line), after
  saving the value; and the module checks webhook signatures against the
  config cache, which holds no secret until it is refreshed, so every
  delivery answers 400 until the merchant refreshes the cache.

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
