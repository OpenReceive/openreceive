# Flask quickstart

Flask with Jinja templates. Requires Python ≥ 3.10, Flask ≥ 3 and a
SQLAlchemy 2 `Engine` for OpenReceive's two tables.

OpenReceive ships no `openreceive.flask` package, on purpose. The engine's
HTTP handler is framework-free, and a Flask Blueprint over it is the one file
below, which you copy into your app. It becomes a package
(`openreceive[flask]`) once two things are true: someone outside this
repository has used it, and its code has gone a release without changes. If
you copy it and hit a rough edge, that report is what moves it.

## 1. Install

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

## 2. Create the payment tables

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
→ [openreceive scaffold payments](api-reference.md#openreceive-scaffold-payments-python)

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
machine. Details: [Payment storage](storage.md).

## 3. Add wallet credentials

Put the credentials in the server's environment. That can be a `.env` your
process manager loads, Compose's `env_file`, or your secret store:

<!-- shared:begin credentials -->
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
receive-only code instead ([Security](security.md)).
<!-- shared:end credentials -->

OpenReceive reads `os.environ`, so a `.env` file on disk is not enough on its
own. `flask run` loads `.env` when python-dotenv is installed. Gunicorn does
not: under Docker Compose give the service `env_file: .env`, and elsewhere
let the process manager or secret store inject the values.
[Environment variables](environment-variables.md) lists every variable.

## 4. Wire OpenReceive

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
([Security](security.md)).

Behind a reverse proxy, wrap the app in Werkzeug's `ProxyFix`
(`app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1)`). Otherwise
`request.remote_addr` is the proxy, and `rate_limiting` counts it as the one
payer. → [Rate limiting](rate-limiting.md)

An optional worker, `openreceive notifications --app app:openreceive`,
listens for wallet payment notifications so settlement does not wait for the
next page load. → [openreceive notifications](api-reference.md#openreceive-reconcile--openreceive-notifications)

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

## 5. Render checkout

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
([Checkout UX](checkout-ux.md)).

The order page is the payer's way back: a payer can reload or bookmark it to
return to a pending payment or a swap refund. Set the `theme` attribute
(`dark` or `light`) when the page always uses one theme. The stylesheet is
scoped to the checkout and needs no Tailwind processing; your page's styles
can still override it ([Frontend checkout](frontend-checkout.md)).
Everything the checkout draws ships inside the script, so there is no image to
serve. If your Content-Security-Policy has a strict `img-src`, allow `data:`.
An app with a JavaScript build can use `@openreceive/react`, `/vue`,
`/svelte` or `/angular` from npm instead, with `csrfHeader="X-CSRFToken"`.

That is the whole loop. Your server owns the price and the order. The payer
gets an invoice. `on_paid` runs inside the settlement transaction. If that
transaction rolls back, the callback may run again. For delivery to outside
systems, use an outbox in your app: record the message in the transaction and
send it after commit, or use `after_paid` on the `Host`.

[`examples/flask-starter`](../../examples/flask-starter) is this page as a
one-product shop. It is not a template to copy models from; map its shape
onto the models in THIS app.

## 6. Verify

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
report. → [openreceive doctor](api-reference.md#openreceive-doctor-python)

Then open the checkout in a browser, confirm the payment-method icons and
wallet logos render, and open a wallet's pay tutorial to check its screenshots.
If an image is missing, inspect the console for CSP violations and the Network
panel for failed script loads. Allow `data:` in `img-src`. Do not add image
routes, copy package source images, or use registry `icon_path` / tutorial
`path` keys as browser URLs.

Swap credentials (`LSC_URI_*`) stay server-side too. The provider order id and
token live in the attempt's server-only `swap_data` column. They never reach a
response or a log ([Automated swaps](automated-swaps.md)).

<!-- shared:begin next -->
## Next

- [Authorization](authorization.md) — your policy boundary
- [Payment storage](storage.md) — the table the library owns, and its state machine
- [Frontend Checkout](frontend-checkout.md) — what the browser side is responsible for
- [Automated Swaps](automated-swaps.md) — `swap_data`, and what turning swaps on commits you to
- [Swap refunds](swap-refunds.md) — the refund flow, and the per-order URL a payer needs to come back and claim a refund. Read it before you set `LSC_URI_PRIMARY`
- [Security](security.md) — which secrets must stay on the server

More on wiring, storage, and routes:
[Authorization](authorization.md), [Payment storage](storage.md),
[API reference](api-reference.md).
<!-- shared:end next -->
