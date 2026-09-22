# Rate limiting

OpenReceive can cap how many invoices one client IP may create. It is **off by
default**. You turn it on with one option:

```ts
app.use(openReceiveExpress({
  service,
  host,
  authorize,
  rateLimiting: true, // recommended for public web shops
}));
```

Requests over the limit get `429` with code `RATE_LIMITED`, `retryable: true`,
and the payer-facing message *"Too many payment attempts. Please try again later."*
The message reaches the browser unchanged. `requestCheckout` throws it, and the
checkout element or React `onError` receives it. So the payer sees a useful
error, not a network failure.

## When to enable it

Enable `rateLimiting` when payers reach checkout from their own devices, as in
a public web shop, paywall, or donation page. This stops one address from
farming invoices. Every invoice you create costs a wallet call and a database
row. Without a cap, a script can create them for free.

Leave it **off** (the default) when many real payers share one IP:

- **point-of-sale**: every customer pays through the terminal's connection
- kiosks, box offices, and market stalls on venue Wi-Fi
- corporate or campus NAT, where one outgoing IP serves a whole building

That is why you have to opt in. A default cap would quietly break exactly these
setups. If you need both, such as a public shop and a POS lane, mount two
handlers with different `rateLimiting` settings. Or supply a custom
`rateLimitHook` that exempts authenticated terminals.

## Defaults

Rate limiting is **off** unless you set `rateLimiting`. With
`rateLimiting: true`:

| Setting | Default |
| --- | --- |
| Hourly cap | 60 invoice creations per IP per rolling hour |
| Daily cap | none (hourly only) |
| Throttled actions | `checkout.create`, `swap.create`. Status polling and quotes are never throttled |
| Missing IP | **fail open**: a request with no known IP is always allowed (a one-time warning is logged) |
| Counting | `openreceive_payments` rows by `client_ip`. Persistent counting is required. There is no in-memory mode |
| Reuse | never throttled. The limit applies only when a new attempt would be created |

The 60/hour default is generous on purpose. A real payer who switches payment
methods creates only a handful of attempts. The browser and server also reuse
open invoices where they can. The cap is there to stop farming, not to meter
buyers.

## Changing the limits

Pass a config object instead of `true`:

```ts
rateLimiting: {
  limitPerHour: 60,          // default 60
  limitPerDay: 300,          // optional extra rolling 24h cap; unset by default
  message: "Too many payment attempts — try again in an hour.",
}
```

There are also advanced options you will rarely need:

- `actions`: which of the two invoice-creating actions to throttle. The handler
  rejects any other action when it is constructed. Row counting counts created
  invoices, so a throttle on anything else could never trigger.
- `ip`: a custom client-IP extractor.
- `countAttemptsFromIp`: custom counting.

## How counting works

The limiter counts `openreceive_payments` rows by `client_ip`. There is no
separate counter table and no in-memory fallback. So the cap survives restarts
and applies across every instance that shares the database.

Reuse is never throttled. A payer who hit the cap can still fetch the
instructions they were already given.

A custom repository must implement `countAttemptsFromIp`. Otherwise, turn off
`rateLimiting` and pass a `rateLimitHook` backed by your own store. The handler
refuses to start rather than quietly running without a counter.

## Getting the client IP right

The IP comes from the framework request (`native.ip` in Express and Fastify).
Behind a proxy or load balancer, you must configure the framework to trust your
proxy's `X-Forwarded-For` header (Express: `app.set("trust proxy", 1)`).
Otherwise every request seems to come from the proxy. Worse, it may come from a
header anyone can fake.

All three adapters also accept `trustProxyIpHeader` instead:

- `true` reads the first hop of `x-forwarded-for`. This is safe only when
  **your own** reverse proxy sets the header. A client that connects straight
  to your origin server can forge it.
- A string names another trusted header (e.g. `"cf-connecting-ip"`).

**Next.js has no socket IP.** App Router handlers receive a web `Request`, so
the Next adapter cannot read `native.ip`. To enable `rateLimiting` there, you
must give it an IP source: `openReceiveNextHandlers({ ...,
trustProxyIpHeader: true })`, a trusted header name, or your own
`rateLimiting.ip` extractor. Without one, the adapter refuses to construct
instead of quietly running a limiter that does nothing.

When a request has no known IP, it is allowed and the row's `client_ip` stays
null. Rate limiting falls back to off rather than blocking payers. The first
such request logs a one-time warning. If you see that warning on every request,
your adapter is not supplying an IP and the limiter is effectively off.

`client_ip` is network metadata about the payer. Handle it under your privacy
policy like any other request log. Prune old rows if you keep attempts for a
long time.

## Rails

The Rails engine has the same control, with the same behavior. You configure it
in the initializer:

```ruby
OpenReceive.configure do |config|
  # Recommended for public web shops; leave off for shared-IP deployments.
  config.rate_limiting = true
  # or: config.rate_limiting = { limit_per_hour: 60, limit_per_day: 300 }
end
```

It is off by default. `true` gives the same 60/hour cap as Node. The client IP
defaults to `ActionDispatch::Request#ip`, which honors Rails' trusted proxies.
`config.client_ip` supplies a custom extractor. For a policy the built-in
limiter cannot express, pass `config.rate_limit` instead. It gets the same
context as `config.authorize`. Do not combine `rate_limiting` with a custom
repository.

## Custom policies

The built-in limiter only meters invoice **creation** (`checkout.create` /
`swap.create`), because it counts committed attempt rows. It does not meter
`swap.quote` or `checkout.prepare`. A script can call those freely, and each
swap quote is a live outgoing call to the provider. If that matters for your
deployment, limit those actions with a custom `rateLimitHook` backed by your
own counter.

You can use `rateLimiting` or the lower-level `rateLimitHook`, but not both.
Pass `rateLimitHook` for policies the built-in limiter cannot express, such as
per-session budgets, exempting signed-in users, or an external limiter service.
It gets the same context as `authorize`. Return `false` for a generic `429`. Or
throw an `HttpError(429, "RATE_LIMITED", message, { retryable: true })` for a
custom payer-facing message. `@openreceive/http` exports
`createIpRateLimit(config)` so a custom hook can build on the built-in behavior.
