# Django quickstart

Requires Python ≥ 3.10 and Django ≥ 5.2 (PostgreSQL, SQLite or MySQL).

Install the Python package with the Django extra:

```sh
pip install "openreceive[django]"
```

That is the whole install: `openreceive[django]` brings Django; the wallet
client (websockets, coincurve, cryptography), the HTTP engine and the
`openreceive` CLI come with the base package. Use `uv` or a virtualenv on
Python 3.10 or newer; a system Python 3.9 cannot install it. Hosts that bring
their own NWC client set `OPENRECEIVE["SERVICE"]` instead (below).

Then add the app, point it at a host class, and mount the routes:

```python
# settings.py
INSTALLED_APPS += ["openreceive.django"]

OPENRECEIVE = {
    "HOST": "shop.openreceive_host.Host",   # the class with the three hooks (generated below)
    "PRICE_CURRENCIES": ["USD"],
    "RATE_LIMITING": False,                 # True for public web shops (see below)
    "OPPORTUNISTIC_RECONCILE": True,        # or {"min_interval_seconds": …}; False only with your own worker
    "DATABASE": "default",                  # the DATABASES alias that holds the two engine tables
}
```

```python
# urls.py
from django.urls import include, path
urlpatterns += [path("openreceive/", include("openreceive.django.urls"))]
```

`HOST` is a dotted path, not a callable — cache-safe, `manage.py check`
friendly, the `AUTH_USER_MODEL` idiom. Then run:

```sh
manage.py openreceive_install shop      # writes shop/openreceive_host.py, prints the lines above
manage.py migrate                        # creates openreceive_payments and openreceive_meta
```

`openreceive_install` writes one file — `<app>/openreceive_host.py`, the
three hooks with the generated placeholders wired and the exactly-once
fulfillment note as comments — and prints the settings and urls lines to add.
It never edits `settings.py` or `urls.py`. The migration ships inside the
`openreceive.django` app, so `manage.py migrate` applies it alongside your
own; it adapts to the configured database backend.

The `OpenReceivePayment` model is engine-owned — no model file is generated,
and the migration adds only the engine's two tables to your database. The
engine owns the table's commit locking, write-once settlement, and
reconciliation state machine. `reference` is indexed but not unique (a
reference may have many historical attempts); `payment_hash` is globally
unique. On SQLite give the database
`OPTIONS = {"transaction_mode": "IMMEDIATE"}` (Django ≥ 5.1) so two
concurrent commits for one order queue on the busy timeout instead of failing
with "database is locked" ([Payment storage](storage.md)).

### Fulfill exactly once

<!-- shared:begin fulfill-once -->
Within OpenReceive's own settlement paths, `on_paid` runs at most once per
reference: a second payment to a second invoice is recorded with
`status_reason = "duplicate_settlement"` and never fulfills again.
<!-- shared:end fulfill-once -->

The one thing you own: **if anything other than OpenReceive can also fulfill
an order** — an admin action, a second payment processor, a replayed job —
those paths race each other, and `on_paid` must be idempotent. The generated
host module spells this out and shows the guarded transition:

```python
def on_paid(self, settlement: PaymentSettlement) -> None:
    claimed = Order.objects.filter(
        pk=settlement.reference, state="awaiting_payment"
    ).update(state="paid", paid_at=datetime.fromtimestamp(settlement.paid_at, tz=UTC))
    if claimed == 0:
        return  # someone else already fulfilled it

    # FulfillOrder — like Order — is your own application code: ship the goods,
    # enqueue the confirmation email. OpenReceive provides neither.
    FulfillOrder.run(settlement.reference, payment_hash=settlement.payment_hash)
```

Delivery is at-least-once: `on_paid` runs inside the settlement transaction
(the engine wraps it in `transaction.atomic()`), and an exception rolls it back
for the next pass to retry. Keep it to database writes on the order — an email
or webhook sent from here would survive the rollback and go out again. The
`state="paid"` transition above is the flag; drain it after commit from
`after_paid`, the optional fourth method, which runs once after the settlement
transaction committed, or from your own job.

**`QuerySet.update()` fires no signals and calls no `save()`.** That is the
point — it is one conditional `UPDATE`, so the claim is atomic and there is no
model code between the check and the write. It also means no `post_save`
handler runs, which is fine for a job draining the flag and useless for a
model whose transition lives in `save()`. If your model owns the transition
through signals or an overridden `save()`, take a row lock for the duration
instead:

```python
def on_paid(self, settlement: PaymentSettlement) -> None:
    order = Order.objects.select_for_update().filter(pk=settlement.reference).first()  # SELECT … FOR UPDATE
    if order is None or order.state != "awaiting_payment":
        return
    order.state = "paid"
    order.paid_at = datetime.fromtimestamp(settlement.paid_at, tz=UTC)
    order.save()  # signals fire
```

**Unlocking a download works the same way.** If what the payer bought is a
file, do not unlock it in the browser: gate the download view on the paid
order row —
`get_object_or_404(Order, pk=reference, user=request.user, state="paid")` —
and serve the file only then. The `state="paid"` written above is the unlock;
the client never decides an order was fulfilled, it re-reads the row. Buy a
Button's `download` view is this in twenty lines.

Both shapes are idempotent, and both are correct. They differ only in whether
your model layer gets to run: `update()` skips it and is the right default; the
row lock (a no-op on SQLite, where the transaction itself serializes writers)
holds the row for the duration of the method and is what you want when the
transition has to go through your model. The generated fulfillment note says
the same thing — if your fulfillment is a read-modify-write that cannot be
expressed as one conditional `UPDATE`, take the lock.

A runnable illustration of this boundary — not a template to copy models from —
is Buy a Button
([`examples/buttons/server/django`](../../examples/buttons/server/django)).
It has products, visitors, and orders, with the three hooks as the only bridge.
Map that shape onto the models in THIS app.

## Add wallet credentials

Put the credentials in the server's environment:

<!-- shared:begin credentials -->
```dotenv
NWC_URI=
LSC_URI_PRIMARY=
LSC_URI_BACKUP=
```

1. Get a receive-only NWC code from a compatible wallet
   ([get one here](https://openreceive.org/get_a_nwc_code_to_receive_payments))
   → `NWC_URI`.
2. Optionally set up a [swap provider](https://openreceive.org/set_up_swap_provider)
   → `LSC_URI_PRIMARY` (and `LSC_URI_BACKUP` if you have one).

Never put these values in browser code. Your application refuses to start if
the NWC code also advertises spend methods such as `pay_invoice`; mint a
receive-only code ([Security](security.md)).
<!-- shared:end credentials -->

OpenReceive reads `os.environ`; Django does not load a `.env` file on its own.
`django-environ`, an exported shell environment, or your production secret
manager has to put the values there first. The explicit override for a
spend-capable code is `OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC=true`.
→ [Environment variables](environment-variables.md).

## Configure the host hooks

The host class needs three things: authorization, the trusted price, and
fulfillment. All three receive the `reference` — a string you choose, and the
fulfillment identity: your order id, one per thing you fulfill, created before
checkout, kept across retries, never reused. OpenReceive never looks inside
it, but `on_paid` runs once per reference, a new checkout under a reference
that already settled is refused with 409, and a fresh id per page load lets
one order be paid twice.

```python
# shop/openreceive_host.py — generated by `manage.py openreceive_install shop`, then filled in.
from datetime import UTC, datetime

from openreceive.server import HookContext
from openreceive.storage import PaymentSettlement

from shop.models import Order  # YOUR model — it could be named anything. OpenReceive
                               # never sees it or touches its table; these hooks are the
                               # only bridge between the engine and your data.


class Host:
    # Your policy, called before every checkout/payment/swap request. `context`
    # has three attributes:
    #   context.action    — which route: "checkout.prepare", "checkout.create",
    #                       "payment.check", "swap.quote", "swap.create",
    #                       "swap.read", or "swap.refund"
    #   context.request   — the django.http.HttpRequest; read request.user,
    #                       request.session or cookies from it, as in a view
    #   context.resource  — {"reference": ..., "payment_hash": ...} copied from
    #                       the payer's JSON body. It names an order; it does
    #                       not prove this caller owns it. reference is always a
    #                       validated non-empty str (≤200 chars); payment_hash
    #                       is absent except on payment.check / swap.read /
    #                       swap.refund.
    # Return True to allow, False for a 403. Here: only the signed-in customer
    # who placed the order may act on it.
    def authorize(self, context: HookContext) -> bool:
        order = Order.objects.filter(pk=context.resource["reference"]).first()
        return order is not None and order.user_id == context.request.user.id

    # The price for a reference — here, your order id — from your own data;
    # None when there is nothing to pay for (a 404). `value` is a decimal
    # STRING from the order row, never a float and never a request param.
    # `description` is what the payer is buying, in your own words.
    def amount_for(self, reference: str) -> dict | None:
        order = Order.objects.filter(pk=reference).first()
        if order is None:
            return None
        return {"currency": "USD", "value": str(order.total),
                "description": f"{order.items.count()} items"}

    # Runs inside the settlement transaction, only for the order's first settled
    # attempt. The WHERE clause is the lock: a second fulfillment path of yours
    # (admin action, replayed job) updates zero rows and does nothing. Plain
    # ORM calls, because the engine WRAPS this method in transaction.atomic();
    # `settlement.connection` is None here. (The SQLAlchemy adapters instead
    # hand on_paid the transaction's Connection — the one shape difference.)
    def on_paid(self, settlement: PaymentSettlement) -> None:
        Order.objects.filter(pk=settlement.reference, state="awaiting_payment").update(
            state="paid", paid_at=datetime.fromtimestamp(settlement.paid_at, tz=UTC)
        )
```

`authorize` receives the Django request that carried the payer's call, so
`request.user`, `request.session` and cookies are all there — keep the
project's authentication and its `User`; OpenReceive mints no tokens of its
own. The engine reads nothing else from the request: whatever your middleware
stack put on it is what your policy sees.

CSRF stays on. `CsrfViewMiddleware` is the host's, and the mounted routes run
its check like any other view — a failed check answers with the shared
`403 FORBIDDEN` JSON error instead of the HTML failure page. Render
`<meta name="csrf-token" content="{{ csrf_token }}">` in the template that
shows the checkout, and give the element `csrf-header="X-CSRFToken"` (the
header Django reads; the default is Rails' `X-CSRF-Token`) — the checkout
client sends the token from that tag on every request. A view that renders a
page with no form still needs `{% csrf_token %}` or `ensure_csrf_cookie` for
the cookie to exist; `{{ csrf_token }}` in the meta tag does that on its own.

The generated host module ships `on_paid = staticmethod(LOGGING_ON_PAID)` — a
placeholder that only logs the settlement and fulfills nothing. Replace it
with your real fulfillment (as above); `manage.py check` warns
(`openreceive.W001`) at every boot while the placeholder is still configured,
because orders would otherwise be recorded as settled without ever being
fulfilled. The same applies to `authorize = staticmethod(ALLOW_ALL_AUTHORIZE)`,
the generated allow-all placeholder: it treats possession of the reference as
authorization, which is safe only while references are unguessable, and the
check warns (`openreceive.W002`) until you replace it with your own ownership
check (as above). Replace both, not just `on_paid`. A `HOST` that is missing
or does not import is `openreceive.E001`.

The amount always comes from your own order record; payer-supplied amounts are
rejected. Hosts that bring their own NWC client, price feed or swap providers
set `OPENRECEIVE["SERVICE"]` to the dotted path of a callable
`(env) -> openreceive.server.Service`; everyone else leaves it out.

For public web shops, opt into the per-IP invoice cap with
`"RATE_LIMITING": True` (or `{"limit_per_hour": …, "limit_per_day": …}`);
leave it off (the default) when many payers share one IP. It counts
`REMOTE_ADDR` after your own proxy handling, so behind a reverse proxy put a
trusted-proxy middleware first or the cap counts the proxy.
→ [Rate limiting](rate-limiting.md)

The wallet client — and its receive-only preflight — is built lazily on the
first request, never in `AppConfig.ready()`: that method runs for `migrate`,
`collectstatic` and shells too, and a relay probe there would break them on a
box with no relay access. To fail a deploy on a bad `NWC_URI` instead of
surfacing customer-facing 500s, run the preflight as a system check in your
deploy pipeline:

```sh
OPENRECEIVE_PREFLIGHT=1 manage.py check --deploy    # openreceive.E002 on a missing, dead or spend-capable code
manage.py openreceive_doctor                        # the same, for humans; never prints a secret
```

## Render the checkout

The app serves JSON checkout routes only — rendering is your template. Any
OpenReceive frontend package works against the `/openreceive` mount; the
smallest is the custom element, and the Python package carries its
standalone build as static files, so a Django template needs no JavaScript
bundler at all:

```django
{# templates/orders/pay.html #}
{% load static %}
<meta name="csrf-token" content="{{ csrf_token }}">
<link rel="stylesheet" href="{% static 'openreceive/openreceive-checkout.css' %}">
<script type="module" src="{% static 'openreceive/openreceive-checkout.js' %}"></script>

<openreceive-checkout
  reference="{{ order.pk }}"
  csrf-header="X-CSRFToken"></openreceive-checkout>
```

`openreceive-checkout.js` registers the `<openreceive-checkout>` tag when it
loads (one self-contained ES module, un-minified identifiers), and the
stylesheet is scoped to what OpenReceive renders so it sits safely next to any
CSS framework in any order. `collectstatic` ships both with the rest of your
static files; the package's `MANIFEST.json` names every file and its hash. The
element creates the checkout for `reference`, then renders and polls itself
(its default `prefix` is already `/openreceive`).

Everything the checkout draws ships inside the JavaScript: the payment-method
icons, the wallet logos and the pay tutorials. There is no image file to copy
or serve and no asset option to set, under any bundler or with none. The
tutorials load as a lazy chunk on first open. If your Content-Security-Policy
has a strict `img-src`, allow `data:`
([Provider registry](provider-registry.md#assets)).

Then open the checkout in a browser and confirm the wallet logos and
payment-method icons render. Nothing is served from disk, so a missing image
means a Content-Security-Policy `img-src` that blocks `data:` — the browser
console names it.

Hosts with a JavaScript bundler use the npm packages instead — the same
element from `@openreceive/elements` (`defineElements()` once per page, then
the tag above), or the matching React/Vue/Svelte/Angular wrapper with the
`csrfHeader="X-CSRFToken"` prop, same defaults ([Frontend
checkout](frontend-checkout.md)). Build a custom checkout only if this app
cannot use a drop-in; then `@openreceive/browser/headless` is the API
([Headless checkout](headless-checkout.md)).

## Reconciliation

Settlement runs on the request path. You do not need a cron job. Disable or
tune it with `"OPPORTUNISTIC_RECONCILE"` (`False`, or
`{"min_interval_seconds": …}`).

Optionally, run one worker so settlement does not wait for the next page
load:

```sh
manage.py openreceive_notifications
```

It listens for NWC-02 `payment_received` notifications AND runs a periodic
reconcile pass (`OPENRECEIVE_NOTIFICATIONS_RECONCILE_INTERVAL_SECONDS`, default
15) in the same process — the safety net for notifications missed while it was
down. One process total, not one per web instance.

`manage.py openreceive_reconcile` is the one-shot primitive if you want to
drive a pass yourself.

## Swap secrets

The Python engine recognizes `LSC_URI_PRIMARY` and `LSC_URI_BACKUP` using the
shared [Lightning Swap Connect](lightning-swap-connect.md) vectors: setting
either one auto-builds the matching provider, so an app that wants swaps only
supplies the connection strings ([Environment
variables](environment-variables.md)). `OPENRECEIVE["SERVICE"]` is the
override knob — build the `Service` with your own providers, or an empty list
to disable swaps.

One `openreceive_payments` row holds at most one provider order in its
server-only `swap_data` column. The engine excludes `swap_data` from the
model's `repr`, from the read-only admin it registers, and from every public
dict. Do not serialize it, log it, or return it from your own API; it may
contain a provider credential.

**Setting either connection string commits you to refunds.** A swap deposit can
arrive short or late, which leaves it `refund_required` at the provider with
only your UI able to claim it — and the payer claims it on a second visit,
after leaving your page for an address in another wallet. That needs a
per-order URL your app serves, a route that restores the order behind it, and
something that restores the ATTEMPT, since `/checkouts/prepare` returns none.
[Swap refunds](swap-refunds.md) is the whole of it; read it before you set
`LSC_URI_PRIMARY`.

<!-- shared:begin next -->
## Next

- [Authorization](authorization.md) — your policy boundary
- [Payment storage](storage.md) — the library-owned table and state machine
- [Frontend Checkout](frontend-checkout.md) — browser responsibilities
- [Automated Swaps](automated-swaps.md) — `swap_data`, and what turning swaps on commits you to
- [Swap refunds](swap-refunds.md) — the refund flow, and the per-order URL a payer needs to come back and use it. Read it before setting `LSC_URI_PRIMARY`
- [Security](security.md) — server-only secret boundaries

More on wiring, storage, and routes:
[Authorization](authorization.md), [Payment storage](storage.md),
[API reference](api-reference.md).
<!-- shared:end next -->
