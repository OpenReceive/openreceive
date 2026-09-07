# Flask recipe

OpenReceive ships no `openreceive.flask` package — on purpose. The engine's
HTTP handler is framework-free, and a Flask `Blueprint` over it is about forty
lines, all of them below. This recipe is the supported Flask integration; it
becomes a package (`openreceive[flask]`) once two things are true: it has been
used by someone outside this repository, and its code has not changed for a
release. Not before. If you copy it and hit a rough edge, that is exactly the
report that moves it.

Install the engine with the SQLAlchemy extra (Flask ≥ 3, Python ≥ 3.10):

```sh
pip install "openreceive[sqlalchemy]" flask flask-login flask-wtf
```

## The blueprint

`OpenReceiveApp` is the storage-aware engine: your `Host`, OpenReceive's own
SQLAlchemy repository over your `Engine`, and the durably gated opportunistic
reconcile. Flask's job is one translation each way — `flask.request` into the
engine's `HttpRequest`, the engine's `(status, body, headers)` into a
`Response`. The engine's cross-site refusal, JSON gate, declared-fields check
and 64 KB body cap all run unchanged.

```python
# openreceive_blueprint.py
import os
from flask import Blueprint, Response, request
from flask_login import current_user
from sqlalchemy import create_engine
from openreceive.nwc.receive_client import NwcReceiveClient
from openreceive.server import Host, HttpRequest, OpenReceiveApp, Service
from openreceive.storage.sql import SqlPaymentRepository
from .models import orders  # your order model


def openreceive_blueprint(engine, *, prefix="/openreceive", rate_limiting=False):
    host = Host(
        amount_for=lambda reference: (
            {"currency": "USD", "value": str(o.total), "description": o.summary}
            if (o := orders.find(reference)) else None
        ),
        # `context.request` is the Flask request; Flask-Login's proxy is
        # request-bound, so the same check your order page makes works here.
        authorize=lambda context: current_user.is_authenticated
        and orders.owned_by(context.resource["reference"], current_user.id),
        # Inside the settlement transaction: write through settlement.connection.
        on_paid=lambda s: s.connection.execute(orders.claim_paid(s.reference, s.paid_at)),
    )
    state = {}

    def app():  # the wallet preflight runs on first use, never at import
        if "app" not in state:
            service = Service(NwcReceiveClient(os.environ["NWC_URI"].strip()))
            state["app"] = OpenReceiveApp(
                service=service, host=host, repository=SqlPaymentRepository(engine),
                prefix="", rate_limiting=rate_limiting,
                client_ip=lambda req: req.remote_addr,
            )
        return state["app"]

    bp = Blueprint("openreceive", __name__, url_prefix=prefix)

    @bp.route("/<path:rest>", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    def dispatch(rest):
        wire = HttpRequest(
            method=request.method, path=f"/{rest}", query_string=request.query_string.decode(),
            headers=dict(request.headers), remote_addr=request.remote_addr,
            content_length=request.content_length,
            # A reader, so the engine caps the body BEFORE reading it.
            body=lambda max_bytes: request.stream.read(max_bytes),
            framework_request=request,
        )
        status, body, headers = app().handle(wire)
        return Response(app().handler.error_response and __import__("json").dumps(body), status, headers, mimetype="application/json")

    bp.preflight = app  # call once at boot to fail closed (below)
    return bp
```

The last line of `dispatch` is shorter in practice — `HttpResponse.json()` is
the compact serializer: `response = app().handle(wire)` then
`Response(response.json(), response.status, response.headers,
mimetype="application/json")`.

## Wiring it

```python
# app.py
from flask import Flask
from flask_wtf.csrf import CSRFProtect
from sqlalchemy import create_engine
from .openreceive_blueprint import openreceive_blueprint

app = Flask(__name__)
csrf = CSRFProtect(app)
engine = create_engine(os.environ["DATABASE_URL"])   # OpenReceive's own Engine, same database

bp = openreceive_blueprint(engine, rate_limiting=True)
app.register_blueprint(bp)
# Flask-WTF checks a token on every POST; the checkout sends it as a header
# (below), so the blueprint keeps CSRF protection rather than exempting it.

# Fail closed at boot, the way the FastAPI lifespan and the Rails engine do:
# a dead relay or a spend-capable code stops the deploy, not the first payer.
# Flask 3 has no `before_serving`; run the preflight where your app boots
# (the module, a `create_app()` factory, or a gunicorn `on_starting` hook) and
# skip it in `flask db upgrade`-style commands that have no wallet access.
if os.environ.get("OPENRECEIVE_PREFLIGHT", "1") == "1":
    bp.preflight()
```

Migrate the two tables through your own tooling first — `openreceive scaffold
payments --alembic --dialect postgres` (Flask-Migrate is Alembic) or `--sql`.

## CSRF: the header

Flask-WTF reads the token from the `X-CSRFToken` header as well as a form
field. Render it into the page and tell the checkout which header carries it —
`csrf-header` on the element, `csrfHeader` on the React/Vue/Svelte/Angular
wrappers — so every body-bearing request the checkout makes (`/checkouts`,
`/payments/check`, the swap routes) passes `CSRFProtect`:

```html
<meta name="csrf-token" content="{{ csrf_token() }}">
<openreceive-checkout reference="{{ order.id }}" prefix="/openreceive"
                      csrf-header="X-CSRFToken"></openreceive-checkout>
```

Hosts without a bundler load `@openreceive/elements`'s standalone build from a
static directory; with one, `import "@openreceive/elements"` (or the React
`<Checkout csrfHeader="X-CSRFToken" …/>`). The engine's own `Sec-Fetch-Site`
refusal still applies underneath.

## Worker, doctor, reconcile

The `openreceive` CLI takes `--app module:attr` naming an `OpenReceiveApp` or
a zero-argument callable returning one — `bp.preflight` above is exactly that:

```sh
openreceive doctor --app app:bp.preflight
openreceive reconcile --app app:bp.preflight
openreceive notifications --app app:bp.preflight     # the optional NWC-02 listener
```

`Sec-Fetch-Site`, the authorize context, `swap_data`, rate limiting and the
storage rules are the same as for FastAPI — read
[quickstart-fastapi.md](../guides/quickstart-fastapi.md) for the prose; only
the Flask glue above is different.
