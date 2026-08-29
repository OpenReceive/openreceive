# Testing your OpenReceive integration

How to test your integration — your `amountFor`, `authorize`, and `onPaid`
wiring — without touching a real wallet or a swap
provider.

## Inject a fake wallet client

`createOpenReceive` accepts a pre-built client via the `client` option and
skips NWC entirely when one is supplied:

```ts
import { createOpenReceive } from "@openreceive/node";
import type { ReceiveNwcClient } from "@openreceive/node";
import { StaticPriceProvider } from "@openreceive/core";

// Settle an invoice from a test by putting its payment hash in here.
const settledAt = new Map<string, number>();

let minted = 0;
const myFakeClient: ReceiveNwcClient = {
  async preflight() {
    return {
      walletPubkey: "f".repeat(64),
      relays: [],
      methods: ["make_invoice", "list_transactions"],
      encryption: undefined,
      spendCapabilityAdvertised: false,
      receiveCheckoutReady: true,
      warnings: [],
    };
  },
  async makeInvoice({ amount_msats, expiry }) {
    const payment_hash = String(++minted).padStart(64, "0");
    const created_at = Math.floor(Date.now() / 1000);
    return {
      invoice: `lnbcfake${payment_hash}`, // never decoded; any string works
      payment_hash,
      amount_msats,
      created_at,
      // Honor the requested expiry: creation rejects an invoice whose real
      // payable window deviates from the request by more than 60 seconds.
      expires_at: created_at + (expiry ?? 600),
    };
  },
  async listTransactions() {
    return {
      transactions: [...settledAt].map(([payment_hash, settled_at]) => ({
        type: "incoming" as const,
        payment_hash,
        settled_at,
      })),
    };
  },
};

const service = await createOpenReceive({
  client: myFakeClient,
  priceProviders: [new StaticPriceProvider()],
});
```

Any object implementing `ReceiveNwcClient` works: mint
deterministic invoices from `makeInvoice`, report settlement from
`listTransactions`, and your whole integration — HTTP routes,
persistence, reconcile, `onPaid` — runs the production code paths against it.
With the fake above, `settledAt.set(checkout.paymentHash,
Math.floor(Date.now() / 1000))` marks an attempt paid; the next
`/payments/check` poll or reconcile pass settles it through the production
rules. Settlement follows the real rule: a transaction settles on a finality
signal (`settled_at`, a settled state, or a settled/paid boolean), never on
the mere presence of a preimage.

For fiat pricing without a network, pass
`priceProviders: [new StaticPriceProvider()]` (from `@openreceive/core`).
There is deliberately no implicit static fallback: a wallet client must refuse to
price invoices rather than silently quote a hard-coded rate, so tests opt in
explicitly.

## Inject a fake wallet client (Rails)

The engine takes the same seams from a Rails initializer. `config.nwc_client`
skips NWC entirely, `config.swap_providers` replaces the FixedFloat-compatible
providers built from `LSC_URI_*`, and `OpenReceive::Rates::StaticPriceProvider`
prices without a network:

```ruby
OpenReceive.configure do |config|
  if ENV["DEMO_WALLET"] == "testkit"
    config.nwc_client = MyFakeWallet.new
    config.swap_providers = [MyFakeSwapProvider.new]
    config.price_provider = OpenReceive::Rates::StaticPriceProvider.new
  end
  # amount_for, authorize and on_paid stay exactly as they are in production.
end
```

Both objects are DUCK-TYPED, so there is no base class to inherit:

- The wallet answers `make_invoice(request)` and `list_transactions(request)`
  with string-keyed hashes, plus one info method (`preflight`, `get_info`, …)
  advertising at least `make_invoice` and `list_transactions` — receive-only,
  because the service refuses a spend-capable wallet unless you override it.
  Settlement is read from `list_transactions`, on a finality signal, exactly as
  in production.
- The swap provider answers `name`, `supported_pay_in_assets`,
  `pay_in_asset_catalog`, `invoice_expiry_seconds`, `quote`, `create_swap`,
  `get_status` and `request_refund`. `invoice_expiry_seconds` is a FLOOR the
  service passes to `make_invoice`: the shadow invoice has to outlive the
  provider order, so a fake wallet that clamps expiry fails every swap.

A worked pair is
[`examples/buttons/server/rails/lib/button_shop/testkit/`](../../examples/buttons/server/rails/lib/button_shop/testkit).

## Click through a full checkout with no wallet

Every stack of the Buy a Button demo boots against in-process fakes when
`DEMO_WALLET=testkit` is set — no `NWC_URI`, no LSC keys, no network:

```sh
DEMO_WALLET=testkit npm run dev   # in examples/buttons/server/node-express
DEMO_WALLET=testkit bin/dev       # in examples/buttons/server/rails
```

The shop, the checkout wizard (all four framework tabs), Lightning invoices,
and swap flows all work — including a swap that reaches `refund_required` and a
refund submitted through the real engine routes. A test-only control surface
under `/__testkit` lets you settle or expire invoices and advance swap states
from `curl` or a browser console. The prefix hard-404s in every other mode, the
compose files never set `DEMO_WALLET`, and the client-bundle scanner proves no
testkit code ships — see
[examples/README.md](../../examples/README.md) for the endpoint list.

The Rails fakes are a port of the JS ones with identical fixtures — the same
payment hashes, the same `testkit-swap-N` order ids, the same deposit
addresses, BTC at a static $50,000 — so one browser harness drives either
language. That is worth copying if you run both: a fake that satisfies the
contract but disagrees with its twin needs a second harness, and the second
harness is where the two stacks drift apart.

The stable seams for your own tests are the `client` option and
`StaticPriceProvider` in Node, and `config.nwc_client` /
`config.swap_providers` / `OpenReceive::Rates::StaticPriceProvider` in Rails.
