# Testing your OpenReceive integration

This page shows how to test your integration without touching a real wallet
or a swap provider. Your integration here means your `amountFor`,
`authorize`, and `onPaid` wiring.

## Inject a fake wallet client

Pass a pre-built client to `createOpenReceive` through the `client` option.
When you do, it skips NWC entirely:

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

Any object that implements `ReceiveNwcClient` works. Have `makeInvoice`
return predictable invoices, and have `listTransactions` report settlement.
Your whole integration then runs the production code against it. That
includes the HTTP routes, persistence, reconcile, and `onPaid`.

With the fake above, `settledAt.set(checkout.paymentHash,
Math.floor(Date.now() / 1000))` marks an attempt paid. The next
`/payments/check` poll or reconcile pass settles it through the production
rules. Settlement follows the real rule. A transaction settles only on a
finality signal: `settled_at`, a settled state, or a settled/paid boolean. It
never settles just because a preimage is present.

For fiat pricing without a network, pass
`priceProviders: [new StaticPriceProvider()]` (from `@openreceive/core`).
There is no automatic static fallback, on purpose. A wallet client must
refuse to price invoices rather than silently quote a hard-coded rate. So
tests have to opt in explicitly.

## Inject a fake wallet client (Rails)

The Rails engine lets you swap in the same fakes from an initializer:

- `config.nwc_client` skips NWC entirely.
- `config.swap_providers` replaces the FixedFloat-compatible providers built
  from `LSC_URI_*`.
- `OpenReceive::Rates::StaticPriceProvider` prices without a network.

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

Both objects are DUCK-TYPED. They only need the right methods, so there is
no base class to inherit:

- The wallet answers `make_invoice(request)` and `list_transactions(request)`
  with string-keyed hashes. It also needs one info method (`preflight`,
  `get_info`, …) that advertises at least `make_invoice` and
  `list_transactions`. It must be receive-only, because the service refuses a
  wallet that can spend unless you override it. Settlement is read from
  `list_transactions`, on a finality signal, exactly as in production.
- The swap provider answers `name`, `supported_pay_in_assets`,
  `pay_in_asset_catalog`, `invoice_expiry_seconds`, `quote`, `create_swap`,
  `get_status` and `request_refund`. `invoice_expiry_seconds` is a FLOOR, a
  minimum the service passes to `make_invoice`. The shadow invoice has to
  outlive the provider order. So a fake wallet that shortens the expiry fails
  every swap.

You can see a working pair in
[`examples/buttons/server/rails/lib/button_shop/testkit/`](../../examples/buttons/server/rails/lib/button_shop/testkit).

## Inject a fake wallet client (Python)

The Python engine ships its own fakes in `openreceive.testing`:

- `FakeWallet` and `FakeSwapProvider` follow the shared testkit contract. They
  use the same fixtures as the Node testkit and the Rails demo. A payment hash
  is the mint counter written as 64 hex characters. Invoices look like
  `lnbcopenreceive000001`.
- `StaticPriceProvider` prices BTC/USD at `50000.00`.

The FastAPI router takes them through keyword arguments that production code
never sets:

```python
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from openreceive.fastapi import openreceive_lifespan, openreceive_router
from openreceive.storage.sql import SqlPaymentRepository
from openreceive.testing import FakeSwapProvider, FakeWallet, StaticPriceProvider

wallet = FakeWallet()
engine = create_engine("sqlite:///test.sqlite3")
SqlPaymentRepository(engine).create_tables()          # the two tables, test-only shortcut
router = openreceive_router(
    host,                                             # your amount_for / authorize / on_paid, unchanged
    engine=engine,
    nwc_client=wallet,
    price_provider=StaticPriceProvider(),
    swap_providers=[FakeSwapProvider()],
)
app = FastAPI(lifespan=openreceive_lifespan(host, engine=engine))
app.include_router(router, prefix="/openreceive")

with TestClient(app) as client:
    created = client.post("/openreceive/checkouts", json={"reference": order.id})
    payment_hash = created.json()["checkout"]["payment_hash"]
    wallet.settle_invoice(payment_hash)               # or expire_invoice / fail_invoice
    # The next poll past the 2-second gate floor runs the reconcile pass and
    # your on_paid — through the production settlement rules.
    client.post("/openreceive/payments/check", json={"reference": order.id, "payment_hash": payment_hash})
```

- `wallet.settle_invoice(hash, notify=True)` also sends the NWC-02
  `payment_received` notification, for testing the notifications worker.
- `FakeSwapProvider.script(selector, states)`, `force_refund_required` and
  `force_attention` move the swap through its states.
- Django apps inject the same objects through `OPENRECEIVE["SERVICE"]`. That
  setting is a callable that returns a `Service` built on the fakes.

The [testkit contract](../internal/testkit-contract.md) fixes every fixture
value.

## Inject a fake wallet client (PHP)

The PHP engine ships its fakes in `OpenReceive\Testing`:

- `FakeWallet` and `FakeSwapProvider` follow the shared testkit contract. They
  use the same fixtures as the Node testkit, the Rails demo and the Python
  fakes. A payment hash is the mint counter written as 64 hex characters.
  Invoices look like `lnbcopenreceive000001`. There is one Tron deposit
  address, and swap orders are `testkit-swap-N`.
- `OpenReceive\Rates\StaticPriceProvider` prices BTC/USD at `50000.00`.

Pass them to the `Service` constructor. In production you call
`Service::fromEnvironment()` instead. Everything after the `Service` is
identical:

```php
use OpenReceive\Rates\StaticPriceProvider;
use OpenReceive\Server\Engine;
use OpenReceive\Server\Service;
use OpenReceive\Storage\{PaymentsSchema, PdoConnection, SqlPaymentRepository};
use OpenReceive\Testing\{FakeSwapProvider, FakeWallet};

$wallet = new FakeWallet();
$db = new PdoConnection(new PDO('sqlite::memory:'));
PaymentsSchema::migrate($db);                       // the two tables, test-only shortcut
$service = new Service($wallet, new StaticPriceProvider(), [new FakeSwapProvider()]);
$engine = new Engine($host, new SqlPaymentRepository($db), $service);   // your Host, unchanged
$handler = $engine->psr15Handler();

$created = $handler->handle($request('POST', '/openreceive/checkouts', ['reference' => $order->id]));
$hash = json_decode((string) $created->getBody(), true)['checkout']['payment_hash'];
$wallet->settleInvoice($hash);                      // or expireInvoice / failInvoice
// The next poll past the 2-second gate floor runs the reconcile pass and your
// onPaid — through the production settlement rules.
$handler->handle($request('POST', '/openreceive/payments/check', ['reference' => $order->id, 'payment_hash' => $hash]));
```

- `$wallet->settleInvoice($hash, notify: true)` also sends the NWC-02
  `payment_received` notification, for testing `Notifications`.
- `FakeSwapProvider::script($selector, $states)`, `forceRefundRequired()` and
  `forceAttention()` move the swap through its states.
- `scriptTransactionSequence()` makes the wallet's history reads misbehave on
  purpose.
- Inject a clock into either fake when a test needs to pass the
  expiry-plus-grace point.

One thing is specific to PHP. The fakes live in process memory, and each PHP
request IS a separate process. So a demo that drives the fakes over several
HTTP requests has to save their state between requests.
`examples/buttons/server/php-plain/src/Testkit.php` does this with a
serialised snapshot under a lock. A PHPUnit test runs the whole scenario in
one process, so it needs nothing like this.

## Click through a full checkout with no wallet

Set `DEMO_WALLET=testkit` and every stack of the Buy a Button demo boots
against in-process fakes. You need no `NWC_URI`, no LSC keys, and no network:

```sh
DEMO_WALLET=testkit npm run dev   # in examples/buttons/server/node-express
DEMO_WALLET=testkit bin/dev       # in examples/buttons/server/rails
DEMO_WALLET=testkit npm run dev   # in examples/buttons/server/fastapi (Vite + uvicorn)
DEMO_WALLET=testkit npm run dev   # in examples/buttons/server/php-plain (Vite + php -S)
```

Everything works: the shop, the checkout wizard (all four framework tabs),
Lightning invoices, and swap flows. That includes a swap that reaches
`refund_required` and a refund submitted through the real engine routes.

Test-only endpoints under `/__testkit` let you settle or expire invoices and
advance swap states from `curl` or a browser console. They are locked away
outside testkit mode:

- The prefix always returns 404 in every other mode.
- The compose files never set `DEMO_WALLET`.
- The client-bundle scanner proves no testkit code ships.

See [examples/README.md](../../examples/README.md) for the endpoint list.

The Rails fakes are a port of the JS ones with identical fixtures: the same
payment hashes, the same `testkit-swap-N` order ids, the same deposit
addresses, and BTC at a static $50,000. So one browser harness drives either
language. If you run both, copy this approach. A fake that meets the contract
but disagrees with its twin needs a second harness. The second harness is
where the two stacks drift apart.

For your own tests, rely on these stable hooks:

- Node: the `client` option and `StaticPriceProvider`.
- Rails: `config.nwc_client` / `config.swap_providers` /
  `OpenReceive::Rates::StaticPriceProvider`.
