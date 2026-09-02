# Authorization and the host

OpenReceive never inspects your session. The happy path is the all-in-one
adapter factory: your hooks plus a database handle, and your authorization
policy. The adapter builds the wallet client and the host itself.

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
Guides that write `({ native, resource }) =>` or
`async ({ action, request, resource }) =>` are not other overloads — they are
this same callback, naming only the fields they read. TypeScript lets you
destructure a subset; the object still has all four. Returning a boolean and
returning a Promise of one are both allowed because lookups are often async.

`rateLimitHook`, if you supply one, receives that same context (`false` → 429).
For the common per-IP invoice cap, the one-line `rateLimiting` option above is
enough — see [Rate limiting](rate-limiting.md).

## resource is a claim, not proof

Every order-scoped body includes a `reference` the payer chose to send —
usually because the checkout UI put your order id there.
`payment.check`, `swap.read`, and `swap.refund` also send `payment_hash`.
OpenReceive copies those strings into `resource` and calls `authorize`
**before** it looks anything up.

They identify a row. They do not prove the caller may touch it.

- Anyone who can observe or guess an order id can put it in the body. A
  checkout URL like `/checkout/ord_123`, a receipt, or a shared tab leaks
  `reference`.
- `paymentHash` is printed on the invoice (the QR the payer scans). Knowing
  the hash does not mean you own the order.

If `authorize` returns true whenever `resource.reference` is present, or
whenever an order with that id exists, any caller can mint invoices, poll
status, or request a refund for someone else's order. Look the order up in
**your** data and check that **this caller** — session cookie, signed guest
token, logged-in user — may perform **this `action`** on it.

**The library ships no default at all**: `authorize` is unset until you set it,
and both stacks refuse to serve a checkout without it — the Node HTTP handler
throws `TypeError: HTTP handler requires authorize; authentication belongs to
the host.`, and the Rails engine raises `ConfigurationError`.

**The Rails install generator does ship a placeholder**, and says so out loud.
`bin/rails generate openreceive:install` writes:

```ruby
config.authorize = OpenReceive::ALLOW_ALL_AUTHORIZE
```

which allows every request, so the five-minute demo works before you have a
session to check. It is a NAMED constant, not a literal lambda, precisely so the
engine can recognise it: at boot it logs

```
[openreceive] config.authorize is still the generated allow-all placeholder —
anyone holding an order id can mint invoices, poll status, and request refunds
for it. Safe only while your references are unguessable. Replace it in
config/initializers/openreceive.rb.
```

for as long as it is still there — the same treatment `OpenReceive::LOGGING_ON_PAID`
gets. `bin/rails openreceive:doctor` reports it too. Replace it before anything
real, or keep it deliberately and know that your references are doing the whole
job. The Node quickstart starts from a real check
(`orders.viewerMay(...)`) because there is no generator to run: you write the
config object yourself, so the example writes the honest version.

After you return true, the library still verifies that a requested
`paymentHash` belongs to that `reference` before loading server-only
`swap_data`. That check is "does this attempt sit on this order?", not "does
this caller own the order?" The hash is never an authorization capability.

`reference` and `paymentHash` are optional on the TypeScript type because not
every action sends both. On the shipped routes `reference` is always set;
`paymentHash` is set on the three attempt-scoped actions above.

By the time `authorize` runs, the handler has already rejected a missing,
empty, or over-long body `reference` (`400`, limit 200 characters, whitespace
trimmed), so `resource.reference` is always a non-empty string at runtime —
the `?` describes the union of actions, not a value you have to nil-check.
`resource.paymentHash` is present only on `payment.check`, `swap.read`, and
`swap.refund` and is `undefined` elsewhere; it is printed on the invoice QR,
so it proves even less than `reference` does.

Where `resource.reference` comes from: it is your own order id, finishing a
round trip. Your page (or prepare endpoint) gave the checkout client a
`reference`, the client sends it back in the JSON body of every checkout
call, and the handler copies it out of that body into `resource` — before
touching the database. It left your server and came back through the payer's
browser, so any caller can send any order id they have ever seen. Look the
row up in your own data and check that this session may perform this action
on it.

## Reading a framework session

`request` is always a Fetch API `Request`. Express session middleware attaches
to Express's `req`, which that object is not. The adapter therefore also
passes the untouched `req` as `native`. Same `authorize`, extra field:

```ts
const userId = (native as { session?: { userId?: string } }).session?.userId;
```

You still write the same `authorize` function. You do not register a second
one. If your user lives on `req.session`, read `native`; if you look the
session up from cookies on the Web Request, read `request`.

Rails applications mount the engine and configure the same policy as
`config.authorize` in the initializer. The contract is identical; the context
is a Hash with symbol keys:

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
id, finishing a round trip: your page (or prepare endpoint) gave the checkout
client a `reference`, the client sends it back in the JSON body of every
checkout call, and the engine copies it out of that body into
`context[:resource]` — before touching the database. It left your server and
came back through the payer's browser, so by the time your lambda sees it,
it is payer input like any other: any caller can send any order id they have
ever seen. Look the row up in your own data and check that this session
may perform this action on it.

By the time `authorize` runs, the handler has already rejected a missing,
empty, or over-long body `reference` (`400`, limit 200 characters), so
`context[:resource][:reference]` is always a non-empty `String` — no nil
check needed. `context[:resource][:payment_hash]` is present only on the
attempt-scoped actions (`payment.check`, `swap.read`, `swap.refund`) and is
`nil` elsewhere; it is printed on the invoice QR, so it proves even less
than `reference` does.

Your application keeps its own authentication and `current_user` logic — the
policy reads the session however the rest of your app does. The engine also
inherits your `protect_from_forgery`:
render `csrf_meta_tags` in the layout and the checkout client sends
`X-CSRF-Token` from it on every request; a failed check is the shared `403`.
API-only parents (`ActionController::API`) have no forgery protection, and
the handler's own gates below cover them.

## Cross-site requests

Every body-bearing route is protected against cross-site request forgery by
the handler itself, in both engines, before `authorize` runs:

- the body must be `application/json` (`415` otherwise). A cross-site HTML
  form can only send urlencoded, multipart, or `text/plain`, and a cross-origin
  `fetch` that sets a JSON content type is CORS-preflighted — which the library
  never answers;
- a request the browser labels `Sec-Fetch-Site: cross-site` is refused
  (`403`), which also covers a `no-cors` fetch that forges the content type.
  `same-site` (a sibling subdomain) and requests without the header
  (non-browser clients) pass.

Mount OpenReceive on the origin that serves your pages, or a sibling
subdomain; do not add CORS headers to its prefix.

`amountFor` is the other half of that boundary: the create body cannot contain
`amount` or `amount_msats`. A payer-supplied amount could only ever be an
attempt to pay less (or trick support with an overpaid receipt); the route
rejects it outright. A failed attempt commit withholds invoice and swap payer
instructions.

## Advanced: composing the pieces

When you need a shared wallet client, a custom payments repository, or direct
handler tests, build the pieces yourself and pass the composed form to the
same adapter:

```ts
import { createOpenReceive } from "@openreceive/node";
import { createHost } from "@openreceive/http";

const service = await createOpenReceive();
const host = createHost({ db, amountFor, onPaid });
const openreceive = openReceiveExpress({ service, host, authorize });
app.use(openreceive);
```

The mounted routes still commit the attempt row before any payer instructions
are exposed — `host.onCheckoutCreated` runs between the wallet mint and the
HTTP response, and a refused commit returns `409` (infrastructure failure:
retryable `503`) with the invoice withheld. Only a fully custom server-side
flow bypasses that wiring, and then the commit step is yours:

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
