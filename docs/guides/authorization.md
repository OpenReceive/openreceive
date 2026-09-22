# Authorization and the host

OpenReceive never inspects your session. Your app decides who may do what.
The usual setup is the all-in-one adapter factory. You give it your hooks, a
database handle, and your authorization policy. The adapter builds the wallet
client and the host itself.

```ts
import { openReceiveExpress } from "@openreceive/express";
import { db, orders, sessions } from "./app.ts"; // your existing handle and models

// `reference` is a string you choose — your order id: one per thing you
// fulfill, created before checkout, never reused. OpenReceive never looks
// inside it, but it fulfills once per reference and refuses a new checkout
// under a reference that already settled.

async function amountFor(reference: string) {
  // The price for this reference, from YOUR catalog/orders — never from the
  // payer. Return `{ currency, value }` (decimal string) or `{ sats }`.
  // `null` means there is nothing to pay for → 404.
  return orders.priceOf(reference);
}

async function onPaid({ reference, query }) {
  // Inside OpenReceive's settlement transaction, and only for the first
  // settled attempt for this reference.
  //
  // `query(sql, params?)` runs on that same transaction and returns rows.
  // The SQL is yours: OpenReceive does not know about `orders` or `state`.
  // This UPDATE is an example of what *you* might write, not a required
  // shape. Use `?` on sqlite, `$1` on postgres; the string is not rewritten.
  await query("UPDATE orders SET state = 'paid' WHERE id = ?", [reference]);
}

async function authorize({ action, request, resource, native }) {
  // One function, one argument (`AuthorizeContext`). Return `true` to allow
  // or `false` for 403. Sync or async — both are this same type.
  //
  // action   — which route: checkout.prepare | checkout.create | payment.check
  //            | swap.quote | swap.create | swap.read | swap.refund
  // request  — the Web-standard Request OpenReceive built (headers, URL, cookies)
  // native   — the Express `req`, when you need middleware-attached state
  //            (req.session). Omit it from the destructure if you don't.
  // resource — { reference?, paymentHash? } copied from the payer's JSON.
  //            A claim, not proof; see below. At runtime `reference` is always
  //            a validated non-empty string (≤200 chars); `paymentHash` is
  //            undefined except on payment.check / swap.read / swap.refund.
  const user = await sessions.currentUser(request);
  return orders.viewerMay(user, resource.reference, action);
}

const openreceive = openReceiveExpress({
  wallet: { nwc: process.env.NWC_URI! }, // receive-only; refuses to start otherwise
  storage: { db, onPaid },
  amountFor,
  authorize,
  // Public shops: 60 invoices / client IP / hour. Leave this off for POS,
  // where many payers share one IP. See Rate limiting.
  rateLimiting: true,
});

app.use(openreceive);
```

`authorize` is always `(context: AuthorizeContext) => boolean | Promise<boolean>`.
Some guides write `({ native, resource }) =>` or
`async ({ action, request, resource }) =>`. These are not other overloads.
They are the same callback, naming only the fields they read. TypeScript lets
you destructure a subset, and the object still has all four fields. You can
return a boolean or a Promise of one, because lookups are often async.

If you supply a `rateLimitHook`, it receives the same context. Returning
`false` gives a 429. For the common per-IP invoice cap, the one-line
`rateLimiting` option above is enough. See [Rate limiting](rate-limiting.md).

## resource is a claim, not proof

Every order-scoped request body includes a `reference` that the payer chose
to send. Usually it is there because the checkout UI put your order id there.
`payment.check`, `swap.read`, and `swap.refund` also send `payment_hash`.
OpenReceive copies those strings into `resource` and calls `authorize`
**before** it looks anything up.

They identify a row. They do not prove the caller may touch it.

- Anyone who can see or guess an order id can put it in the body. A
  checkout URL like `/checkout/ord_123`, a receipt, or a shared tab can leak
  `reference`.
- `paymentHash` is printed on the invoice (the QR the payer scans). Knowing
  the hash does not mean you own the order.

Suppose `authorize` returns true whenever `resource.reference` is present, or
whenever an order with that id exists. Then any caller can mint invoices, poll
status, or request a refund for someone else's order. Instead, look the order
up in **your** data. Check that **this caller** may perform **this `action`**
on it. Identify the caller by session cookie, signed guest token, or
logged-in user.

**The library ships no default at all.** `authorize` is unset until you set
it. Both stacks refuse to serve a checkout without it:

- The Node HTTP handler throws `TypeError: HTTP handler requires authorize; authentication belongs to
  the host.`
- The Rails engine raises `ConfigurationError`.

**The Rails install generator does ship a placeholder**, and it warns you
about it. `bin/rails generate openreceive:install` writes:

```ruby
config.authorize = OpenReceive::ALLOW_ALL_AUTHORIZE
```

This allows every request, so the five-minute demo works before you have a
session to check. It is a NAMED constant, not a literal lambda, so that the
engine can recognise it. At boot, the engine logs:

```
[openreceive] config.authorize is still the generated allow-all placeholder —
anyone holding an order id can mint invoices, poll status, and request refunds
for it. Safe only while your references are unguessable. Replace it in
config/initializers/openreceive.rb.
```

It keeps logging this for as long as the placeholder is there.
`OpenReceive::LOGGING_ON_PAID` gets the same treatment.
`bin/rails openreceive:doctor` reports it too. Replace it before anything
real. If you keep it on purpose, know that your references are doing the
whole job. The Node quickstart starts from a real check
(`orders.viewerMay(...)`). Node has no generator to run. You write the config
object yourself, so the example shows the honest version.

After you return true, the library still checks that a requested
`paymentHash` belongs to that `reference` before it loads server-only
`swap_data`. That check asks "does this attempt belong to this order?" It does
not ask "does this caller own the order?" The hash never grants access on its
own.

`reference` and `paymentHash` are optional on the TypeScript type because not
every action sends both. On the shipped routes, `reference` is always set.
`paymentHash` is set on the three attempt-scoped actions above.

Before `authorize` runs, the handler has already rejected a body `reference`
that is missing, empty, or too long (`400`, limit 200 characters, whitespace
trimmed). So at runtime `resource.reference` is always a non-empty string.
The `?` in the type covers all the actions together. It is not a value you
have to nil-check. `resource.paymentHash` is present only on `payment.check`,
`swap.read`, and `swap.refund`, and is `undefined` elsewhere. It is printed on
the invoice QR, so it proves even less than `reference` does.

Where does `resource.reference` come from? It is your own order id, coming
back to you:

1. Your page (or prepare endpoint) gave the checkout client a `reference`.
2. The client sends it back in the JSON body of every checkout call.
3. The handler copies it from that body into `resource`, before touching the
   database.

It left your server and came back through the payer's browser. So any caller
can send any order id they have ever seen. Look the row up in your own data,
and check that this session may perform this action on it.

## Reading a framework session

`request` is always a Fetch API `Request`. Express session middleware attaches
to Express's `req`, which is a different object. So the adapter also passes
the untouched `req` as `native`. It is the same `authorize`, with one extra
field:

```ts
const userId = (native as { session?: { userId?: string } }).session?.userId;
```

You still write one `authorize` function. You do not register a second one.
If your user lives on `req.session`, read `native`. If you look the session up
from cookies on the Web Request, read `request`.

Rails apps mount the engine and set the same policy as `config.authorize` in
the initializer. The contract is identical. The context is a Hash with symbol
keys:

```ruby
config.authorize = lambda do |context|
  # context[:action]   — same seven action strings as above
  # context[:request]  — the ActionDispatch::Request (session, cookies, headers)
  # context[:resource] — { reference:, payment_hash: } from the payer's body —
  #                      a claim, not proof (see below). reference is always a
  #                      validated non-empty String (≤200 chars); payment_hash
  #                      is nil except on payment.check / swap.read / swap.refund.
  # `Order` is your own model (any name) — the check runs against YOUR data.
  order = Order.find_by(id: context[:resource][:reference])
  order && order.user_id == context[:request].session[:user_id]
end
```

**Where `context[:resource][:reference]` comes from.** It is your own order
id, coming back to you. Your page (or prepare endpoint) gave the checkout
client a `reference`. The client sends it back in the JSON body of every
checkout call. The engine copies it from that body into `context[:resource]`,
before touching the database. It left your server and came back through the
payer's browser. So by the time your lambda sees it, it is payer input like
any other. Any caller can send any order id they have ever seen. Look the row
up in your own data, and check that this session may perform this action on
it.

Before `authorize` runs, the handler has already rejected a body `reference`
that is missing, empty, or too long (`400`, limit 200 characters). So
`context[:resource][:reference]` is always a non-empty `String`, and you need
no nil check. `context[:resource][:payment_hash]` is present only on the
attempt-scoped actions (`payment.check`, `swap.read`, `swap.refund`), and is
`nil` elsewhere. It is printed on the invoice QR, so it proves even less than
`reference` does.

Your app keeps its own authentication and `current_user` logic. The policy
reads the session the same way the rest of your app does. The engine also
inherits your `protect_from_forgery`. Render `csrf_meta_tags` in the layout,
and the checkout client sends `X-CSRF-Token` from it on every request. A
failed check returns the shared `403`. API-only parents
(`ActionController::API`) have no forgery protection. The handler's own checks,
described below, cover them.

## Cross-site requests

In both engines, the handler itself protects every route that takes a body
against cross-site request forgery. It does this before `authorize` runs:

- The body must be `application/json`, or the handler returns `415`. A
  cross-site HTML form can only send urlencoded, multipart, or `text/plain`.
  A cross-origin `fetch` that sets a JSON content type triggers a CORS
  preflight, and the library never answers one.
- The handler refuses (`403`) a request the browser labels
  `Sec-Fetch-Site: cross-site`. This also covers a `no-cors` fetch that
  forges the content type. `same-site` requests (a sibling subdomain) pass.
  So do requests without the header (non-browser clients).

Mount OpenReceive on the origin that serves your pages, or on a sibling
subdomain. Do not add CORS headers to its prefix.

`amountFor` is the other half of that boundary. The create body cannot
contain `amount` or `amount_msats`. A payer-supplied amount could only ever be
an attempt to pay less, or to trick support with an overpaid receipt. So the
route rejects it outright. If the attempt fails to commit, the payer gets no
invoice or swap instructions.

## Advanced: composing the pieces

Sometimes you need a shared wallet client, a custom payments repository, or
direct handler tests. Then build the pieces yourself and pass them to the same
adapter:

```ts
import { createOpenReceive } from "@openreceive/node";
import { createHost } from "@openreceive/http";

const service = await createOpenReceive();
const host = createHost({ db, amountFor, onPaid });
const openreceive = openReceiveExpress({ service, host, authorize });
app.use(openreceive);
```

The mounted routes still commit the attempt row before the payer sees any
instructions. `host.onCheckoutCreated` runs between the wallet mint and the
HTTP response. If the commit is refused, the route returns `409` and withholds
the invoice. An infrastructure failure returns a retryable `503` instead.
Only a fully custom server-side flow skips that wiring. Then the commit step
is yours:

```ts
const checkout = await service.createCheckout({ reference: order.id, amount });
await host.payments.commitAttempt({
  reference: order.id,
  paymentHash: checkout.paymentHash,
  checkout,
}); // commit BEFORE the payer sees the invoice
```

See [createHost](api-reference.md#createhost) and
[Payment storage](storage.md) for the repository escape hatch.
