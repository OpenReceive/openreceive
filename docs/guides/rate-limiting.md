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
supply a custom `rateLimit` hook that exempts authenticated terminals.

## Defaults

`rateLimiting: true` means:

| Setting | Default |
| --- | --- |
| Enabled | **No** — only when `rateLimiting` is set |
| Hourly cap | 60 invoice creations per IP per rolling hour |
| Daily cap | none (hourly only) |
| Throttled actions | `checkout.create`, `swap.create` — status polling and quotes are never throttled |
| Missing IP | **fail open**: an unattributable request is always allowed (a one-time warning is logged) |
| Counting | `openreceive_payments` rows via `client_ip` — persistent counting is required, there is no in-memory mode |
| Reuse | never throttled: the limit applies only when a new attempt would be minted |

The 60/hour default is deliberately generous: a genuine payer switching
payment methods mints a handful of attempts, and the browser and host already
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
actions to throttle — other actions are rejected at boot, because row counting
counts mints and a throttle on anything else could never trigger), `ip`
(custom client-IP extractor), and `countAttemptsFromIp` (custom counting).

## How counting works

There is no separate counter table. Every minted invoice is already persisted
as an `openreceive_payments` row, and the handler stamps the adapter's client
IP into its `client_ip` column at creation. The limiter is a `COUNT` over rows
you store anyway, so limits survive restarts and apply across every instance
sharing the database. See [Payment storage](storage.md) for the schema.

The limit is checked only when a new attempt would actually be minted.
Re-serving an attempt that is already committed for the order — the reuse path
— is never throttled, so a capped payer can always re-fetch the instructions
they were already given.

Persistent counting is **required**. If the payment repository cannot count
(`countAttemptsFromIp` is missing) and the config supplies no custom counter,
the handler throws at construction — your server fails at boot with a clear
message instead of silently degrading. There is deliberately no in-memory
fallback: per-process counts reset on restart and multiply per instance behind
a load balancer, which silently weakens a security control. Hosts on the
custom-repository escape hatch either implement the
`countAttemptsFromIp(clientIp, sinceUnixSeconds)` repository method (one
indexed `COUNT` over the `clientIp` the handler already passes with each
commit) or disable `rateLimiting` and pass a custom `rateLimit` hook backed by
their own store.

## Getting the client IP right

The IP comes from the framework request (`native.ip` — Express, Fastify).
Behind a proxy or load balancer you must configure the framework to trust your
proxy's `X-Forwarded-For` (Express: `app.set("trust proxy", 1)`); otherwise
every request appears to come from the proxy — or worse, from a spoofable
header.

**Next.js has no socket IP**: App Router handlers receive a web `Request`, so
the Next adapter cannot read `native.ip`. Enabling `rateLimiting` there
requires an explicit IP source — `openReceiveNextHandlers({ ...,
trustProxyIpHeader: true })` reads the first hop of `x-forwarded-for` (safe
only behind your own reverse proxy), a string names another trusted header
(e.g. `"cf-connecting-ip"`), or pass your own `rateLimiting.ip` extractor.
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

## Custom policies

Scope note: the built-in limiter meters invoice **minting** only
(`checkout.create` / `swap.create`) because it counts committed attempt rows.
`swap.quote` and `checkout.prepare` are not metered — a scripted client can
call them freely, and each swap quote is a live outbound provider call. If
that matters for your deployment, police those actions with a custom
`rateLimit` hook backed by your own counter.

`rateLimiting` and the lower-level `rateLimit` hook are mutually exclusive.
For policies the built-in limiter cannot express (per-session budgets,
exempting signed-in users, an external limiter service), pass `rateLimit`
instead — same context as `authorize`; return `false` for a generic `429`, or
throw an `OpenReceiveHttpError(429, "RATE_LIMITED", message, { retryable: true })`
for a custom payer-facing message. `createOpenReceiveIpRateLimit(config)` is
exported so a custom hook can compose the built-in behavior.
