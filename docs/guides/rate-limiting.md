# Rate limiting

OpenReceive can cap how many invoices one client IP may create. It is **off by
default** and enabled with one option:

```ts
app.use(openReceiveExpress({
  service,
  host,
  authorize,
  rateLimiting: true, // recommended for public web shops
}));
```

Over-limit requests get `429` with code `RATE_LIMITED`, `retryable: true`, and
the payer-facing message *"Too many payment attempts. Please try again later."*
The message string travels to the browser unchanged — `requestCheckout` throws
it and the checkout element/React `onError` receives it — so the payer sees a
useful error, not a network failure.

## When to enable it

Enable `rateLimiting` when payers reach checkout from their own devices — a
public web shop, paywall, or donation page — so one address cannot farm
invoices. Every invoice creation costs a wallet call and a database row;
without a cap, a scripted client can mint them for free.

Leave it **off** (the default) when many payers legitimately share one IP:

- **point-of-sale** — every customer pays through the terminal's connection;
- kiosks, box offices, and market stalls on venue Wi-Fi;
- corporate or campus NAT where one egress IP serves a whole building.

This is why the option is opt-in rather than opt-out: a default cap would
silently break exactly these deployments. If you need both — a public shop and
a POS lane — mount two handlers with different `rateLimiting` settings, or
supply a custom `rateLimitHook` that exempts authenticated terminals.

## Defaults

Rate limiting is **off** unless you set `rateLimiting`. With
`rateLimiting: true`:

| Setting | Default |
| --- | --- |
| Hourly cap | 60 invoice creations per IP per rolling hour |
| Daily cap | none (hourly only) |
| Throttled actions | `checkout.create`, `swap.create` — status polling and quotes are never throttled |
| Missing IP | **fail open**: an unattributable request is always allowed (a one-time warning is logged) |
| Counting | `openreceive_payments` rows via `client_ip` — persistent counting is required, there is no in-memory mode |
| Reuse | never throttled: the limit applies only when a new attempt would be minted |

The 60/hour default is deliberately generous: a genuine payer switching
payment methods mints a handful of attempts, and the browser and server already
reuse open invoices where possible. The cap exists to stop farming, not to
meter buyers.

## Changing the limits

Pass a config object instead of `true`:

```ts
rateLimiting: {
  limitPerHour: 60,          // default 60
  limitPerDay: 300,          // optional extra rolling 24h cap; unset by default
  message: "Too many payment attempts — try again in an hour.",
}
```

Advanced knobs, rarely needed: `actions` (which of the two invoice-minting
actions to throttle — other actions are rejected when the handler is
constructed, because row counting
counts mints and a throttle on anything else could never trigger), `ip`
(custom client-IP extractor), and `countAttemptsFromIp` (custom counting).

## How counting works

The limiter counts `openreceive_payments` rows by `client_ip`. There is no
separate counter table and no in-memory fallback, so the cap survives
restarts and applies across every instance sharing the database.

Reuse is never throttled — a capped payer can still re-fetch instructions
they were already given.

A custom repository must implement `countAttemptsFromIp`, or disable
`rateLimiting` and pass a `rateLimitHook` backed by your own store. The
handler refuses to start rather than silently running without a counter.

## Getting the client IP right

The IP comes from the framework request (`native.ip` — Express, Fastify).
Behind a proxy or load balancer you must configure the framework to trust your
proxy's `X-Forwarded-For` (Express: `app.set("trust proxy", 1)`); otherwise
every request appears to come from the proxy — or worse, from a spoofable
header.

All three adapters also accept `trustProxyIpHeader` as an alternative:
`true` reads the first hop of `x-forwarded-for` (safe only when **your own**
reverse proxy sets the header — a direct-to-origin client can forge it), and a
string names another trusted header (e.g. `"cf-connecting-ip"`).

**Next.js has no socket IP**: App Router handlers receive a web `Request`, so
the Next adapter cannot read `native.ip`. Enabling `rateLimiting` there
requires an explicit IP source — `openReceiveNextHandlers({ ...,
trustProxyIpHeader: true })`, a trusted-header name, or your own
`rateLimiting.ip` extractor.
Without one of these, the adapter refuses to construct rather than silently
running an inactive limiter.

When no IP is attributable the request is allowed and the row's
`client_ip` stays null: rate limiting degrades to off rather than blocking
payers. The first such request logs a one-time warning — if you see it on
every request, your adapter is not supplying an IP and the limiter is
effectively inactive.

`client_ip` is payer network metadata — treat it under your privacy policy
like any other request log, and prune old rows if you retain attempts long
term.

## Rails

The Rails engine ships the same control with the same semantics, configured in
the initializer:

```ruby
OpenReceive.configure do |config|
  # Recommended for public web shops; leave off for shared-IP deployments.
  config.rate_limiting = true
  # or: config.rate_limiting = { limit_per_hour: 60, limit_per_day: 300 }
end
```

Off by default. `true` is the same 60/hour cap as Node. The client IP
defaults to `ActionDispatch::Request#ip` (honors Rails' trusted proxies);
`config.client_ip` supplies a custom extractor. For a policy the built-in
limiter cannot express, pass `config.rate_limit` instead — same context as
`config.authorize`. Do not combine `rate_limiting` with a custom repository.

## Custom policies

Scope note: the built-in limiter meters invoice **minting** only
(`checkout.create` / `swap.create`) because it counts committed attempt rows.
`swap.quote` and `checkout.prepare` are not metered — a scripted client can
call them freely, and each swap quote is a live outbound provider call. If
that matters for your deployment, police those actions with a custom
`rateLimitHook` backed by your own counter.

`rateLimiting` and the lower-level `rateLimitHook` are mutually exclusive.
For policies the built-in limiter cannot express (per-session budgets,
exempting signed-in users, an external limiter service), pass `rateLimitHook`
instead — same context as `authorize`; return `false` for a generic `429`, or
throw an `HttpError(429, "RATE_LIMITED", message, { retryable: true })`
for a custom payer-facing message. `createIpRateLimit(config)` is
exported from `@openreceive/http` so a custom hook can compose the built-in
behavior.
