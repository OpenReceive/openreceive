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
  orders, payment-attempt rows, and fulfillment. OpenReceive's runtime accepts
  no database/Redis connection or storage adapter.

## The host contract

Keep the order model unchanged. Add one host-owned table to the application's
existing database:

```text
openreceive_payments
  order_id      required, indexed; many attempts may belong to one order
  payment_hash  required, unique
  paid_at       nullable timestamp
  expires_at    required timestamp
  checkout_data required safe JSON snapshot
  swap_data     nullable JSON/text, server-only
```

Each row represents one invoice or swap attempt. `swap_data` holds the provider
credential needed to inspect that attempt and must never reach browser code or
logs.

The required sequence is:

1. Your app creates and prices its order.
2. OpenReceive creates a checkout for that exact amount.
3. Your app appends the payment row before returning the checkout to the payer.
4. OpenReceive verifies wallet settlement and calls `onPaid` at least once.
5. Your app finds the attempt by `payment_hash`, sets its `paid_at` once, and
   fulfills the order only for its first settled attempt.

The commit transaction locks the existing order row, allowing multiple
historical attempts but only one live attempt. Never display an invoice whose
hash the host did not commit.

## Direct Node API

```ts
import { createOpenReceive } from "@openreceive/node";

const openreceive = await createOpenReceive();

const liveAttempt = await payments.findLiveForOrder(order.id);
if (liveAttempt) return liveAttempt.checkout;

const checkout = await openreceive.createCheckout({
  orderId: order.id,
  amount: { currency: "USD", value: order.total.toString() },
});

await payments.commitAttemptWhileLockingOrder({ order, checkout });
return checkout;
```

`createOpenReceive()` reads the receive-only wallet connection from `NWC_URI`.
Optional swap connections come from `LSC_URI_PRIMARY` and `LSC_URI_BACKUP`.
These are the only OpenReceive secret environment variables.
The library does not load `.env` itself; the host entry point or deployment
platform supplies the environment. Pass `nwc` explicitly only for an
intentional runtime override, such as an isolated test.

`checkPayment({ paymentHash, createdAt })` verifies a known attempt with bounded
`list_transactions` scans. Mounted routes and the reconciler deliver settlement
through the host integration.
`reconcilePayments` batch-checks unresolved payment rows.
`startOpenReceiveReconciler` reloads unresolved host rows on every pass and
delivers verified settlements at least once.

## Ship the routes, keep your auth

Browser integrations mount `@openreceive/http` through Express, Fastify, Next,
or Rails. OpenReceive never inspects the host session. The generated `host`
integration resolves authoritative prices, selects committed attempts, and
persists new ones; your application supplies authorization.

A create request supplies an order ID, never its own price. The host resolves
the authoritative amount from its order:

```ts
import { createOpenReceiveHost } from "@openreceive/http";

const host = createOpenReceiveHost({
  loadOrder: (orderId) => orders.find(orderId),
  amountForOrder: (order) => ({
    currency: order.currency,
    value: order.total.toString(),
  }),
  payments: paymentRepository,
  onPaid: ({ paymentHash, paidAt }) =>
    paymentRepository.markPaidOnceAndFulfillFirst(paymentHash, paidAt),
});

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

  host,
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
that the merchant wallet was paid. The payment attempt's server-only `swap_data`
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

Each command creates a root `.env` from `.env.example` if missing, validates
`NWC_URI`, and runs that demo's Docker Compose stack. Set a valid receive-only
NWC URI from a compatible wallet before checkout creation. Optional automated
swaps use `LSC_URI_PRIMARY` and `LSC_URI_BACKUP`; provider
credentials never reach the browser.

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
- [Lightning Swap Connect](docs/guides/lightning-swap-connect.md)
- [Authorization](docs/guides/authorization.md)
- [Normative HTTP contract](spec/openapi/openreceive-http.v1.yaml)
- [Contributor and operator docs](docs/internal/README.md)
