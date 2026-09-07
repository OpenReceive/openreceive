# Testkit contract

The fake wallet and fake swap provider exist once per engine, and one
Playwright suite (`tests/e2e`) drives every Buy a Button stack through them.
The suite asserts fixed strings — a payment hash that is the mint counter in
64 hex characters, one Tron deposit address, `testkit-swap-N` — and knows
nothing about the language behind the stack it is pointed at. Drift in a port
does not fail loudly; it fails as a one-stack E2E mystery. This page is the
contract every port is held to, written down once instead of implied by the
implementations.

Implementations today:

| Engine | Fake wallet | Fake swap provider | Fixtures pinned by |
| --- | --- | --- | --- |
| JS (the original) | `packages/js/testkit/src/index.ts` (`TestkitReceiveClient`) | `packages/js/testkit/src/swap-provider.ts` (`TestkitSwapProvider`) | the JS suite under `tests/` |
| Ruby (Rails demo) | `examples/buttons/server/rails/lib/button_shop/testkit/wallet.rb` | `…/testkit/swap_provider.rb` | `examples/buttons/server/rails/test/lib/testkit_test.rb` |
| C# (BTCPay docker stack) | `packages/dotnet/OpenReceive.TestkitNwc` — a real NWC wallet service over a relay, same fixtures | `packages/dotnet/OpenReceive.FakeLsc` | its xunit tests |

A new engine ships both fakes in its own test-support module (`Testing\` in
PHP, `openreceive.testing` in Python), not only inside a demo, so hosts can
test their hooks without a wallet — [host testing](../guides/host-testing.md)
is the integrator-facing side of the same fakes. Every port adds a fixture
test equivalent to the Rails one, asserting the values below verbatim.

## The wallet

Implements the engine's receive-only client interface (`preflight`,
`make_invoice`, `list_transactions`, `subscribe_notifications`).

**Capability summary** (what `preflight` / `get_info` reports):

| Field | Value |
| --- | --- |
| wallet pubkey | `f` × 64 |
| relays | `wss://relay.test.openreceive.local` |
| methods | `make_invoice`, `list_transactions` — receive only, never a spend method |
| encryption | `nip04` |
| spend capability advertised | false |
| receive checkout ready | true |

**Minting.** A counter starts at 0 and increments per `make_invoice`. For mint
number N:

| Field | Value |
| --- | --- |
| `payment_hash` | N in lowercase hex, left-padded with `0` to 64 characters (`000…001`) |
| `invoice` | `lnbcopenreceive` + N zero-padded to 6 digits (`lnbcopenreceive000001`) — never decoded; any consumer treats it as opaque |
| `amount_msats` | the requested amount, validated against the shared min/max (`OPENRECEIVE_MIN_AMOUNT_MSATS`, `OPENRECEIVE_MAX_AMOUNT_MSATS`) and the metadata byte cap |
| `created_at` | the clock (real clock by default — a fixed low clock would put every invoice past expiry plus grace and let a reconcile pass close attempts a test still considers pending; tests that need determinism inject a clock) |
| `expires_at` | `created_at` + the requested `expiry`, honoured EXACTLY (default 600 s); the swap path rejects a deviation over 60 s because the shadow invoice must outlive the provider order |
| state | `pending` |

**History.** `list_transactions` returns only settled incoming invoices unless
`unpaid` is set; a pending invoice is absent. It honours `from`, `until`,
`limit`, `offset` and `type` (`outgoing` → empty), sorted newest first, ties
broken by payment hash descending. Rows carry `type: incoming`,
`payment_hash`, `invoice`, `amount_msats`, `created_at`, `expires_at`,
`state` (and the engine's `transaction_state` alias where the wire uses it),
`settled_at` when settled, and `preimage` when settled.

**Controls** (test-facing, not part of the client interface):

- `settle_invoice(selector, settled_at?, preimage?, notify?)` — marks settled
  with `settled_at` = the clock and `preimage` = `1` × 64 unless given; with
  `notify` it also emits an NWC-02 `payment_received` notification carrying
  the transaction, exactly as a real wallet would.
- `expire_invoice(selector)`, `fail_invoice(selector)` — set the state.
- `script_transaction_sequence(selector, steps)` — each subsequent history
  read of that invoice yields the next step (a state change, a literal
  transaction, or a thrown error), then falls back to the stored state.
- `list_invoices()` — every stored invoice, for the `/__testkit/state` debug view.
- Selectors are `{ payment_hash }` or `{ invoice }`; an unknown selector is an error.
- Notifications: `subscribe_notifications(handler)` registers; `emit_notification`
  delivers only `payment_received` and never lets a throwing handler break
  the subscription.

## The swap provider

Implements the engine's swap-provider interface with name `fixedfloat`
(configurable) and the full pay-in asset catalog from the kernel tables.

| Field | Value |
| --- | --- |
| catalog rows | every pay-in asset, `available: true`, `minimum_pay_amount: "1"`, `maximum_pay_amount: "5000"` |
| quote | `pay_amount` `"1.05"` (per-asset override allowed), same limits, `available: true` |
| `provider_order_id` | `testkit-swap-N`, N = create-call counter |
| `provider_token` | `testkit-token-N` |
| `deposit_address` | by NETWORK, not ticker: Tron `T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb`, Solana `So11111111111111111111111111111111111111112`, Ethereum `0x1111111111111111111111111111111111111111` |
| `deposit_amount` | `"1.05"` |
| `expires_at` | clock + 900 s (deposit window) |
| shadow-invoice expiry the provider requests | 1800 s |
| initial `state` | `awaiting_deposit` |

**Scripting.** `script(selector, states)` queues states; each `get_status`
poll advances one step and then holds on the last. Scripting an asset before
any attempt exists arms the next attempt created for that asset.
`force_refund_required(selector)` and `force_attention(selector, reason =
provider_reported_emergency)` apply IMMEDIATELY (no poll delay — a forced
state is what a test jumps to) and likewise arm future attempts for an asset
selector. `force_create_error(error?)` makes the next create fail once.
`request_refund(order, address)` records `{ provider_order_id, refund_address }`
and moves the order to `refund_pending`.

**Derived fields** when a state is applied: `deposit_tx_id` =
`testkit-deposit-tx` from `confirming` onward through the progress order
(`creating_provider_order` → `awaiting_deposit` → `confirming` →
`exchanging` → `paying_invoice` → `completed`); `payout_tx_id` =
`testkit-payout-tx` at `completed`; `refund_tx_id` = `testkit-refund-tx` at
`refunded`; `attention: true` (plus `attention_reason`) at `attention`.

**Counters** exposed for the debug view: `create_calls`, `quote_calls`,
`status_calls`, `refund_calls` (the recorded refund requests).

Selectors are an asset string, or `{ pay_in_asset?, provider_order_id? }`;
the provider has no notion of the host's reference.

## The static price

Testkit mode prices with the engine's `StaticPriceProvider`: BTC/USD
`50000.00`. Every stack's E2E asserts that a $1.00 button is 2,000 sats; it is
the one fixture shared across languages and price code.

## The `__testkit` control routes

A demo booted with `DEMO_WALLET=testkit` replaces three things — the wallet,
the swap provider, and the price feed — with the fakes above, and mounts this
surface under `/__testkit`. In every other mode the whole prefix answers a
JSON 404 (never an SPA fallback), which is how a probe proves it is off. It
skips CSRF (curl must be able to drive it) and must never touch the demo's
own tables (settling an invoice is a wallet event, not a visitor).

| Route | Body | Effect | Response |
| --- | --- | --- | --- |
| `POST /__testkit/settle` | `{ payment_hash }` | `settle_invoice` with `notify: true` | `200 { ok: true, transaction }`; unknown hash → `404` |
| `POST /__testkit/expire` | `{ payment_hash }` | `expire_invoice` | `200 { ok: true, transaction }`; unknown hash → `404` |
| `POST /__testkit/swap-step` | `{ provider_order_id?, pay_in_asset?, state, attention_reason? }` | `refund_required` → `force_refund_required`; `attention` → `force_attention`; any other state → `script(selector, [state])` | `200 { ok: true, state }`; missing selector or unknown state → `400` |
| `GET /__testkit/state` | – | debug aid | `200 { wallet: { invoices }, swap: { create_calls, quote_calls, status_calls, refund_calls } }` |

Error bodies use the demo's `{ error: { status, message } }` shape (Node
`errorBody`; Rails `ButtonShop::Testkit.control`). Reference implementations:
`examples/buttons/shared/server-node/testkit-controls.ts` (framework-free
`testkitControl`, plus the Express/Fastify adapters) and
`examples/buttons/server/rails/app/controllers/testkit_controller.rb`.

With this surface in place, `OPENRECEIVE_E2E_STACK=<demo key>` reuses
`tests/e2e` unchanged against a new stack — that is the whole point of
porting the fixtures rather than inventing new ones.

## Adding an engine

1. Port both fakes into the engine's test-support module with the values above.
2. Write the fixture test (copy `testkit_test.rb`'s assertions).
3. Wire `DEMO_WALLET=testkit` in the demo: fakes + static price + the four
   control routes, 404 otherwise.
4. Add the demo key to the E2E stack switch and run the smoke spec.
