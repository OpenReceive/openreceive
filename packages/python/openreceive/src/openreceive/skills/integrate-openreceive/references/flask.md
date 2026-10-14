This is the full file; follow it from Step 0.

# OpenReceive agent directions (Flask)

```sh
# READ THIS FIRST: this file is 44 KB and a summary drops required steps. Download it whole:
curl -fsSL https://openreceive.org/agent-directions/flask/full.md
# Skip the download only if you already have all of it: pasted, read from disk or fetched raw.
```

**Step 0 in brief** (Step 0 below has the details):

- Before installing or editing anything, ask the user for a receive-only NWC code. One question per message.
- Next ask for the LSC code. If the user wants stablecoins, USDT, USDC, ETH, SOL or crypto, do not ask yes/no first.
- The user only pastes codes into this chat. Never ask them to edit .env or run a command to save one.
- Write each code into .env yourself, as Step 0 says. Never echo it or put it in a shell command.
- Do not suggest rotating or revoking a code because it was pasted here.
- Start the quickstart only once the NWC code is saved, and the LSC code is saved or the user said "Bitcoin only".

These directions describe OpenReceive 0.4.26.

Add OpenReceive to a Flask application — the app you are already working in.
You do not need a copy of the OpenReceive source: the engine is on PyPI
(`openreceive[sqlalchemy]`), the checkout's script and stylesheet ship inside
that same package, and the quickstart is appended to this file in full, so you
can do the whole integration without fetching anything. There is no
`openreceive.flask` package: the quickstart's `openreceive_flask.py` is the
Flask integration. Copy it into this app as it is, and do not reimplement
wallet RPC, settlement, pricing or the routes it serves.

Do not clone the OpenReceive repository into this app, and do not copy the
starter's models (`Order`, a session visitor, a one-product catalog) over tables
that already exist. Find this application's order, product, and user models —
whatever they are actually named — and map the three hooks onto those.

Keep this application's templates, authentication and database. Jinja pages
get the `<openreceive-checkout>` element, served from the installed
`openreceive` package as the quickstart shows; only an app that already has a
JavaScript build uses `@openreceive/react`, `/vue`, `/svelte` or `/angular`
instead. Do not add React or npm to a Jinja app. The login this app already
has (Flask-Login's `current_user`, or an id in Flask's `session`) is what
`authorize` checks, and the database OpenReceive gets is a sync SQLAlchemy
`Engine` for the SAME database this app already uses.

## What OpenReceive is

A payment library that runs inside YOUR server. It is a Flask Blueprint
(`openreceive.blueprint()`, registered under `/openreceive`) that serves its
HTTP routes inside the application you are editing, issues Lightning invoices
against a wallet the merchant already controls, and calls back into your code
when one settles. There is no OpenReceive account and no API key, and
OpenReceive never holds the funds — the sats land in the wallet the merchant
connected.

The one required credential is a receive-only NWC code (Nostr Wallet Connect):
a string from the merchant's wallet that can create invoices and read their
status, and cannot spend. A swap provider (an "LSC" code) optionally lets the
payer send USDT, USDC, ETH or SOL instead, converted into that same
Lightning payment. Step 0 collects those credentials from the user; you write three hooks — `authorize`, `amount_for`,
`on_paid`;
OpenReceive supplies invoices, polling, settlement and the checkout UI. It never
owns orders, users, prices, or fulfillment.

## Step 0 — ask for the two codes, one question at a time

Before anything else, check one file: the project's `.env`, if it exists.
`grep -E '^(NWC_URI|LSC_URI_PRIMARY)=.' .env | cut -d= -f1` names the codes
it sets without printing them. Check with that, here and after each write,
not by reading the file, and never print the values. A code that is already
set is not asked for again; if both are set, skip to step 5 (making the
server load the file), then the quickstart.

Otherwise your next action is a question to the user. Do not install packages,
edit the app, write `.env.example`, or search anywhere else before asking
it. Do not read deploy config (compose files, platform secrets), Docker containers, or process environments, and never run
`printenv`. A new shop has neither code yet: hunting for one burns the turn and
can leak other secrets into the transcript.

Two server-only URIs are needed before the quickstart:

- `NWC_URI` — a receive-only Nostr Wallet Connect code,
  `nostr+walletconnect://…`. Required for Bitcoin.
- `LSC_URI_PRIMARY` — a Lightning Swap Connect URI,
  `lightning+swapconnect://…`. Required for USDT, USDC, ETH and SOL. Skip it
  only when the user says they want Bitcoin alone.

The user never edits an environment file. They paste each code into the chat;
you store it. Ask one question per message.

1. **First message — the NWC code, and nothing else.** Ask for it and walk them
   through getting it:

   > To receive payments I need a receive-only wallet code. In Rizful: open
   > the menu, tap NWC, choose Receive-only NWC code, and tap Copy
   > (https://openreceive.org/get_a_nwc_code_to_receive_payments). If you would
   > rather run your own wallet, Alby Hub works too: Connections → Add
   > Connection → Read Only. Paste the code here and I will store it.

   Do not mention `.env`, exports, or "tell me when it's set".
2. **When they paste it.** If it does not start with `nostr+walletconnect://`,
   ask them to copy the receive-only code again. Otherwise write
   `NWC_URI=<paste>` into the project's `.env` with your file-editing tool,
   creating the file if needed. Never write it with a shell command (`echo`,
   `printf`, a heredoc, `python -c`): the command line shows the code. Make
   sure `.gitignore` covers `.env` (and `.dockerignore`, if the app has one).
   Never echo the value, commit it, or put it in client code. Reply only that
   it is saved, then ask the next question.
3. **Second message — swaps.** If the user asked for stablecoins, USDT, USDC,
   ETH, SOL, altcoins or "crypto" (as in "Bitcoin and stablecoin payments"),
   this message IS the walkthrough below: send it as it is, and do not ask yes
   or no first. Otherwise ask whether payers should also be able to pay with
   USDT, USDC, ETH or SOL, then give the walkthrough. The walkthrough:

   > Go to https://lightning-swap.com, sign in for API keys, create a key, and
   > copy the whole URI (https://openreceive.org/set_up_swap_provider). Paste
   > it here and I will store it — or say "Bitcoin only" and I will continue
   > without it.

   Mention FixedFloat only if they already use it.
4. **When they paste it.** If it does not start with
   `lightning+swapconnect://`, ask them to copy it again. Otherwise add
   `LSC_URI_PRIMARY=<paste>` to the same `.env` with the file-editing tool,
   never a shell command. Swaps are now on, so build the refund route back
   (the swap non-negotiable below) as part of this integration. If they chose
   Bitcoin only, leave `LSC_URI_PRIMARY` unset and skip that route.
5. **Make the server load the file — yourself.** OpenReceive reads
   `os.environ`, and a `.env` file on disk is not in it. When the app is
   started with Docker Compose, give the service `env_file: .env`. `flask run`
   loads `.env` when python-dotenv is installed (add `python-dotenv` to the
   requirements). Gunicorn does not: start it as
   `dotenv -f .env run -- gunicorn …` (python-dotenv's CLI,
   `pip install "python-dotenv[cli]"`), in the app's run script or Procfile,
   not just your own command. Restart the server after writing the file.
   Under Compose, recreate the container with `docker compose up -d`:
   `docker compose restart` keeps its old environment.
   Doctor reads `.env` from its working directory by itself. Never `source`,
   `export` or `cat` the file: the codes contain `&`, and the shell prints the
   pieces.

Do not invent placeholder URIs. Start the quickstart only once `NWC_URI` is
saved and `LSC_URI_PRIMARY` is saved or explicitly declined. The first boot
runs the receive-only preflight: if it reports spend methods such as
`pay_invoice`, remove `NWC_URI` from `.env` and ask for a receive-only code
again. Never set the spend-capable override to get past it.

After the Blueprint is registered, run
`openreceive doctor --app <module>:openreceive`, naming the
`OpenReceiveFlask` object (inside the app's container when it runs under
Compose). It reports
`NWC_URI` presence without printing it, probes the wallet, and names
any hook still on a placeholder and whether the migration ran. Exit code 1 is a
finding to fix, not a reason to skip the check.

### Upgrading an existing install

This is not the opening move of a new integration. When OpenReceive is ALREADY
installed here, the doctor above is the first check. Compare the installed
`openreceive` (`pip show openreceive`) against the release named at the top
of this file, and the copied `openreceive_flask.py` against the quickstart's.
Upgrade first.

Only then start the quickstart.

## After the quickstart — hand over, then stop

The quickstart is done when
`openreceive doctor --app <module>:openreceive --url <app url>` is clean and
this app
serves the checkout page for one of its orders. Doctor names any failed check
and exits nonzero; fix it before going on.

Give the user that checkout link. The browser check in the quickstart's step 6
(payment-method icons, wallet logos, a pay tutorial) is theirs: name it in one
line of your closing message, and do not run it yourself.

You cannot pay the invoice: the code is receive-only. Do not pay, settle or
mark an order paid, and do not look for a way to (a wallet control port, a
test endpoint, another wallet). If the user wants a real settlement test, they
pay on that link from their own wallet, and `on_paid` marks the order paid.

Setup ends here. Your last message starts "Setup is finished" and has at most
five short lines (about 80 characters each): the link, the methods it offers,
and one line of what to look at. Send nothing after it. Do not list what
changed, copy out the quickstart's browser checklist, offer more work, or end
the message on a question.

- The link is to a real unpaid order. Keep that order; do not delete it.
- When this app's orders belong to a session or cookie, the user's browser
  cannot open the order you made. Then the link is the shop's own page:
  "Open <shop url> and click Buy: it opens the checkout." Do not explain order
  ownership or mention your test order.
- Name the methods it offers: Bitcoin, plus USDT, USDC, ETH and SOL when
  `LSC_URI_PRIMARY` is saved. Do not mention minimums, and never say a coin
  will not work or will not be offered.

## Non-negotiables

The quickstart below has the code. These are the rules it cannot state for
itself, and they hold for every integration.

- OpenReceive never owns orders, users, prices, or fulfillment. The section
  below is how those tables sit next to the library — not a second order model,
  and not a Prisma/Drizzle relation to `openreceive_payments`.
- Keep `NWC_URI` / `LSC_URI_*` server-only. Never put them in browser code,
  logs, or assets.
- Do not suggest rotating, revoking or replacing a code because it was pasted
  into this chat; that is the supported path.
- Work only in this application. Never read or run anything from another
  project on this machine (its `node_modules`, tools or source), for any
  reason. A browser and Playwright are not part of setup.
- Restart only this app's server, on the port it already uses: stop the
  process you started, or the one listening on that port, by its pid (or
  restart its Compose service). Never `pkill` or `killall` by name: that
  stops other people's servers too. Start it the way this project already
  does (its README, Procfile, compose file or package script), on its own
  port, not a port you pick.
- Run commands where the app runs. When a compose file builds it, run its
  package manager, generators, migrations and doctor inside that service
  (`docker compose exec` or `run`), and rebuild the image after adding a
  package. This machine's language version and database path are not the
  app's.
- To check that the running app sees the codes, run doctor: it reports each
  one as present or missing and never prints a value. Never print the
  environment (`printenv`, `env`, `docker compose config`), even filtered to
  names.
- The host owns the price. `amount_for` reads it from your own data; reject
  payer-supplied amounts.
- `authorize` runs on every request, and the `resource` it receives is a CLAIM
  the payer made, not proof. Read Flask's `session` or Flask-Login's
  `current_user`; never trust a body field.
- `on_paid` must be idempotent. Its database fulfillment commits once per `reference` — your order id, one
  per thing you fulfill, created before checkout, kept across retries, never
  reused. A fresh id per page load lets one order be paid twice.
- Receive-only NWC is required; a spend-capable code fails closed at boot unless
  explicitly overridden.
- There is NO merchant-initiated refund of a settled Lightning payment, because
  the wallet cannot spend. Swap refunds — a payer reclaiming a deposit that
  never converted — are the only refund OpenReceive performs, and only from the
  `refund_required` provider state. Do not build, promise, or imply a Lightning
  refund path.
- IF YOU TURN SWAPS ON, BUILD THE ROUTE BACK. A deposit that arrives short or
  late becomes `refund_required`, and the payer claims it on a SECOND VISIT,
  after leaving your page to fetch an address from another wallet. Three things
  must exist or that money is unreachable through your UI: a per-order URL your
  server serves (`/checkout/:reference` — `syncUrl` on `<Checkout>`, `sync-url`
  or `resumable` on `<openreceive-checkout>`), your own order-summary route to
  restore the order from, and the ATTEMPT.
  `/checkouts/prepare` returns no attempts, so a checkout rebuilt from the
  reference alone opens on the method grid. Re-picking the same coin
  (`POST /swaps`) re-serves the committed attempt — but only while it is live,
  and the shadow invoice behind a swap lasts about half an hour, after which the
  same click mints a NEW deposit address and the refund is off-screen. Keep the
  `payment_hash` and reopen the attempt with `POST /swaps/status`, which has no
  such window. On the drop-ins: `resumePaymentHash`, fed from `onState`, on
  `<Checkout>`; the `resume-payment-hash` attribute, fed from the
  `openreceive-state` event (`event.detail.state.payment_hash`), on
  `<openreceive-checkout>`.
  That visit can come hours later, and `authorize` must still know the payer:
  a session that expired in between answers 403 and strands the deposit. On a
  guest shop, tie the order to a long-lived signed cookie, or put a secret
  per-order token in its URL that your page trades for that cookie.
  https://openreceive.org/guides/swap-refunds.md
- Show the payer WHAT THEY ARE BUYING. Return an optional `description` beside
  the price from `amount_for` and both drop-ins render it above the amount.
  Without it the checkout is a QR and "$1.00" with no sign of what the dollar
  is for.
- Show the payer the transaction record: `createTransactionDetails(...)` rows,
  collapsed behind a caret, on the live checkout AND on the receipt. A payment
  hash and a deposit txid are the only evidence a payer has that they paid you.
  `<Checkout>` / `<openreceive-checkout>` already render this panel and the
  `description` — these two rules cost you code only on a custom UI or your own
  receipt page, never a reason to replace the drop-in. (It returns no rows
  while the rail is `checkout_lock` — before the payer has chosen anything
  there is no transaction — so render the caret only when the rows are
  non-empty.)
- Copy `openreceive_flask.py` from the quickstart unchanged, register
  `openreceive.blueprint()` (it serves `/openreceive`), and call
  `openreceive.start()` where the app boots, so a bad wallet stops the
  deploy. Keep Flask-WTF's `CSRFProtect` on these routes too, never exempt the
  Blueprint: render `<meta name="csrf-token" content="{{ csrf_token() }}">` and
  give the checkout `csrf-header="X-CSRFToken"`. An app without Flask-WTF adds
  no CSRF layer: the engine's `Sec-Fetch-Site: cross-site` refusal is the
  protection. Behind a reverse proxy wrap the app in Werkzeug's `ProxyFix`, or
  `rate_limiting` counts the proxy as the one payer.
- The engine is synchronous, like Flask. Give OpenReceive its own sync
  SQLAlchemy `Engine` on this app's database URL. On SQLite it must not be
  Flask-SQLAlchemy's `db.engine`: the repository reconfigures its Engine for
  one writer at a time.
- HTTP JSON is snake_case, and so is the Python API (`payment_hash`,
  `amount_msats`).
- Money is integers or decimal strings — never binary floats.

## Your tables, not ours

`openreceive scaffold payments --alembic` (Flask-Migrate is Alembic), `--sql`,
or the quickstart's start-up helper creates `openreceive_payments` and
`openreceive_meta` in THIS application's database.
That is the whole persistence OpenReceive needs. It does not replace your
orders, users, or products, and you do not join them.

- **Find this app's models first.** They may be named `Order`, `Invoice`,
  `Booking`, `Product`, `Variant`, `User`, `Account` — anything. Wire the hooks
  to those. Do not generate a parallel `ShopOrder` / `ShopProduct` / `ShopUser`
  stack.
- **The payable row's id is the `reference`.** Create it before checkout, keep
  it across retries, never reuse it. Pass that id to `<Checkout>` /
  `<openreceive-checkout>`. A fresh id per page load lets one order be paid
  twice.
- **Products (or the catalog) are the price authority.** Order creation reads
  live prices into the order (snapshot line items if this app has them).
  `amount_for` reads only that order — never a payer-supplied amount, never a
  live catalog lookup that could re-price a cart already placed. Return
  `{"currency", "value"}` as a decimal STRING, plus a `description` of what
  they are buying.
- **Users own the order; OpenReceive never sees them.** `authorize` uses the
  same ownership check this app already uses on the order show / pay page —
  Flask-Login's `current_user`, an id in `session`, whatever it is. It runs
  inside the request, so both work there. `context.resource["reference"]` is a claim the
  payer sent, not proof.
- **The order is unpaid or paid.** Do not copy `pending` / `expired` / `failed`
  / `attention` onto it. Those are attempt statuses on `openreceive_payments`. An
  expired invoice does not cancel the order; a later checkout may mint another
  attempt. The library refuses a new checkout under a reference that already
  settled (409).
- **A paid order's page says it is paid and shows no checkout.** Nothing is left
  to pay, and a checkout cannot start a new payment for a paid order. Mount the
  checkout only while the order is unpaid. When it settles on the page, update
  the page's status line from the `openreceive-settled` event on
  `<openreceive-checkout>`: `on_paid` has already marked the order paid. Keep
  that checkout mounted, because it is the payer's receipt.
- **Pass a sync SQLAlchemy `Engine` for this app's database.** Do not add an
  ORM relationship from Order to `openreceive_payments`, and do not implement
  `PaymentRepository` unless no SQLAlchemy engine can reach this database.
  `reference` is not unique (many attempts per order). Fulfillment is a
  guarded transition on YOUR order row inside `on_paid` — `UPDATE … WHERE
  state = 'awaiting_payment'` (or this app's equivalent) through
  `settlement.connection`, the settlement transaction's own connection, never
  `db.session`. Database writes only in the hook; emails,
  jobs, and pushes in `after_paid` or after commit.

## If you build your own checkout UI

The drop-ins (`<Checkout>`, `<openreceive-checkout>`) already obey all of this.
This list is the short form of https://openreceive.org/guides/checkout-ux.md, for a
UI built on `@openreceive/browser/headless`. Read that before writing
components.

- Check Bitcoin → Switch payment method → Bitcoin: the grid must hide the
  Lightning invoice, then restore the same bolt11 without another mint.
- `createCheckoutController` is the engine. Do not hand-roll a poll loop.
- `createCheckoutStatusModel` for the status line. Do not draw a
  Cart → Pay → Done stepper. Read the model's `phase`, not the snapshot's.
- `resolveWizardSelection` decides whether to ask "which network?". A
  one-network asset starts the swap from the tile. Key `selectedAssetByGroup`
  by group (`USDT`), valued by `pay_in_asset` (`USDT_TRON`).
- `createMethodGridDisplay` for tiles, including `limitMessage` so an
  unavailable method says the minimum in the payer's currency.
- `createSwapDisplayModel` → `display.copyRows` for deposits: address, memo,
  and the bare amount each get a copy row. Render `swap.networkWarning*` as
  the model gives it.
- `swap.deposit_amount` is the only amount a payer is told to send. Never put
  a fiat valuation of it (`swap.fee.pay_in_fiat`) next to a stablecoin amount:
  "$50.03" under "50.05 USDC" reads as a typo, and the payer asks which one to
  send. The one fiat figure on a USDT/USDC deposit panel is the cart total
  (`payout_fiat`); express "you send" and the fee in the token. Use
  `createSwapFeeBreakdown(fee, swap)` — with the swap, not the fee alone — and
  it applies this for you; SOL and ETH keep a fiat breakdown.
- `createCheckoutSession` owns mint and swap start. To start swaps, pass its
  `swap` option (`selection`, `prefix`, `fetch`) together. Without it
  `startSwap` reports through `onError`.
- `createQrSvg` is async. Use `createQrSvgController` so you do not render
  `[object Promise]`.
- `checkoutLabels` for every payer-facing string. Only write copy it lacks.
- `stageSwapRefund` then `confirmSwapRefund` — only the second submits.
  Validate with `getSwapRefundFormError`. Treat `409` as a normal outcome.
- Pass `{ resumable: true }` to `createSwapDisplayModel` when the payer has
  a URL they can come back to, and render `display.refundReturnLabel`.
  Resume helpers (`createGuestCheckoutResume`, `createGuestOrderFetcher`)
  are on `@openreceive/browser`, not `/headless`.
- A refund replaces the deposit panel. On `refund_required` also drop
  "switch payment method".
- No "Open wallet" button on desktop.
- Wallet suggestions: `getPaymentWizardRoutes()` +
  `createWizardRouteDisplays`. Lightning only. Logos are data URIs; tutorial
  images load from a JavaScript chunk. For a custom headless UI, load it when
  a tutorial opens and look up the returned table by the tutorial's `path`:

  ```js
  import { loadPayTutorialImages } from "@openreceive/browser/headless";

  const images = await loadPayTutorialImages();
  const src = images[tutorial.path]; // data URI for the selected tutorial
  ```

  Render `src` as the image source and update your UI after loading. Existing
  display objects do not update: their `tutorial.image` stays `undefined` if
  created before loading. Alternatively, await the loader, recreate the displays
  with `createWizardRouteDisplays`, and render the new `tutorial.image`.
  Show the caption while loading or if loading fails; never use an empty image
  source. Deploy all JavaScript chunks and allow `data:` in CSP `img-src`.
  For missing images, check CSP errors, failed chunks, and stale displays.
  Registry paths are lookup keys; there is no asset option or image route.

## More documentation

Fetch one when the moment comes. Each is raw markdown, so a plain GET is
enough; drop the `.md` for the same page a person would read.

- https://openreceive.org/guides/authorization.md — before you write `authorize`
- https://openreceive.org/guides/environment-variables.md — every variable, and what is deliberately not one
- https://openreceive.org/guides/storage.md — the payment tables and the attempt state machine
- https://openreceive.org/guides/supabase.md — when the database is Supabase: its pooler, its certificate, and locking the tables away from its Data API
- https://openreceive.org/guides/serverless.md — when the app runs serverless (Netlify, AWS Lambda, Cloud Run, Google AI Studio): pooled database URLs, timeouts, and why it needs no cron or worker
- https://openreceive.org/guides/frontend-checkout.md — the drop-in's props, attributes and slots
- https://openreceive.org/guides/mobile-apps.md — when a mobile app takes the payment: the checkout page it opens, and what the App Store and Google Play allow
- https://openreceive.org/guides/checkout-ux.md — read before building any custom UI
- https://openreceive.org/guides/headless-checkout.md — the controller, the display models, refunds
- https://openreceive.org/guides/provider-registry.md — where the wallet logos and pay
  tutorials come from: inside the JavaScript, nothing to serve. This is the page
  that owns the image rule, not the summary in checkout-ux.md
- https://openreceive.org/guides/automated-swaps.md — only if `LSC_URI_PRIMARY` is set
- https://openreceive.org/guides/swap-refunds.md — the refund flow, and the route back to it. Read it before you turn swaps on
- https://openreceive.org/guides/lightning-swap-connect.md — what an `LSC_URI_*` code actually is
- https://openreceive.org/guides/price-feeds.md — where the fiat→sats rate comes from, and how to replace it
- https://openreceive.org/guides/host-testing.md — testing your three hooks without a live wallet or provider
- https://openreceive.org/guides/rate-limiting.md — before a public shop goes live
- https://openreceive.org/guides/security.md and https://openreceive.org/guides/deploying.md — before this goes anywhere real
- https://openreceive.org/guides/api-reference.md — every route, option and error code
- https://openreceive.org/guides/custom-checkout-route.md — advanced: replacing the shipped adapter's routes with your own
- https://openreceive.org/guides/react-material-ui-recipe.md — a worked custom UI on a component library
- https://openreceive.org/guides.md — the index, if what you need is not above

Questions, or a problem with the library itself:
https://openreceive.org/contact

- https://openreceive.org/guides/payment-safety-upgrade.md — coordinated upgrades and reviewed repair of existing attempts

---

## The quickstart, in full

Inlined verbatim so this file needs no network access — follow it once Step 0
passes. The page it comes from is https://openreceive.org/guides/quickstart-flask.

## Flask quickstart

Flask with Jinja templates. Requires Python ≥ 3.10, Flask ≥ 3 and a
SQLAlchemy 2 `Engine` for OpenReceive's two tables.

OpenReceive ships no `openreceive.flask` package, on purpose. The engine's
HTTP handler is framework-free, and a Flask Blueprint over it is the one file
below, which you copy into your app. It becomes a package
(`openreceive[flask]`) once two things are true: someone outside this
repository has used it, and its code has gone a release without changes. If
you copy it and hit a rough edge, that report is what moves it.

### 1. Install

```sh
pip install "openreceive[sqlalchemy]"
```

OpenReceive is one Python distribution with framework extras.
`openreceive[sqlalchemy]` brings SQLAlchemy 2. The base package includes the
wallet client (websockets, coincurve, cryptography), the HTTP engine, the
`openreceive` CLI and the checkout's script and stylesheet, so a Flask app
with Jinja templates needs no npm. Add your database driver if the app does
not have one yet, such as `psycopg[binary]` for Postgres.

Use `uv` or a virtualenv on Python 3.10 or newer. A system Python 3.9 cannot
install the package.

### 2. Create the payment tables

OpenReceive needs two tables in your database:

- `openreceive_payments`, the payment attempts
- `openreceive_meta`, the reconcile gate

With Flask-Migrate (it is Alembic), write a revision and apply it the way you
apply your own:

```sh
openreceive scaffold payments --alembic --dialect postgres --out-dir migrations/versions   # or sqlite | mysql
```

Set the revision's `down_revision` to your current head (`flask db heads`),
then run `flask db upgrade`. The command never opens a database connection.
→ [openreceive scaffold payments](https://openreceive.org/guides/api-reference.md#openreceive-scaffold-payments-python)

An app that creates its own tables at start with `db.create_all()` creates
these two beside them. Their DDL has no `IF NOT EXISTS`, so the table's
presence is the marker:

```python
from sqlalchemy import inspect, text
from openreceive.storage.sql import payments_ddl_statements


def create_payment_tables(engine):
    if not inspect(engine).has_table("openreceive_payments"):
        with engine.begin() as connection:
            for statement in payments_ddl_statements(engine.dialect.name):
                connection.execute(text(statement))
```

Run it once per start, in one process, as `db.create_all()` runs. Anything
else that runs your migrations can take `openreceive scaffold payments --sql
--dialect postgres`, which prints the same DDL. OpenReceive owns the tables'
logic at runtime: locking, write-once settlement, and the reconciliation state
machine. Details: [Payment storage](https://openreceive.org/guides/storage.md).

### 3. Add wallet credentials

Put the credentials in the server's environment. That can be a `.env` your
process manager loads, Compose's `env_file`, or your secret store:

```dotenv
NWC_URI=
LSC_URI_PRIMARY=
LSC_URI_BACKUP=
```

1. Get a receive-only NWC code from a compatible wallet
   ([get one here](https://openreceive.org/get_a_nwc_code_to_receive_payments)).
   Put it in `NWC_URI`.
2. Optional: set up a [swap provider](https://openreceive.org/set_up_swap_provider).
   Put its connection string in `LSC_URI_PRIMARY`, and a second one in
   `LSC_URI_BACKUP` if you have one.

Never put these values in browser code. Your app refuses to start if the NWC
code also advertises spend methods such as `pay_invoice`. Create a
receive-only code instead ([Security](https://openreceive.org/guides/security.md)).

OpenReceive reads `os.environ`, so a `.env` file on disk is not enough on its
own. `flask run` loads `.env` when python-dotenv is installed. Gunicorn does
not: under Docker Compose give the service `env_file: .env`, and elsewhere
let the process manager or secret store inject the values.
[Environment variables](https://openreceive.org/guides/environment-variables.md) lists every variable.

### 4. Wire OpenReceive

Copy this file into your app as `openreceive_flask.py`. It is the whole
integration: a Blueprint whose one route hands each request to the engine,
and an object that builds the engine once.

```python
# openreceive_flask.py: OpenReceive for Flask. Copy this file into your app.
"""The OpenReceive routes as a Flask Blueprint over the framework-free engine.

`host` and `repository` are what `openreceive doctor --app app:openreceive`
reads, without touching the wallet. `start()` builds the stack once; building
the Service is the receive-only wallet check, so call it where the app boots.
"""

import os
import threading

from flask import Blueprint, Response, request

from openreceive.nwc.receive_client import NwcReceiveClient
from openreceive.server import (
    ConfigurationError,
    HttpRequest,
    HttpResponse,
    OpenReceiveApp,
    Service,
)
from openreceive.server.service import redact_secrets
from openreceive.storage.sql import SqlPaymentRepository

METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]


class OpenReceiveFlask:
    def __init__(self, host, engine, *, rate_limiting=False):
        self.host = host
        # OpenReceive's own repository over your Engine: its two tables,
        # the per-reference lock, write-once settlement and the reconcile gate.
        self.repository = SqlPaymentRepository(engine)
        self.rate_limiting = rate_limiting
        self._app = None
        self._lock = threading.Lock()

    def start(self):
        """Build the stack once. Raises ConfigurationError when NWC_URI is
        missing, unreachable or able to spend."""
        with self._lock:
            if self._app is None:
                nwc = os.environ.get("NWC_URI", "").strip()
                if not nwc:
                    raise ConfigurationError(
                        "NWC_URI is not set. Get a receive-only code: "
                        "https://openreceive.org/get_a_nwc_code_to_receive_payments"
                    )
                self._app = OpenReceiveApp(
                    # Service reads LSC_URI_* for swaps and refuses a code that can spend.
                    service=Service(NwcReceiveClient(nwc)),
                    host=self.host,
                    repository=self.repository,
                    prefix="",
                    rate_limiting=self.rate_limiting,
                )
            return self._app

    @property
    def app(self):
        return self.start()

    def blueprint(self, url_prefix="/openreceive"):
        bp = Blueprint("openreceive", __name__, url_prefix=url_prefix)

        @bp.route("/<path:rest>", methods=METHODS)
        def dispatch(rest):
            try:
                app = self.app
            except ConfigurationError as error:
                response = HttpResponse(
                    503,
                    {
                        "code": "WALLET_UNAVAILABLE",
                        "message": f"OpenReceive is not configured: {redact_secrets(str(error))}",
                        "retryable": True,
                    },
                    {},
                )
            else:
                bodyless = request.method in ("GET", "HEAD", "OPTIONS")
                response = app.handle(
                    HttpRequest(
                        method=request.method,
                        path=f"/{rest}",
                        query_string=request.query_string.decode(),
                        headers=dict(request.headers),
                        # A reader: the engine caps the body before it reads it.
                        body=None if bodyless else request.stream.read,
                        content_length=request.content_length,
                        remote_addr=request.remote_addr,
                        # What `authorize` gets as `context.request`.
                        framework_request=request,
                    )
                )
            return Response(
                response.json(), response.status, response.headers, mimetype="application/json"
            )

        return bp
```

Then wire your three hooks where the app is built. This example uses
Flask-SQLAlchemy, an `Order` model and the buyer's id in Flask's session; map
it onto the models and the login this app already has:

```python
import os
from flask import Flask, session
from sqlalchemy import create_engine, text
from openreceive.server import Host
from openreceive_flask import OpenReceiveFlask
from .models import Order, db  # your existing models


def find_order(reference):
    reference = str(reference or "")
    return db.session.get(Order, int(reference)) if reference.isdigit() else None


host = Host(
    # The price for a reference — here, your order id — from your own data;
    # OpenReceive converts it into the Lightning invoice. Return None when
    # there is nothing to pay for. `value` is a decimal STRING from the order
    # row, never a float and never a request param. `description` is what the
    # payer is buying, in your own words.
    amount_for=lambda reference: (
        {"currency": "USD", "value": str(order.total), "description": order.summary}
        if (order := find_order(reference)) is not None and order.status == "awaiting_payment"
        else None
    ),
    # Your own access check: may this caller pay for this order? It runs inside
    # the request, so `session` and Flask-Login's `current_user` work here.
    # `context.resource["reference"]` is a claim the payer's browser sent, not proof.
    authorize=lambda context: (
        (order := find_order(context.resource.get("reference"))) is not None
        and order.user_id == session.get("user_id")
    ),
    # INSIDE the settlement transaction; runs only for the reference's first
    # settled attempt. Write through `settlement.connection` (that transaction),
    # never db.session. The WHERE clause is the lock.
    on_paid=lambda settlement: settlement.connection.execute(
        text("UPDATE orders SET status = 'paid' WHERE id = :id AND status = 'awaiting_payment'"),
        {"id": int(settlement.reference)},
    ),
)

# OpenReceive's own Engine on the SAME database as your orders. On SQLite it
# must not be Flask-SQLAlchemy's db.engine: the repository sets it up for one
# writer at a time.
payments_engine = create_engine(os.environ["DATABASE_URL"])

# `rate_limiting=True` caps invoice creation at 60 per client IP per hour, for
# public web shops. Leave it off for point-of-sale, where payers share an IP.
openreceive = OpenReceiveFlask(host, payments_engine, rate_limiting=True)
app.register_blueprint(openreceive.blueprint())  # serves /openreceive/...

# The receive-only wallet check, where the app boots: a missing, unreachable
# or spend-capable code stops the server here instead of failing the first payer.
openreceive.start()
```

`openreceive.start()` runs once per process. A command that imports the app
with no wallet access, such as a build step, can skip it: the first payment
request then runs the check, and the routes answer `503 WALLET_UNAVAILABLE`
until it passes. There is no background reconciler, meaning no job that checks
pending payments on a timer. Settlement runs during normal requests instead,
through the durable reconcile gate.

**Flask-WTF's CSRF protection stays on.** `CSRFProtect` checks every POST,
the payment routes included, and the checkout sends the page's token in a
header (step 5). Do not exempt the Blueprint. An app without Flask-WTF needs
nothing extra: every mounted route refuses a request whose `Sec-Fetch-Site`
header says `cross-site`, and `authorize` is the real boundary
([Security](https://openreceive.org/guides/security.md)).

Behind a reverse proxy, wrap the app in Werkzeug's `ProxyFix`
(`app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1)`). Otherwise
`request.remote_addr` is the proxy, and `rate_limiting` counts it as the one
payer. → [Rate limiting](https://openreceive.org/guides/rate-limiting.md)

An optional worker, `openreceive notifications --app app:openreceive`,
listens for wallet payment notifications so settlement does not wait for the
next page load. → [openreceive notifications](https://openreceive.org/guides/api-reference.md#openreceive-reconcile--openreceive-notifications)

Your app also needs an ordinary order-creation route that validates the cart,
prices with exact decimal math, and returns the order id the page will pass as
the `reference`. OpenReceive never prices from payer input.

The `reference` is a string you choose, and it is the fulfillment identity:
your order id. Use one per thing you fulfill, create it before checkout, keep
it across retries, and never reuse it. OpenReceive never looks inside it, but
the reference still matters:

- `on_paid` commits fulfillment once per reference.
- A new checkout under a reference that already settled is refused with 409.
- A fresh id per page load lets one order be paid twice.

The Python API is snake_case (`payment_hash`, `amount_msats`), and so is
everything on the wire.

### 5. Render checkout

The checkout's script and stylesheet ship inside the `openreceive` package.
Serve them from the installed copy, so an upgrade never leaves a stale file:

```python
from importlib.resources import files
from flask import send_from_directory

CHECKOUT_ASSETS = str(files("openreceive") / "django" / "static" / "openreceive")


@app.get("/checkout-assets/<path:name>")
def checkout_assets(name):
    return send_from_directory(CHECKOUT_ASSETS, name)
```

Then render the checkout on the order's own page:

```html
<head>
  <meta name="csrf-token" content="{{ csrf_token() }}">
  <link rel="stylesheet" href="/checkout-assets/openreceive-checkout.css">
  <script type="module" src="/checkout-assets/openreceive-checkout.js"></script>
</head>

<openreceive-checkout reference="{{ order.id }}" prefix="/openreceive"
                      csrf-header="X-CSRFToken"></openreceive-checkout>
```

The checkout renders, polls, and settles itself. `csrf-header` sends the
`<meta name="csrf-token">` value in Flask-WTF's `X-CSRFToken` header on every
request it makes. Without Flask-WTF, drop the meta tag and the attribute. The
checkout already shows the `description` from `amount_for` and the collapsed
transaction-details panel; do not build a custom UI to show them
([Checkout UX](https://openreceive.org/guides/checkout-ux.md)).

The order page is the payer's way back: a payer can reload or bookmark it to
return to a pending payment or a swap refund. Set the `theme` attribute
(`dark` or `light`) when the page always uses one theme. The stylesheet is
scoped to the checkout and needs no Tailwind processing; your page's styles
can still override it ([Frontend checkout](https://openreceive.org/guides/frontend-checkout.md)).
Everything the checkout draws ships inside the script, so there is no image to
serve. If your Content-Security-Policy has a strict `img-src`, allow `data:`.
An app with a JavaScript build can use `@openreceive/react`, `/vue`,
`/svelte` or `/angular` from npm instead, with `csrfHeader="X-CSRFToken"`.

That is the whole loop. Your server owns the price and the order. The payer
gets an invoice. `on_paid` runs inside the settlement transaction. If that
transaction rolls back, the callback may run again. For delivery to outside
systems, use an outbox in your app: record the message in the transaction and
send it after commit, or use `after_paid` on the `Host`.

`examples/flask-starter` is this page as a
one-product shop. It is not a template to copy models from; map its shape
onto the models in THIS app.

### 6. Verify

```sh
openreceive doctor --app app:openreceive --url http://localhost:5000
```

`--app module:attr` names the `OpenReceiveFlask` object. Doctor reads `.env`
in the working directory for variables the environment does not set, and
never prints a value. When the app runs under Docker Compose, run doctor
inside the service (`docker compose exec web openreceive doctor …`), where
`env_file` has set the environment.

`openreceive doctor` checks Python, `NWC_URI`, and swap-provider
configuration. It probes the wallet relay to confirm the code is
receive-only, confirms the migration ran, and names any hook still on a
placeholder. `--url` confirms the routes are mounted. Every failing line
states its own fix, and the command exits with code 1 when anything fails.
`openreceive debug-report` prints the same output as a redacted support
report. → [openreceive doctor](https://openreceive.org/guides/api-reference.md#openreceive-doctor-python)

Then open the checkout in a browser, confirm the payment-method icons and
wallet logos render, and open a wallet's pay tutorial to check its screenshots.
If an image is missing, inspect the console for CSP violations and the Network
panel for failed script loads. Allow `data:` in `img-src`. Do not add image
routes, copy package source images, or use registry `icon_path` / tutorial
`path` keys as browser URLs.

Swap credentials (`LSC_URI_*`) stay server-side too. The provider order id and
token live in the attempt's server-only `swap_data` column. They never reach a
response or a log ([Automated swaps](https://openreceive.org/guides/automated-swaps.md)).
