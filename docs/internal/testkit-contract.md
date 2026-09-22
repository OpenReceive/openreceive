# Testkit contract

Each engine has one fake wallet and one fake swap provider. One Playwright suite
(`tests/e2e`) drives every Buy a Button stack through them. The suite asserts
fixed strings: a payment hash that is the mint counter in 64 hex characters, one
Tron deposit address, and `testkit-swap-N`. It knows nothing about the language
behind the stack it tests. So when a port drifts, nothing fails loudly. Instead
one stack's E2E fails in a confusing way. This page writes down the contract every
port must follow, so the implementations do not have to imply it.

Implementations today:

| Engine | Fake wallet | Fake swap provider | Fixtures pinned by |
| --- | --- | --- | --- |
| JS (the original) | `packages/js/testkit/src/index.ts` (`TestkitReceiveClient`) | `packages/js/testkit/src/swap-provider.ts` (`TestkitSwapProvider`) | the JS suite under `tests/` |
| Ruby (Rails demo) | `examples/buttons/server/rails/lib/button_shop/testkit/wallet.rb` | `…/testkit/swap_provider.rb` | `examples/buttons/server/rails/test/lib/testkit_test.rb` |
| C# (BTCPay docker stack) | `packages/dotnet/OpenReceive.TestkitNwc`: a real NWC wallet service over a relay, with the same fixtures | `packages/dotnet/OpenReceive.FakeLsc` | its xunit tests |

A new engine ships both fakes in its own test-support module (`Testing\` in
PHP, `openreceive.testing` in Python), not only inside a demo. That way hosts
can test their hooks without a wallet. [Host testing](../guides/host-testing.md)
is the integrator-facing side of the same fakes. Every port adds a fixture test
like the Rails one, which asserts the values below exactly.

## The wallet

The fake wallet implements the engine's receive-only client interface (`preflight`,
`make_invoice`, `list_transactions`, `subscribe_notifications`).

**Capability summary** (what `preflight` / `get_info` reports):

| Field | Value |
| --- | --- |
| wallet pubkey | `f` × 64 |
| relays | `wss://relay.test.openreceive.local` |
| methods | `make_invoice`, `list_transactions`. Receive only, never a spend method |
| encryption | `nip04` |
| spend capability advertised | false |
| receive checkout ready | true |

**Minting.** A counter starts at 0 and goes up by one on each `make_invoice`. For mint
number N:

| Field | Value |
| --- | --- |
| `payment_hash` | N in lowercase hex, left-padded with `0` to 64 characters (`000…001`) |
| `invoice` | `lnbcopenreceive` + N zero-padded to 6 digits (`lnbcopenreceive000001`). Never decoded. Every consumer treats it as opaque |
| `amount_msats` | the requested amount, checked against the shared min/max (`OPENRECEIVE_MIN_AMOUNT_MSATS`, `OPENRECEIVE_MAX_AMOUNT_MSATS`) and the metadata byte cap |
| `created_at` | the clock. The real clock is the default. A fixed low clock would put every invoice past expiry plus grace, and a reconcile pass would then close attempts that a test still expects to be pending. Tests that need determinism inject a clock |
| `expires_at` | `created_at` + the requested `expiry`, honoured EXACTLY (default 600 s). The swap path rejects a deviation over 60 s, because the shadow invoice must outlive the provider order |
| state | `pending` |

**History.** `list_transactions` returns only settled incoming invoices, unless
`unpaid` is set. A pending invoice does not appear. It honours `from`, `until`,
`limit`, `offset` and `type` (`outgoing` returns empty). Rows are sorted newest
first, and ties are broken by payment hash descending. Each row carries:

- `type: incoming`
- `payment_hash`, `invoice`, `amount_msats`, `created_at`, `expires_at`
- `state`, plus the engine's `transaction_state` alias where the wire uses it
- `settled_at` and `preimage`, when settled

**Controls.** These are for tests and are not part of the client interface.

- `settle_invoice(selector, settled_at?, preimage?, notify?)` marks the invoice
  settled. `settled_at` defaults to the clock and `preimage` to `1` × 64. With
  `notify`, it also emits an NWC-02 `payment_received` notification carrying
  the transaction, exactly as a real wallet would.
- `expire_invoice(selector)` and `fail_invoice(selector)` set the state.
- `script_transaction_sequence(selector, steps)`: each later history read of
  that invoice returns the next step (a state change, a literal transaction, or
  a thrown error). After the last step, reads fall back to the stored state.
- `list_invoices()` returns every stored invoice, for the `/__testkit/state` debug view.
- Selectors are `{ payment_hash }` or `{ invoice }`. An unknown selector is an error.
- Notifications: `subscribe_notifications(handler)` registers a handler.
  `emit_notification` delivers only `payment_received`, and a handler that throws
  never breaks the subscription.

## The swap provider

The fake provider implements the engine's swap-provider interface. Its name is
`fixedfloat` (configurable), and it offers the full pay-in asset catalog from the
kernel tables.

| Field | Value |
| --- | --- |
| catalog rows | every pay-in asset, `available: true`, `minimum_pay_amount: "1"`, `maximum_pay_amount: "5000"` |
| quote | `pay_amount` `"1.05"` (a per-asset override is allowed), same limits, `available: true` |
| `provider_order_id` | `testkit-swap-N`, where N is the create-call counter |
| `provider_token` | `testkit-token-N` |
| `deposit_address` | chosen by NETWORK, not ticker: Tron `T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb`, Solana `So11111111111111111111111111111111111111112`, Ethereum `0x1111111111111111111111111111111111111111` |
| `deposit_amount` | `"1.05"` |
| `expires_at` | clock + 900 s (deposit window) |
| shadow-invoice expiry the provider requests | 1800 s |
| initial `state` | `awaiting_deposit` |

**Scripting.**

- `script(selector, states)` queues states. Each `get_status` poll advances one
  step, then stays on the last one.
- If you script an asset before any attempt exists, the script applies to the
  next attempt created for that asset.
- `force_refund_required(selector)` and `force_attention(selector, reason =
  provider_reported_emergency)` apply IMMEDIATELY, with no poll delay, because a
  forced state is one a test wants to jump to. With an asset selector they also
  apply to future attempts.
- `force_create_error(error?)` makes the next create fail once.
- `request_refund(order, address)` records `{ provider_order_id, refund_address }`
  and moves the order to `refund_pending`.

**Derived fields.** When a state is applied, the provider also sets:

- `deposit_tx_id` = `testkit-deposit-tx` from `confirming` onward, following the
  progress order `creating_provider_order` → `awaiting_deposit` → `confirming` →
  `exchanging` → `paying_invoice` → `completed`.
- `payout_tx_id` = `testkit-payout-tx` at `completed`.
- `refund_tx_id` = `testkit-refund-tx` at `refunded`.
- `attention: true`, plus `attention_reason`, at `attention`.

**Counters** for the debug view: `create_calls`, `quote_calls`,
`status_calls`, and `refund_calls` (the recorded refund requests).

Selectors are an asset string, or `{ pay_in_asset?, provider_order_id? }`.
The provider knows nothing about the host's reference.

## The static price

In testkit mode the engine's `StaticPriceProvider` sets prices: BTC/USD
`50000.00`. Every stack's E2E asserts that a $1.00 button costs 2,000 sats. This
is the one fixture shared across all languages and all price code.

## The `__testkit` control routes

A demo started with `DEMO_WALLET=testkit` swaps three things for the fakes above:
the wallet, the swap provider and the price feed. It also mounts this surface
under `/__testkit`. In every other mode, the whole prefix answers with a JSON 404,
never an SPA fallback. That is how a probe proves the surface is off.

The routes skip CSRF, because curl must be able to drive them. They must never
touch the demo's own tables. Settling an invoice is a wallet event, not a visitor action.

| Route | Body | Effect | Response |
| --- | --- | --- | --- |
| `POST /__testkit/settle` | `{ payment_hash }` | `settle_invoice` with `notify: true` | `200 { ok: true, transaction }`; unknown hash → `404` |
| `POST /__testkit/expire` | `{ payment_hash }` | `expire_invoice` | `200 { ok: true, transaction }`; unknown hash → `404` |
| `POST /__testkit/swap-step` | `{ provider_order_id?, pay_in_asset?, state, attention_reason? }` | `refund_required` → `force_refund_required`; `attention` → `force_attention`; any other state → `script(selector, [state])` | `200 { ok: true, state }`; missing selector or unknown state → `400` |
| `GET /__testkit/state` | – | debug aid | `200 { wallet: { invoices }, swap: { create_calls, quote_calls, status_calls, refund_calls } }` |

Error bodies use the demo's `{ error: { status, message } }` shape (Node
`errorBody`; Rails `ButtonShop::Testkit.control`). Reference implementations:

- `examples/buttons/shared/server-node/testkit-controls.ts`: the framework-free
  `testkitControl`, plus the Express/Fastify adapters.
- `examples/buttons/server/rails/app/controllers/testkit_controller.rb`.

Once a stack has this surface, `OPENRECEIVE_E2E_STACK=<demo key>` runs
`tests/e2e` unchanged against it. That is why we port the fixtures instead of
inventing new ones.

## Adding an engine

1. Port both fakes into the engine's test-support module with the values above.
2. Write the fixture test (copy `testkit_test.rb`'s assertions).
3. Wire `DEMO_WALLET=testkit` in the demo: the fakes, the static price and the four
   control routes, with a 404 otherwise.
4. Add the demo key to the E2E stack switch and run the smoke spec.
