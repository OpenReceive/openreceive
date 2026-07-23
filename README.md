# OpenReceive

Ship with a sensible payment default: accept Bitcoin. Your payouts land in the
most neutral, lowest-friction mutual currency on the internet—Bitcoin—while
your customers can start from balances they already hold: USDT, USDC, ETH,
SOL, and more.

OpenReceive adds uncensorable, global, permissionless inbound payments to a
website or app. Your server creates and verifies a Bitcoin Lightning BOLT11
invoice through a wallet you control. A payer can pay that invoice directly
with Lightning or, when you configure a swap provider, start with a familiar
coin and have the payment settle into Bitcoin.

OpenReceive is not a bank, exchange, wallet, broker, custodian, or payment
processor. It does not transmit money or hold customer funds. Your app brings
a server-side, receive-only Nostr Wallet Connect connection (NWC / NIP-47), and
OpenReceive helps your backend create invoices and verify settlement.

## What can customers pay with?

Every checkout ends at the same settlement primitive: a Lightning invoice paid
into the merchant wallet.

- **Bitcoin Lightning** — direct BOLT11 payment with no swap provider.
- **USDT** — automated pay-in routes on Tron, Solana, and Ethereum.
- **USDC** — automated pay-in routes on Solana and Ethereum.
- **SOL** — automated pay-in on Solana.
- **ETH** — automated pay-in on Ethereum.

Swap options appear only when a compatible provider is configured and returns
a usable quote. Actual availability, minimums, fees, liquidity, and regional
access belong to that provider; OpenReceive never promises that every route is
available for every payer.

Products can be priced directly in BTC or sats, or in a configured fiat
currency. The built-in price-feed data supports:

```text
USD, AED, ARS, AUD, BDT, BHD, BMD, BRL, CAD, CHF, CLP, CNY, CZK, DKK,
EUR, GBP, GEL, HKD, HUF, IDR, ILS, INR, JPY, KRW, KWD, LKR, MMK, MXN,
MYR, NGN, NOK, NZD, PHP, PKR, PLN, RUB, SAR, SEK, SGD, THB, TRY, TWD,
UAH, VEF, VND, ZAR
```

Fiat is a pricing input, not a settlement asset. OpenReceive converts the exact
decimal order price to sats when creating the invoice; public payment payloads
use `amount_msats`.

## Design

OpenReceive hinges on three ideas:

- **One receive primitive.** BOLT11 is widely recognized across wallets,
  exchanges, and services. Every payment route converges on one fast,
  interoperable Lightning invoice.
- **Your wallet, your funds.** OpenReceive uses receive-only NWC methods to
  create and inspect invoices. Receive-only NWC codes never belong in browser
  code, mobile apps, logs, screenshots, documentation examples, or demo assets.
- **Your app owns business state.** You keep authentication, carts, pricing,
  orders, idempotency, and fulfillment. OpenReceive does not need a database,
  Redis instance, migration, table, storage adapter, or durable worker state.

## The host contract

Add two fields to the order model you already have:

```text
payment_hash  nullable, unique
paid_at       nullable timestamp
```

For swaps, optionally add one server-only JSON/text `swap_data` field. It holds
the provider order ID and credential needed to inspect an unresolved swap. It
must never be returned to browser code or written to logs.
The required sequence is:

1. Your app creates and prices its order.
2. OpenReceive creates a checkout for that exact amount.
3. Your app stores `payment_hash` before returning the checkout to the payer.
4. OpenReceive verifies wallet settlement and calls `onPaid` at least once.
5. Your app finds the order by `payment_hash` and sets `paid_at` only when it is
   null.

The order row is also the invoice-creation idempotency guard. Concurrent or
retried create calls must converge on that row. Never display an invoice whose
hash the host did not commit.

## Direct Node API

```ts
import { createOpenReceive } from "@openreceive/node";

const openreceive = await createOpenReceive({
  onPaid: async ({ paymentHash, paidAt }) => {
    await orders.markPaidOnce({ paymentHash, paidAt });
  },
});

const existing = order.paymentHash
  ? await openreceive.recoverCheckout({
      orderId: order.id,
      paymentHash: order.paymentHash,
    })
  : null;

if (existing) return existing;

const checkout = await openreceive.createCheckout({
  orderId: order.id,
  amount: { currency: "USD", value: order.total.toString() },
});

if (!(await orders.storePaymentHashIfEmpty(order.id, checkout.paymentHash))) {
  throw new Error("Concurrent checkout won; retry without exposing this invoice.");
}
return checkout;
```

`createOpenReceive()` reads `nwc` from the root `openreceive.yml` by default.
Pass `nwc` explicitly only when you intentionally want to override the file
configuration, such as in a test.

`checkPayment({ paymentHash })` verifies a known order. `reconcilePayments`
checks unresolved host rows. `watchPayments({ onPaid })` scans overlapping
NIP-47 creation-time windows and delivers verified settlements at least once.

## Ship the routes, keep your auth

Browser integrations mount `@openreceive/http` through Express, Fastify, Next,
or Rails. OpenReceive never inspects the host session. It calls your
`authorize`, `resolveCheckout`, and `onCheckoutCreated` hooks and obeys
their results.

A create request supplies an order ID, never its own price. The host resolves
the authoritative amount from its order:

```ts
app.use(openReceiveExpress({
  // The configured OpenReceive service holds the receive-only wallet connection.
  // Keep this object on the server; never expose its NWC configuration to clients.
  service: openreceive,

  // Authentication and authorization belong entirely to your application.
  // An order ID identifies a row, but possession of that ID is not proof that
  // the caller owns the order.
  authorize: async ({ action, request, resource }) => {
    return orders.authorize({
      request,
      orderId: resource.order_id,
      action,
    });
  },

  // This hook runs after authorization. Load the order from your database and
  // return its server-owned payment state. Browser input is never the price
  // authority: the amount must come from your trusted order row.
  resolveCheckout: async ({ orderId }) => {
    const order = await orders.find(orderId);
    if (!order) {
      throw hostError("Order not found.", 404, "NOT_FOUND");
    }

    return {
      // OpenReceive uses this authoritative amount when creating an invoice or swap.
      amount: { currency: order.currency, value: order.total.toString() },

      // When present, the existing hash tells OpenReceive to recover the live
      // checkout instead of creating another invoice during a retry.
      ...(order.paymentHash ? { paymentHash: order.paymentHash } : {}),

      // swapData contains sensitive provider recovery credentials. Load it only
      // on the server. OpenReceive never includes it in the HTTP response.
      ...(order.swapData
        ? { swapData: order.swapData }
        : {}),
    };
  },

  // OpenReceive calls this before returning an invoice or swap deposit address
  // to the payer. Persist both values in the same database transaction.
  onCheckoutCreated: async ({
    orderId,
    paymentHash,
    swapData,
  }) => {
    // This operation must use a row lock or compare-and-set:
    // - store paymentHash only when the column is empty;
    // - accept the same hash on a retry;
    // - reject a different hash already committed by a concurrent request;
    // - store swapData only in a server-only JSON/text field.
    // Throwing here makes OpenReceive return 409 without exposing payer instructions.
    await orders.commitPaymentAttempt({
      orderId,
      paymentHash,
      swapData,
    });
  },
}));
```

`onCheckoutCreated` completes before the payer receives the invoice. A failed
host write gets a `409` response with no payer instructions. Rails hosts mount
the engine and retain their own CSRF, authentication, and `current_user` logic.

## Settlement and swaps

Wallet notifications are passive hints that wake reconciliation. Final
settlement requires `settled_at` or a wallet transaction state of `settled`; a
preimage alone is not final proof.

Swap recovery is independent of wallet settlement. The payment hash proves
that the merchant wallet was paid. The host's server-only `swap_data` field
contains the provider workflow details needed to query an unresolved swap
after a process restart. OpenReceive never exposes that field through its HTTP
routes. Refund calls are host-authorized and refresh provider state immediately
before acting.

Provider completion by itself never fulfills an order. The receiving wallet's
settled transaction remains authoritative.

## Repository map

- `spec/` is the source of truth for schemas, shared data, test vectors, and the
  shipped HTTP contract.
- `packages/js/` contains the core contracts, Node NWC service, HTTP routes,
  Express/Fastify/Next adapters, browser helpers, provider data, testkit,
  elements, and React/Vue/Svelte/Angular packages.
- `packages/ruby/` contains the dependency-free core, the Service and Rack app,
  and the mountable Rails engine—a second settlement implementation checked
  against shared vectors.
- `examples/hello-fruit/server/` contains Express, static HTML, and Next.js
  demos. Demo repositories model host-owned order persistence; they are not
  OpenReceive storage adapters.
- `tools/` contains validation, conformance, package-smoke, documentation, and
  live-wallet helpers.

## Run a demo

The Hello Fruit demos let you add products to a cart, create a host order, and
pay its live Lightning invoice:

```sh
npm run demo node      # Express + React/Vue/Svelte/Angular http://localhost:3000
npm run demo static    # Static HTML + small API             http://localhost:3001
npm run demo nextjs    # Next.js fullstack                   http://localhost:3002
```

Each command creates a root `openreceive.yml` if missing, validates `nwc`, and
runs that demo's Docker Compose stack. Set a valid receive-only NWC code from a
compatible wallet before checkout creation. Optional automated swaps are
configured server-side under `swap.providers`; provider credentials never
reach the browser.

Arguments after `--` are forwarded to `docker compose up`, for example:

```sh
npm run demo node -- -d
```

## Development status

The full gate keeps schemas, vectors, generated contracts, Node and Ruby
behavior, package artifacts, demos, secret scans, release metadata, deployment
templates, and documentation aligned:

```sh
npm run test:ci:core   # fast JS/package gate
npm run test:ci        # full gate, including Ruby, demos, and live NWC
npm test               # contracts and secret-safety checks
npm run test:live:nwc  # live wallet smoke; skips when NWC is not configured
```

## Product boundary

OpenReceive creates a Lightning invoice and can return payer-side guidance for
direct Lightning or configured swap routes. Provider routes are suggestions,
not payment guarantees. The payer chooses and uses third-party services under
those services' terms.

Browser, mobile, and static frontend code never receive the merchant's
receive-only NWC code. A live checkout always needs a backend controlled by the
merchant application.

## Documentation

Start with the [developer guides](docs/guides/README.md):

- [Node quickstart](docs/guides/quickstart-node.md)
- [Rails quickstart](docs/guides/quickstart-rails.md)
- [Frontend checkout](docs/guides/frontend-checkout.md)
- [Price feeds](docs/guides/price-feeds.md)
- [Automated swaps](docs/guides/automated-swaps.md)
- [Authorization](docs/guides/authorization.md)
- [Normative HTTP contract](spec/openapi/openreceive-http.v1.yaml)
- [Contributor and operator docs](docs/internal/README.md)
