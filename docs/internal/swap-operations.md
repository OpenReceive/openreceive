# Swap Operations

Operator and contributor runbook for automated swaps. Integrators start with
[`docs/guides/automated-swaps.md`](../guides/automated-swaps.md) (provider YAML +
mount). This page covers weight budgets, the full state catalog, attention
reasons, audit events, offline testing, and registering providers from code.

## Provider selection and expiry

`providers` order in `openreceive.yml` is priority order. `id` must be unique and
becomes the public `swap.provider` value. Quote and start try the first provider
that supports the pay-in asset; if that provider's shared weight budget is
exhausted (or in backoff after a 429), selection fails over to the next entry
that still supports the asset. Each provider has its own durable ledger
(`swap_provider_weight:<id>`) assuming FixedFloat-compatible limits (250
weight/min, `/create` = 50). Status and refund for an existing attempt stay
pinned to the provider that created it.

`invoice_expiry_seconds` is optional. It auto-derives from
`deposit_window_seconds + settlement_sla_seconds + invoice_expiry_margin_seconds`
(default `600 + 900 + 300 = 1800`). The margin is sized so the shadow Lightning
invoice outlives plausible FixedFloat deposit windows. Set
`invoice_expiry_seconds` only to lengthen the window; a value below that floor is
rejected at startup. After `/create`, if the provider order still expires after
the shadow invoice, the attempt is marked `attention`
(`provider_order_expires_after_shadow_invoice`) rather than racing a dead bolt11
at payout time.

At startup OpenReceive logs a `swap.providers.resolved` event listing the
provider names it loaded (or noting that swaps are disabled).

## Full swap lifecycle

A swap attempt's `provider_state` is one of twelve values. Import the canonical
classifier from `@openreceive/node` instead of hardcoding a switch:

```ts
import { describeSwapState, OPENRECEIVE_SWAP_STATES } from "@openreceive/node";

const { label, detail, phase, terminal } = describeSwapState(attempt.providerState);
```

| `provider_state` (HTTP) / `providerState` (SDK) | phase | terminal | meaning for the payer |
| --- | --- | --- | --- |
| `creating_provider_order` | `preparing` | no | The deposit address is still being created. |
| `awaiting_deposit` | `awaiting_deposit` | no | Show the deposit address/amount; the payer must send funds. |
| `confirming` | `processing` | no | The deposit was detected and is confirming. |
| `exchanging` | `processing` | no | The provider is converting the payment. |
| `paying_invoice` | `processing` | no | The provider is paying the Lightning invoice. |
| `completed` | `settling` | no | Provider reports done — **not paid yet**. Render "Finalizing", never "Paid". |
| `expired` | `terminal` | yes | No deposit arrived before the window closed. |
| `refund_required` | `refund` | no | Collect a refund address. May include `refund_reason`, `deposit_received_amount`, and `refund_amount`. |
| `refund_pending` | `refund` | no | A refund has been requested from the provider. |
| `refunded` | `terminal` | yes | The provider reports the refund was sent. |
| `attention` | `attention` | yes | Needs operator review — see below. |
| `failed` | `terminal` | yes | This deposit address can no longer be used. |

```
swap_pay_options ─▶ start_swap ─▶ awaiting_deposit ─▶ confirming ─▶ exchanging
                                        │                              │
                                        ▼                              ▼
                                   (no deposit)                  paying_invoice
                                        │                              │
                                        ▼                              ▼
                                     expired                       completed
                                                                       │
                                          global wallet sweep sees a settled tx
                                                                       ▼
                                                              order marked paid
```

`completed` is deliberately non-terminal: provider completion is not payment.
OpenReceive only marks an order paid when the wallet sweep sees a settled
transaction. See [Architecture](architecture.md) § Settlement Authority.

## Attention runbook

When an attempt enters `attention`, automatic polling stops (it is terminal for
the background poller). The attempt exposes `attention_reason` so a dashboard or
on-call runbook can branch on the cause. For `provider_reported_emergency` only,
call `refreshSwap` / HTTP `refresh_swap` after acting in the FixedFloat dashboard
— do not auto-poll every attention record (that burns the shared API weight
budget).

| `attention_reason` | what happened | what to do |
| --- | --- | --- |
| `provider_completed_without_wallet_settlement` | Provider reported the Lightning payout as done, but no wallet settlement arrived within `settlement_attention_seconds`. | Reconcile against the wallet's `list_transactions` and the provider's payout tx. If the payout truly never landed, escalate to the provider with `payout_tx_id`. |
| `provider_order_creation_stale` | A reserved attempt never received a provider order id (create hung). No deposit address was ever shown, so no payer funds are at risk. | Safe to ignore; the payer can start a fresh attempt. |
| `provider_order_creation_failed` | The provider rejected order creation. `provider_error` records why. No deposit address was shown. | Safe to ignore for that attempt; check `provider_error` if it recurs across payers. |
| `provider_order_creation_needs_reconcile` | Create timed out or was interrupted after the request may have reached FixedFloat. FixedFloat has no client idempotency key, so a live order may exist without a stored token. | Reconcile in the FixedFloat dashboard before starting another attempt for this asset — OpenReceive blocks auto-mint of attempt N+1. |
| `provider_reported_emergency` | The provider flagged an emergency (e.g. overpayment or a manual exchange choice) that OpenReceive could not resolve automatically. | Act in the provider dashboard, then `refresh_swap` to pull the new state. |
| `provider_order_expires_after_shadow_invoice` | Provider order `expires_at` outlives the shadow bolt11 minted before `/create`. | Raise `invoice_expiry_seconds` / margin; do not expect LN payout on this attempt. |

Alert on `attention` and route each reason to the right response. Do not
auto-refund on `attention` — only `refund_required` carries a nonce and a safe
refund path.

## Testing swaps locally

`@openreceive/testkit` ships an in-memory, scriptable provider so you can build
and test the whole flow offline — no live FixedFloat keys, no real crypto:

```ts
import { createTestkitReceiveClient, createTestkitSwapProvider } from "@openreceive/testkit";

const swap = createTestkitSwapProvider();
const openreceive = await createOpenReceive({
  client: createTestkitReceiveClient(),
  swap: { providers: [swap] },
});

// Drive an attempt through its lifecycle; each getStatus poll advances one step:
swap.script("USDT_TRON", ["confirming", "exchanging", "paying_invoice", "completed"]);
// Or jump to an edge case:
swap.forceRefundRequired("USDT_TRON");
swap.forceAttention("USDT_TRON", "provider_completed_without_wallet_settlement");
swap.forceCreateError();
```

See also [Conformance](conformance.md) § Testkit.

## Audit events

Wire a `logger` (and optional file logging at `debug`) so you can follow each
attempt without scraping provider response blobs. Server events never include
`refund_nonce`, refund addresses, or provider tokens — only
`refund_nonce_present` / expiry timestamps.

| Event | Level | When |
| --- | --- | --- |
| `swap.created` | info | Provider order created |
| `swap.state.changed` | debug→warn | `provider_state` moved (poll, confirm, etc.) |
| `swap.attention.raised` | warn | Attention reason set |
| `swap.refund.submitted` | info/warn | Refund address staged (`confirm: false`) |
| `swap.refund.confirmed` | info | Provider `/emergency` REFUND accepted |
| `swap.refund.rejected` | warn | Stale nonce, address mismatch, wrong state, double-confirm, … |
| `swap.refund.rate_limited` | warn | >5 address submissions → 429 |
| `swap.refund.nonce_issued` | debug | Fresh nonce minted (stage or poll) |
| `swap.refund.provider_failed` | warn | Provider refund call failed; rolled back to `refund_required` |
| `swap.provider.request` / `.response` | info | Raw FixedFloat-compatible traffic (token redacted) |
| `invoice.settled` | info | Wallet sweep — settlement authority |

Browser (pass `logger` to checkout / elements):

| Event | When |
| --- | --- |
| `checkout.state.created` | Initial state |
| `checkout.state.refreshed` | Status poll (debug; includes swap audit fields) |
| `swap.state.changed` | `provider_state` / nonce / attention / wallet settlement flipped |
| `swap.start.*` / `swap.refund.*` | Start or refund HTTP request lifecycle |

Useful greps while live-testing:

```sh
# Underpay → refund path
rg 'swap\.(state\.changed|refund\.|attention\.raised)' logs/openreceive.log
# Finalizing vs Paid: provider completed without settled_at
rg 'provider_completed_without_wallet_settlement|invoice\.settled' logs/openreceive.log
# Abuse: stale nonce / mismatch / spam
rg 'swap\.refund\.(rejected|rate_limited)' logs/openreceive.log
```

Set `logging.level: debug` in `openreceive.yml` (or pass `logger` that keeps
debug) so `order.status.*`, `swap.refund.nonce_issued`, and poll transitions are
retained.

## Registering providers

YAML swap providers default to `protocol: fixedfloat` (the only supported
protocol today). Omit `id` to derive it from the `base_url` host
(`https://ff.io` → `ff-io`); set `id` only when you need a custom label or two
entries would otherwise collide.

To register a provider from code — a custom one, or a FixedFloat-compatible one
you build yourself — pass it to `createOpenReceive`. Programmatic providers
**merge** with the YAML providers (they no longer replace them): entries are
de-duplicated by `.name`, so a programmatic provider with the same id overrides
its YAML entry in place, and new ids are appended after the YAML providers in
priority order.

```ts
import { createOpenReceive, fixedFloatCompatibleSwapProvider } from "@openreceive/node";

const openreceive = await createOpenReceive({
  swap: {
    providers: [
      myCustomProvider, // implements SwapProvider
      fixedFloatCompatibleSwapProvider({ id: "ff", key, secret, baseUrl: "https://ff.io" }),
    ],
  },
});
```

For a provider with a different API, implement `SwapProvider` directly; the
interface owns cached asset catalog data, quote, create, status, refund, and
supported asset behavior. FixedFloat-compatible providers attach a durable store
cache for `/ccies` and the public XML rates export so catalog/quote traffic does
not burn authenticated API weight. A common pattern is "fake in dev, FixedFloat
in prod" keyed on `NODE_ENV`, using `createTestkitSwapProvider()` for the dev
branch.
