# Django quickstart

Requires Python ≥ 3.10 and Django ≥ 5.2 (PostgreSQL, SQLite or MySQL).

Install the Python package with the Django extra:

```sh
pip install "openreceive[django]"
```

That is the whole install. `openreceive[django]` brings Django. The base
package brings the wallet client (websockets, coincurve, cryptography), the
HTTP engine and the `openreceive` CLI. Use `uv` or a virtualenv on Python 3.10
or newer. A system Python 3.9 cannot install it. If your app brings its own NWC
client, set `OPENRECEIVE["SERVICE"]` instead (see below).

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

`HOST` is a dotted path, not a callable. That keeps it cache-safe and friendly
to `manage.py check`, like the `AUTH_USER_MODEL` setting. Then run:

```sh
manage.py openreceive_install shop      # writes shop/openreceive_host.py, prints the lines above
manage.py migrate                        # creates openreceive_payments and openreceive_meta
```

`openreceive_install` writes one file, `<app>/openreceive_host.py`. It holds
the three hooks with the generated placeholders wired in, and the exactly-once
fulfillment note as comments. The command then prints the settings and urls
lines to add. It never edits `settings.py` or `urls.py`. The migration ships
inside the `openreceive.django` app, so `manage.py migrate` applies it
alongside your own. It adapts to the configured database backend.

The engine owns the `OpenReceivePayment` model, so no model file is generated.
The migration adds only the engine's two tables to your database. The engine
owns the table's commit locking, write-once settlement, and reconciliation
state machine. `reference` is indexed but not unique, because one reference may
have many historical attempts. `payment_hash` is globally unique.

On SQLite, give the database `OPTIONS = {"transaction_mode": "IMMEDIATE"}`
(Django ≥ 5.1). Then two concurrent commits for one order wait on the busy
timeout instead of failing with "database is locked"
([Payment storage](storage.md)).

### Fulfill exactly once

<!-- shared:begin fulfill-once -->
Within OpenReceive's own settlement paths, `on_paid` runs at most once per
reference. If a second invoice for the same reference is paid, OpenReceive
records that payment with `status_reason = "duplicate_settlement"` and does
not fulfill again.
<!-- shared:end fulfill-once -->

One case is yours to handle. **If anything other than OpenReceive can also
fulfill an order**, such as an admin action, a second payment processor, or a
replayed job, those paths race each other. Then `on_paid` must be idempotent.
The generated host module explains this and shows the guarded transition:

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

Delivery is at-least-once. `on_paid` runs inside the settlement transaction,
which the engine wraps in `transaction.atomic()`. If it raises, the transaction
rolls back and the next pass retries. So keep `on_paid` to database writes on
the order. An email or webhook sent from here would survive the rollback and go
out again. The `state="paid"` transition above is the flag. Drain it after
commit, either from your own job or from `after_paid`. `after_paid` is the
optional fourth method. It runs once, after the settlement transaction
commits.

**`QuerySet.update()` fires no signals and calls no `save()`.** That is
intended. It runs one conditional `UPDATE`, so the claim is atomic and no model
code runs between the check and the write. It also means no `post_save`
handler runs. That is fine for a job that drains the flag. It does not work for
a model whose transition lives in `save()`. If your model owns the transition
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

**Unlocking a download works the same way.** If the payer bought a file, do not
unlock it in the browser. Gate the download view on the paid order row, and
serve the file only if that row exists:
`get_object_or_404(Order, pk=reference, user=request.user, state="paid")`. The
`state="paid"` written above is the unlock. The client never decides that an
order was fulfilled. It re-reads the row. Buy a Button's `download` view does
this in twenty lines.

Both shapes are idempotent and correct. They differ only in whether your model
layer runs:

- `update()` skips the model layer. It is the right default.
- The row lock holds the row for the duration of the method. Use it when the
  transition has to go through your model. On SQLite the lock does nothing,
  because the transaction itself already lets only one writer run at a time.

The generated fulfillment note says the same thing. If your fulfillment is a
read-modify-write that one conditional `UPDATE` cannot express, take the lock.

Buy a Button
([`examples/buttons/server/django`](../../examples/buttons/server/django))
is a runnable illustration of this boundary. It is not a template to copy
models from. It has products, visitors, and orders, and the three hooks are the
only bridge. Map that shape onto the models in THIS app.

## Add wallet credentials

Put the credentials in the server's environment:

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

OpenReceive reads `os.environ`. Django does not load a `.env` file on its own,
so something has to put the values there first: `django-environ`, an exported
shell environment, or your production secret manager. To allow a
spend-capable code explicitly, set `OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC=true`.
→ [Environment variables](environment-variables.md).

## Configure the host hooks

The host class needs three things: authorization, the trusted price, and
fulfillment. All three receive the `reference`. This is a string you choose,
and it is the fulfillment identity. Use your order id:

- one per thing you fulfill,
- created before checkout,
- kept across retries,
- never reused.

OpenReceive never looks inside it. But `on_paid` commits fulfillment once per
reference, and a new checkout under a reference that already settled is
refused with 409. A fresh id per page load would let one order be paid twice.

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

`authorize` receives the Django request that carried the payer's call. So
`request.user`, `request.session` and cookies are all available. Keep your
project's authentication and its `User`. OpenReceive mints no tokens of its
own. The engine reads nothing else from the request. Your policy sees whatever
your middleware stack put on it.

CSRF stays on. `CsrfViewMiddleware` is yours, and the mounted routes run its
check like any other view. A failed check returns the shared `403 FORBIDDEN`
JSON error instead of the HTML failure page. To make the check pass:

- Render `<meta name="csrf-token" content="{{ csrf_token }}">` in the template
  that shows the checkout.
- Give the element `csrf-header="X-CSRFToken"`. That is the header Django
  reads. The default is Rails' `X-CSRF-Token`.

The checkout client then sends the token from that tag on every request. A view
that renders a page with no form normally needs `{% csrf_token %}` or
`ensure_csrf_cookie` for the cookie to exist. `{{ csrf_token }}` in the meta
tag does that on its own.

The generated host module ships two placeholders. Replace both, not just
`on_paid`:

- `on_paid = staticmethod(LOGGING_ON_PAID)` only logs the settlement and
  fulfills nothing. Replace it with your real fulfillment (as above). Until you
  do, orders would be recorded as settled without ever being fulfilled, so
  `manage.py check` warns (`openreceive.W001`) at every boot.
- `authorize = staticmethod(ALLOW_ALL_AUTHORIZE)` allows everything. It treats
  possession of the reference as authorization, which is safe only while
  references are unguessable. The check warns (`openreceive.W002`) until you
  replace it with your own ownership check (as above).

A `HOST` that is missing or does not import is `openreceive.E001`.

The amount always comes from your own order record. Payer-supplied amounts are
rejected. If your app brings its own NWC client, price feed or swap providers,
set `OPENRECEIVE["SERVICE"]` to the dotted path of a callable
`(env) -> openreceive.server.Service`. Everyone else leaves it out.

For public web shops, turn on the per-IP invoice cap with
`"RATE_LIMITING": True` (or `{"limit_per_hour": …, "limit_per_day": …}`).
Leave it off (the default) when many payers share one IP. The cap counts
`REMOTE_ADDR` after your own proxy handling. Behind a reverse proxy, put a
trusted-proxy middleware first, or the cap counts the proxy instead of the
payer.
→ [Rate limiting](rate-limiting.md)

The wallet client, and its receive-only preflight, is built lazily on the first
request. It is never built in `AppConfig.ready()`. That method also runs for
`migrate`, `collectstatic` and shells, and a relay probe there would break them
on a machine with no relay access. To make a bad `NWC_URI` fail the deploy
instead of causing 500 errors for customers, run the preflight as a system check
in your deploy pipeline:

```sh
OPENRECEIVE_PREFLIGHT=1 manage.py check --deploy    # openreceive.E002 on a missing, dead or spend-capable code
manage.py openreceive_doctor                        # the same, for humans; never prints a secret
```

## Render the checkout

Serve the compiled `styles.css` without Tailwind processing. Either import it
from JavaScript (with a CSS-capable bundler) or use a plain
`<link rel="stylesheet">`. Do not `@import` it into your Tailwind entry. Its
rules have zero specificity, so your own styles can override checkout styles.
Scoping does not prevent that.

The app serves JSON checkout routes only. Your template does the rendering. Any
OpenReceive frontend package works against the `/openreceive` mount. The
smallest is the custom element. The Python package carries its standalone
build as static files, so a Django template needs no JavaScript bundler at all:

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
loads. It is one self-contained ES module with un-minified identifiers. The
stylesheet is scoped to what OpenReceive renders. `collectstatic` ships both
with the rest of your static files. The package's `MANIFEST.json` names every
file and its hash. The element creates the checkout for `reference`, then
renders and polls itself. Its default `prefix` is already `/openreceive`.

Everything the checkout draws ships inside the JavaScript: the payment-method
icons, the wallet logos and the pay tutorials. There is no image file to copy
or serve and no asset option to set. Deploy your normal JavaScript and CSS
build output, including any generated JavaScript chunks. Bundlers with code
splitting can load tutorial screenshots only when a tutorial is first opened.
Single-file builds, including the standalone checkout, include them upfront. If
your Content-Security-Policy has a strict `img-src`, allow `data:`
([Provider registry](provider-registry.md#assets)).

Then open the checkout in a browser. Confirm the payment-method icons and
wallet logos render, and open a wallet's pay tutorial to check its screenshots.
If an image is missing, check the console for CSP violations and the Network
panel for failed JavaScript chunks. Allow `data:` in `img-src` and deploy the
complete build output. Do not add image routes, copy package source images, or
use registry `icon_path` / tutorial `path` keys as browser URLs.

If your app has a JavaScript bundler, use the npm packages instead. Either use
the same element from `@openreceive/elements` (call `defineElements()` once per
page, then use the tag above), or use the matching React, Vue, Svelte, or
Angular wrapper with the `csrfHeader="X-CSRFToken"` prop. Both have the same
defaults ([Frontend checkout](frontend-checkout.md)). Build a custom checkout
only if this app cannot use a drop-in. In that case
`@openreceive/browser/headless` is the API
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

The worker listens for NWC-02 `payment_received` notifications. The same
process also runs a periodic reconcile pass, every
`OPENRECEIVE_NOTIFICATIONS_RECONCILE_INTERVAL_SECONDS` (default 15). That pass
catches notifications missed while the worker was down. Run one process in
total, not one per web instance.

To run a pass yourself, use the one-shot `manage.py openreceive_reconcile`.

## Swap secrets

The Python engine recognizes `LSC_URI_PRIMARY` and `LSC_URI_BACKUP`, using the
shared [Lightning Swap Connect](lightning-swap-connect.md) vectors. Setting
either one auto-builds the matching provider. So an app that wants swaps only
supplies the connection strings ([Environment
variables](environment-variables.md)). To override this, use
`OPENRECEIVE["SERVICE"]`. Build the `Service` with your own providers, or with
an empty list to disable swaps.

One `openreceive_payments` row holds at most one provider order, in its
server-only `swap_data` column. The engine leaves `swap_data` out of the
model's `repr`, out of the read-only admin it registers, and out of every
public dict. Do not serialize it, log it, or return it from your own API. It
may contain a provider credential.

**Setting either connection string commits you to refunds.** A swap deposit can
arrive short or late. The provider then marks it `refund_required`, and only
your UI can claim it. The payer claims it on a second visit, after leaving your
page to get an address in another wallet. That needs three things:

- a per-order URL your app serves,
- a route that restores the order behind it,
- something that restores the ATTEMPT, since `/checkouts/prepare` returns none.

[Swap refunds](swap-refunds.md) covers all of it. Read it before you set
`LSC_URI_PRIMARY`.

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
