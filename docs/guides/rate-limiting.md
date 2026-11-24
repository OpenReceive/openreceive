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

## Who limits what

Three different things can refuse a payment for rate. Only the first is this
option.

| Limit | Counts | Default |
| --- | --- | --- |
| `rateLimiting` (this guide) | new payments per client address | **off** |
| Your own throttle | whatever you choose: signed-in user, session, address | yours to add |
| The swap provider's limits | new swaps per provider account, site-wide | always on, see [below](#the-swap-providers-own-limits) |

OpenReceive does not know who your users are. A reference is your order ID,
and anyone who can open a checkout can usually open another. So the built-in
limit can only count a network address. A limit per signed-in user or per
session is yours to add in front of the OpenReceive routes. See
[Limits per user are yours](#limits-per-user-are-yours).

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

## Before you turn it on: check the address

The limit is only as good as the address it counts. Behind a reverse proxy,
load balancer, or CDN, your app may see the proxy's address on every request.
Then every payer shares one limit, and the 61st checkout of the hour is
refused for everyone.

Check which address your app records before you rely on the limit. Every
payment row stores it in `client_ip`, whether or not `rateLimiting` is on:

```sql
SELECT client_ip, COUNT(*) FROM openreceive_payments
GROUP BY client_ip ORDER BY COUNT(*) DESC LIMIT 10;
```

Make a test payment from your phone on mobile data and one from your desk.
You should see two different public addresses. If you see one address on
every row, an address starting `10.`, `172.16.` to `172.31.`, `192.168.` or
`127.`, or your CDN's address, fix the address first. See
[Getting the client IP right](#getting-the-client-ip-right).

The limiter protects you from the two cases it can detect:

- **A private or loopback address is never counted.** No payer on the internet
  has one, so it can only be your own proxy or network. The request is allowed
  and the server log says so once:
  `... this request's client address is 10.0.0.7, a private or loopback address ...`.
- **Every refusal names the address in the server log**, at most once a
  minute: `... refused a new payment from 203.0.113.9: 61 made in the last
  hour, limit 60`. If that address is your load balancer or CDN, every payer
  is sharing the limit.

It cannot detect a proxy with a public address, such as a cloud load balancer
or a CDN. Only the check above tells you that.

## Defaults

Rate limiting is **off** unless you set `rateLimiting`. With
`rateLimiting: true`:

| Setting | Default |
| --- | --- |
| Hourly cap | 60 invoice creations per IP per rolling hour |
| Daily cap | none (hourly only) |
| Throttled actions | `checkout.create`, `swap.create`. Status polling and quotes are never throttled |
| Missing IP | **fail open**: a request with no known IP is always allowed (a one-time warning is logged) |
| Private or loopback IP | never counted: it is your own proxy or network, not a payer (a one-time warning is logged) |
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
- `ip`: a custom client-IP extractor. It may return any stable string, such as
  an account ID. A value that is not an IP address is counted as given.
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

It is off by default. `true` gives the same 60/hour cap as Node.

The client IP follows Rails' trusted proxies
(`config.action_dispatch.trusted_proxies`). When the peer that connected to
your app is a trusted proxy, the client is the address that proxy forwarded
(`request.remote_ip`). When it is not, the client is the peer itself, whatever
the forwarding headers say, so a visitor who connects directly cannot pick
their own address.

Rails trusts private addresses by default. A proxy with a public address,
such as a cloud load balancer or a CDN, must be listed, or it is counted as
the client:

```ruby
# config/application.rb
config.action_dispatch.trusted_proxies =
  ActionDispatch::RemoteIp::TRUSTED_PROXIES + [IPAddr.new("198.51.100.20")]
```

`config.client_ip` supplies a custom extractor instead, for example one that
reads a header your CDN sets and your app verifies. For a policy the built-in
limiter cannot express, pass `config.rate_limit`. It gets the same context as
`config.authorize`. Do not combine `rate_limiting` with a custom repository.

## Python, PHP and WordPress

The same limiter, with the same defaults and the same two safeguards, is in
every engine:

| Engine | Turn it on | Client address |
| --- | --- | --- |
| Django | `OPENRECEIVE = {"RATE_LIMITING": True}` | `REMOTE_ADDR` |
| FastAPI | `rate_limiting=True` | the address uvicorn recorded (`--proxy-headers`); pass `client_ip=` for a header |
| Flask | `rate_limiting=True` | `request.remote_addr`; pass `client_ip=` for a header |
| Laravel | `'rate_limiting' => true` in `config/openreceive.php` | `$request->ip()`, which follows `TrustProxies` |
| Plain PHP | `rateLimiting: true` on the engine | `REMOTE_ADDR`; pass `clientIp:` for a header |
| WordPress | the plugin's rate limiting setting | `REMOTE_ADDR` |

`REMOTE_ADDR` is the address that connected to your app server. Behind a CDN
or a separate proxy that is the proxy, unless the server is set up to restore
the visitor's address (nginx `real_ip_header`, Apache `mod_remoteip`, a
trusted-proxy middleware, or your CDN's WordPress plugin). Run the check in
[Before you turn it on](#before-you-turn-it-on-check-the-address) first.

Plain PHP and WordPress run one process per request, so "once" in the two
warnings means once per request there. PHP writes them only when the engine
was given a logger.

## Limits per user are yours

A limit per signed-in user, per session, or per order belongs in your app,
because only your app knows who the user is and how orders get made. Put your
own throttle in front of the OpenReceive routes, with whatever your framework
already uses (`rack-attack`, `express-rate-limit`, Django REST throttles,
Laravel's `throttle` middleware).

Count the requests that start something:

| Request | What it starts |
| --- | --- |
| `POST {prefix}/checkouts/prepare` | a checkout session for an order |
| `POST {prefix}/checkouts` | a Lightning invoice |
| `POST {prefix}/swaps` | a swap order with your provider |
| your own "create order" route | a new reference, which resets every per-reference rule |

Leave the status polls alone, or give them a generous limit of their own. An
open checkout asks `payments/check` and `swaps/status` every 3 seconds, which
is 100 requests per tab every 5 minutes.

If orders are free to make on your site, limit how many one user can make.
Each new order is a new reference, and a reference may hold one open swap per
coin and network. For swap starts, [If you take coin
payments](#if-you-take-coin-payments) has a recipe.

## The swap provider's own limits

Your swap provider limits your API account, across all your payers together.
A swap start opens an order on that account, and the provider allows only so
many new orders a minute and only so many unpaid orders at once. When one
visitor starts swaps in a loop, the account reaches those limits and swaps
stop for everyone until they clear. Lightning keeps working.

Those limits are the provider's. OpenReceive does not count calls for a
provider, with one exception (FixedFloat, below). It obeys the provider's
answer instead. Lightning Swap is an example. It limits each account, gives a
new account lower limits that rise as it completes swaps, and answers a call
over a limit with HTTP `429` and a `Retry-After` header. It counts new swaps
apart from its other calls. So when a provider answers `429`:

- to a new swap, OpenReceive starts no new swaps with it for the wait the
  provider named: at least 1 second, at most 5 minutes, and 1 minute when it
  named none. Swaps already started keep updating, and refunds keep working.
- to any other call, OpenReceive makes no call to that provider for the wait.

While new swaps are stopped, a payer's new swap is refused before an invoice
is made for it.

**FixedFloat** (`ff.io`) is the one provider OpenReceive counts calls for,
because FixedFloat blocks an API key for longer each time it goes over: 250
weight a minute per key, and a new swap costs 50. Each server process keeps
its calls to at most 200 weight a minute. Status and refund calls may use only 50
of that between them, so open swap screens cannot use up the room for new
swaps: at least three new swaps a minute always fit, four when nothing else
ran. A FixedFloat `429` stops every call for at least a minute.

The provider is picked from the host in your `LSC_URI_*` code.

Plain PHP and WordPress start a new process for each request, so they keep no
per-minute count. They remember only a provider's 429 wait, in the cache the
engine already uses for prices, and refuse new swaps until it is over.

A payer who asks for a swap past a limit gets a retryable `503` with *"The
swap provider is rate limited. Please try again shortly."* No swap is started
for that request. The server log has one `swap.provider.rate_limited` warning
a minute. It says whether the provider answered 429, or OpenReceive refused
the call itself while it waits out a 429 (or, with FixedFloat, because the
minute's count was used up), and until when.

Two things keep ordinary payers far from these limits. The checkout shows the
amount for a coin before it starts a swap, so looking at several coins starts
none. And choosing a coin again reopens the swap the payer already has.

If you see the warning in normal traffic, limit swaps per payer as described
in [If you take coin payments](#if-you-take-coin-payments).

## If you take coin payments

This section applies only if you configured a swap provider (an `LSC_URI_*`
code). If your shop takes Lightning only, skip it.

Limits per payer on coin payments are your app's job. OpenReceive cannot tell
who a payer is: it sees an order reference, and anyone who can open one
checkout can usually open another. But every swap start opens an order on
your provider account, and the provider allows only so many unpaid orders at
once, for all your payers together. One visitor who starts swap after swap
without paying can fill that allowance and stop coin payments for everyone
until those orders expire.

One production shop runs the two limits below. Its numbers are five times the
real peak of its busiest paying customer. Measure your own customers' peaks
before you copy them.

### 1. Cap the open swaps of one payer

In OpenReceive's rate-limit hook, refuse a new swap when the signed-in
account, or the guest session, already has about 8 unpaid, unexpired swap
attempts across its orders.

- Count only pending swap attempts: rows in `openreceive_payments` with
  `swap_data` set, `status` `pending`, and `expires_at` still in the future.
  Never count paid swaps, and never count Lightning attempts. A refused payer
  can then still pay with Lightning.
- Fail open. If the count itself fails, for example on a database error,
  allow the swap.
- Refuse with the engine's `RATE_LIMITED` error. The payer reads your message,
  and the checkout treats the refusal as one to try again later.

The hook is called for every route, so return `true` for every action except
`swap.create`. It is called for `swap.create` only when a new swap would be
started, not when a payer reopens a swap they already have.

Express (Fastify, Next.js and `createHttpHandler` take the same
`rateLimitHook`):

```ts
import { HttpError, openReceiveExpress, type RateLimit } from "@openreceive/express";
import { amountFor, authorize, db, onPaid, query, sessions } from "./app.ts"; // your existing code

const MAX_OPEN_SWAPS = 8;

// Unpaid swap attempts across every order this payer owns. Lightning attempts
// have no swap_data. expires_at is in unix seconds. Use $1, $2 on Postgres.
const OPEN_SWAPS_SQL = `
  SELECT COUNT(*) AS n
    FROM openreceive_payments p
    JOIN orders o ON o.id = p.reference
   WHERE o.owner_key = ?
     AND p.swap_data IS NOT NULL
     AND p.status = 'pending'
     AND p.expires_at > ?`;

const rateLimitHook: RateLimit = async ({ action, native }) => {
  if (action !== "swap.create") return true;
  let open: number;
  try {
    // Your own lookup: the account id, or the guest session's id.
    const owner = await sessions.ownerKey(native);
    const [row] = await query(OPEN_SWAPS_SQL, [owner, Math.floor(Date.now() / 1000)]);
    open = Number(row.n);
  } catch (error) {
    console.warn("open swap count failed; allowing the swap", error);
    return true;
  }
  if (open < MAX_OPEN_SWAPS) return true;
  throw new HttpError(
    429,
    "RATE_LIMITED",
    "You have several unpaid coin payments open. Pay one of them, or pay with Lightning.",
    { retryable: true },
  );
};

app.use(
  openReceiveExpress({
    wallet: { nwc: process.env.NWC_URI! },
    storage: { db, onPaid },
    amountFor,
    authorize,
    rateLimitHook,
  }),
);
```

Rails, in `config/initializers/openreceive.rb`:

```ruby
MAX_OPEN_SWAPS = 8

OpenReceive.configure do |config|
  config.rate_limit = lambda do |context|
    return true unless context[:action] == "swap.create"

    open_swaps =
      begin
        # Your own scope: the orders of the signed-in account, or of the guest session.
        orders = Order.owned_by(context[:request].session)
        OpenReceivePayment.pending
                          .where.not(swap_data: nil)
                          .where("expires_at > ?", Time.current)
                          .where(reference: orders.pluck(:id).map(&:to_s))
                          .count
      rescue StandardError => e
        Rails.logger.warn("open swap count failed; allowing the swap: #{e.class}")
        return true
      end
    return true if open_swaps < MAX_OPEN_SWAPS

    raise OpenReceive::Server::RateLimitedError,
          "You have several unpaid coin payments open. Pay one of them, or pay with Lightning."
  end
end
```

The other engines take the same hook under their own names:

| Engine | Hook | Refuse with |
| --- | --- | --- |
| Node | `rateLimitHook` | `throw new HttpError(429, "RATE_LIMITED", message, { retryable: true })` |
| Rails | `config.rate_limit` | `raise OpenReceive::Server::RateLimitedError, message` |
| FastAPI | `openreceive_router(..., rate_limit=hook)` | `raise RateLimitedError(message)`, from `openreceive.server.errors` |
| Flask | `OpenReceiveApp(..., rate_limit=hook)` | the same |
| Plain PHP | `new Engine(..., rateLimit: $hook)` | `throw new \OpenReceive\Server\Errors\RateLimitedError($message)` |

Every hook gets the same context as `authorize`: the action (`swap.create`
for a swap start), your framework's request, and the order reference.
Returning `false` refuses too, with the generic message *"Too many
requests."* A custom hook replaces the built-in `rateLimiting`: the two cannot
be combined. Django settings and the Laravel config have no key for a custom
hook. There, run the same count in your own middleware in front of
`POST {prefix}/swaps`, next to the limit in step 2.

### 2. Cap swap starts per hour

In your app's own middleware, in front of `POST {prefix}/swaps`, cap swap
starts per account and per client address: about 20 an hour each. That route
starts swaps; leave `/swaps/quote`, `/swaps/status` and `/swaps/refunds`
alone. Count the payer's own address, never your proxy's or load balancer's.
See [Getting the client IP right](#getting-the-client-ip-right). Answer with
the JSON the checkout shows: `code`, `message` and `retryable`.

Express, with `express-rate-limit` (after `app.set("trust proxy", ...)` when
you run behind a proxy):

```ts
import { rateLimit } from "express-rate-limit";

const refused = {
  code: "RATE_LIMITED",
  message: "Too many coin payments started. Please try again later.",
  retryable: true,
};
const hour = 60 * 60 * 1000;
const swapStartsPerAccount = rateLimit({
  windowMs: hour,
  limit: 20,
  message: refused,
  skip: (req) => req.session?.userId === undefined,
  keyGenerator: (req) => `account:${req.session.userId}`,
});
const swapStartsPerAddress = rateLimit({ windowMs: hour, limit: 20, message: refused });

app.post("/openreceive/swaps", swapStartsPerAccount, swapStartsPerAddress);
app.use(openreceive);
```

Rails, with `rack-attack`, in `config/initializers/rack_attack.rb`:

```ruby
swap_start = ->(request) { request.post? && request.path == "/openreceive/swaps" }

Rack::Attack.throttle("swap starts per account", limit: 20, period: 1.hour) do |request|
  request.env["rack.session"]&.[]("user_id") if swap_start.call(request)
end

Rack::Attack.throttle("swap starts per address", limit: 20, period: 1.hour) do |request|
  # remote_ip follows config.action_dispatch.trusted_proxies, so a proxy is not the payer.
  ActionDispatch::Request.new(request.env).remote_ip if swap_start.call(request)
end
```

Give `Rack::Attack.throttled_responder` a JSON body with `code`, `message`
and `retryable` too, or the checkout shows its own generic message.

## Custom policies

The built-in limiter only meters invoice **creation** (`checkout.create` /
`swap.create`), because it counts committed attempt rows. It does not meter
`swap.quote` or `checkout.prepare`. A script can call those freely. A swap
quote is answered from a cached price list and starts nothing at the provider.
If that load matters for your deployment, limit those actions with a custom
`rateLimitHook` backed by your own counter.

You can use `rateLimiting` or the lower-level `rateLimitHook`, but not both.
Pass `rateLimitHook` for policies the built-in limiter cannot express, such as
per-session budgets, exempting signed-in users, or an external limiter service.
It gets the same context as `authorize`. Return `false` for a generic `429`. Or
throw an `HttpError(429, "RATE_LIMITED", message, { retryable: true })` for a
custom payer-facing message. `@openreceive/http` exports
`createIpRateLimit(config)` so a custom hook can build on the built-in behavior.
