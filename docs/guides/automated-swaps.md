# Automated Swaps

OpenReceive always settles merchant orders to Lightning. Automated swaps let a payer
use supported crypto assets while the backend creates a shadow Lightning invoice for
that attempt.

## Configure A Provider

You create the OpenReceive server instance exactly as shown in the
[Node Quickstart](quickstart-node.md) — automated swaps add no swap-specific app
code. Provider credentials stay server-side, and the Node library auto-enables
providers from `openreceive.yml`, so the same `createOpenReceive()` call picks
them up with no extra arguments.

Put provider credentials only in the ignored backend `openreceive.yml`:

```yaml
OPENRECEIVE_NWC: nostr+walletconnect://...
OPENRECEIVE_NAMESPACE: my_app

swap:
  providers:
    - id: fixedfloat
      protocol: fixedfloat
      base_url: https://ff.io
      key: ...
      secret: ...

    - id: otherfloat
      protocol: fixedfloat
      base_url: https://swap.example.com
      key: ...
      secret: ...
```

`providers` order is priority order. `id` must be unique and becomes the public
`swap.provider` value. Quote and start always try the first provider that supports the
pay-in asset; if that provider's shared weight budget is exhausted (or in backoff after
a 429), selection fails over to the next entry that still supports the asset. Each
provider has its own durable ledger (`swap_provider_weight:<id>`) assuming
FixedFloat-compatible limits (250 weight/min, `/create` = 50). Status and refund for an
existing attempt stay pinned to the provider that created it.

`protocol: fixedfloat` means the service uses the FixedFloat-compatible API shape for
currency discovery, quotes, order creation, status, and refunds. Leave `swap.providers`
empty or leave provider keys blank to keep automated swaps disabled.

`invoice_expiry_seconds` is optional. It auto-derives from
`deposit_window_seconds + settlement_sla_seconds + invoice_expiry_margin_seconds` (default
`600 + 900 + 300 = 1800`). The margin is sized so the shadow Lightning invoice outlives
plausible FixedFloat deposit windows (their API examples show ~1800s). Set
`invoice_expiry_seconds` only to lengthen the window; a value below that floor is rejected
at startup with an error that states the offending value and the required minimum. After
`/create`, if the provider order still expires after the shadow invoice, the attempt is
marked `attention` (`provider_order_expires_after_shadow_invoice`) rather than racing a
dead bolt11 at payout time.

Never send provider keys, provider secrets, or `openreceive.yml` to browser code, mobile
apps, source maps, fixtures, or logs. Commit `openreceive.yml.example`, not the real file.

At startup OpenReceive logs a `swap.providers.resolved` event listing the provider names it
loaded (or noting that swaps are disabled), so "off on purpose" is distinguishable from
"misconfigured".

## Payer Flow

The whole payer experience is one backend route plus one checkout attribute. Your
route authorizes the order its own way, then calls the typed camelCase service
methods (or mounts the shipped HTTP handler, which does the same):

```ts
// app-owned route — you authorize, then call typed methods
export async function POST(request: Request): Promise<Response> {
  const body = await request.json();
  const orderId = body.order_id;
  await authorizeOrderAccess(request, orderId); // your own session/ownership check

  const action = body.action ?? "status";
  if (action === "status") {
    const order = await openreceive.getOrder({ orderId });
    const swap = await openreceive.swapOptions({ orderId });
    return Response.json({
      ...order,
      swaps_enabled: swap.enabled,
      swap_pay_options: swap.enabled ? swap.options : [],
    });
  }
  if (action === "swap_quote") {
    const quote = await openreceive.swapQuote({ orderId, payInAsset: body.pay_in_asset });
    return Response.json({ quote });
  }
  if (action === "start_swap") {
    const attempt = await openreceive.startSwap({ orderId, payInAsset: body.pay_in_asset });
    return Response.json({ attempt });
  }
  if (action === "refund_swap") {
    const attempt = await openreceive.refundSwap({
      attemptId: body.attempt_id,
      refundAddress: body.refund_address,
      refundNonce: body.refund_nonce,
      confirm: body.confirm === true,
    });
    return Response.json({ attempt });
  }
  return Response.json({ code: "INVALID_REQUEST", message: "Unknown order action." }, { status: 400 });
}
```

OpenReceive performs no authentication or authorization. Treat `order_id` and
`attempt_id` as non-secret identifiers, not capabilities — authorize the caller in
your route before calling the service. Prefer mounting the shipped routes
(`openReceiveExpress` / `createOpenReceiveHttpHandler`) so you do not hand-write
this multiplexer. This one route serves both plain Lightning status polling and
every swap action.

Point the checkout element at that one route with `order-url` (or the `orderUrl`
prop on the framework components):

```html
<openreceive-checkout order-id="order_123" order-url="/order"></openreceive-checkout>
```

The element drives everything else through that single route: it polls the order
for status, lists the payable assets, creates the deposit address the payer sends
to, and handles refunds. The default (status) action returns the order plus the payable
swap assets on `swap_pay_options`, so listing methods costs no extra call:

```json
{
  "order_id": "order_123",
  "status": "pending",
  "paid": false,
  "swaps_enabled": true,
  "swap_pay_options": [
    {
      "pay_in_asset": "USDT_TRON",
      "label": "USDT",
      "network_label": "Tron",
      "provider": "fixedfloat",
      "available": true,
      "pay_amount": "1.05"
    }
  ]
}
```

`swap_pay_options` lists only the crypto swap methods. Lightning is always available on the
order's checkout invoice and is not repeated here.

Behavior is unchanged from the lower-level methods: OpenReceive owns duplicate
protection (repeated starts for the same order, checkout, and asset reuse the
active attempt), provider tokens never reach the browser, and payer geolocation
and eligibility stay the application's responsibility.

The payer sees the deposit address, exact amount, asset and network, and provider
expiry. Token payments use an address-only QR plus a copyable exact amount and
network warnings; native ETH and SOL may use amount-bearing QR payloads. Warn
payers to pay with one method only — if a payer pays the Lightning invoice and
also sends funds to a deposit address, the merchant can receive both.

## Swap Lifecycle

A swap attempt's `provider_state` is one of twelve values. Import the canonical
classifier from `@openreceive/node` instead of hardcoding a switch — the built-in element
and your custom UI then read the same source of truth:

```ts
import { describeSwapState, OPENRECEIVE_SWAP_STATES } from "@openreceive/node";

const { label, detail, phase, terminal } = describeSwapState(attempt.providerState);
if (phase === "awaiting_deposit") renderDepositBox(attempt);
if (terminal) stopPolling(attempt.attemptId);
```

`describeSwapState(state)` returns `{ label, detail, phase, terminal }`. `phase` is a coarse
bucket for UI branching; `OPENRECEIVE_SWAP_STATES` is the full catalog. HTTP wire fields stay
snake_case (`provider_state`); the JS service uses camelCase (`providerState`).

| `provider_state` (HTTP) / `providerState` (SDK) | phase | terminal | meaning for the payer |
| --- | --- | --- | --- |
| `creating_provider_order` | `preparing` | no | The deposit address is still being created. |
| `awaiting_deposit` | `awaiting_deposit` | no | Show the deposit address/amount; the payer must send funds. |
| `confirming` | `processing` | no | The deposit was detected and is confirming. |
| `exchanging` | `processing` | no | The provider is converting the payment. |
| `paying_invoice` | `processing` | no | The provider is paying the Lightning invoice. |
| `completed` | `settling` | no | Provider reports done — **not paid yet**. Render "Finalizing", never "Paid". |
| `expired` | `terminal` | yes | No deposit arrived before the window closed. |
| `refund_required` | `refund` | no | Collect a refund address (see below). |
| `refund_pending` | `refund` | no | A refund has been requested from the provider. |
| `refunded` | `terminal` | yes | The provider reports the refund was sent. |
| `attention` | `attention` | yes | Needs operator review — see the runbook below. |
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

`completed` is deliberately non-terminal: provider completion is not payment. OpenReceive
only marks an order paid when the wallet sweep sees a settled transaction (see
[Settlement Authority](#settlement-authority)).

## Refund Flow

Refunds ride the same route with no extra wiring. When the provider reports
`refund_required`, the checkout element collects a refund address for the same
network, shows it back for explicit confirmation, and submits the confirmed
refund — all through `order-url`.

Refund confirmation is two-phase and nonce-guarded. The attempt carries a `refundNonce`
(HTTP: `refund_nonce`) and its `refundNonceExpiresAt` / `refund_nonce_expires_at` (unix
seconds). Submit the address once to stage it (`confirm` omitted/false), show it back,
then submit again with `confirm: true`. Show a countdown from the expiry: a confirm
submitted after it lapses is rejected and the staged address is lost, so re-fetch status
to get a fresh nonce before it expires.

Warn payers to use an address they control and not to paste the deposit address.
Shape validation catches obvious mistakes, but it cannot prove that an address
belongs to the intended wallet or network.

## Custom UIs

The single HTTP route covers the built-in checkout. To build a fully custom UI, call
the typed camelCase service methods directly from backend routes where you have already
authorized the caller. The shipped HTTP handler maps `action` the same way; an
unrecognized `action` is rejected with a 400 rather than silently treated as status:

| `action` (HTTP) | routes to | returns |
| --- | --- | --- |
| omitted / `"status"` | `getOrder` + `swapOptions` | `OrderStatus` (order + `swaps_enabled` + `swap_pay_options`) |
| `"swap_quote"` | `swapQuote` | `{ quote }` — one live estimate |
| `"start_swap"` | `startSwap` | `{ attempt }` — the swap attempt |
| `"refund_swap"` | `refundSwap` | `{ attempt }` |

The wire body uses snake_case (`order_id`, `pay_in_asset`, `attempt_id`,
`refund_address`, `refund_nonce`); the SDK methods take camelCase inputs
(`orderId`, `payInAsset`, `attemptId`, `refundAddress`, `refundNonce`).

`startSwap` and `refundSwap` return a first-class `SwapAttempt`: the deposit
fields the payer needs are top-level and guaranteed present, and the backing shadow
Lightning invoice is `shadowInvoice`:

```ts
const attempt = await openreceive.startSwap({ orderId, payInAsset: "USDT_TRON" });
attempt.depositAddress;     // top-level — no optional `.swap` to unwrap
attempt.depositAmount;      // exact amount to send
attempt.providerState;      // feed to describeSwapState()
attempt.refundNonce;        // present once a refund is required
attempt.shadowInvoice;      // the Invoice this attempt is racing
```

Refund is two-phase: submit with `confirm: false` to stage and echo the address while the
state is `refund_required`, then `confirm: true` to request the provider refund. Target
refunds by `attemptId`, not order id plus asset, because a payer may have multiple attempts
for one asset.

## Settlement Authority

Provider completion never marks an order paid by itself. OpenReceive only settles a checkout
when the global pending-invoice sweep sees `settled_at` or a settled transaction state in
`list_transactions`. Swap provider status refresh can update provider fields such as
`provider_state` and `payout_tx_id`, but it does not run a shadow-invoice-specific wallet
lookup. If the provider says completed and later global sweeps never find wallet settlement,
the attempt is marked for attention.

## Operating Swaps: The Attention State

When an attempt enters `attention`, automatic polling stops (it is terminal for the
background poller). The attempt exposes `attention_reason` so a dashboard or on-call
runbook can branch on the cause. For `provider_reported_emergency` only, call
`refreshSwap` / HTTP `refresh_swap` after acting in the FixedFloat dashboard — do not
auto-poll every attention record (that burns the shared API weight budget).

| `attention_reason` | what happened | what to do |
| --- | --- | --- |
| `provider_completed_without_wallet_settlement` | Provider reported the Lightning payout as done, but no wallet settlement arrived within `settlement_attention_seconds`. | Reconcile against the wallet's `list_transactions` and the provider's payout tx. If the payout truly never landed, escalate to the provider with `payout_tx_id`. |
| `provider_order_creation_stale` | A reserved attempt never received a provider order id (create hung). No deposit address was ever shown, so no payer funds are at risk. | Safe to ignore; the payer can start a fresh attempt. |
| `provider_order_creation_failed` | The provider rejected order creation. `provider_error` records why. No deposit address was shown. | Safe to ignore for that attempt; check `provider_error` if it recurs across payers. |
| `provider_order_creation_needs_reconcile` | Create timed out or was interrupted after the request may have reached FixedFloat. FixedFloat has no client idempotency key, so a live order may exist without a stored token. | Reconcile in the FixedFloat dashboard before starting another attempt for this asset — OpenReceive blocks auto-mint of attempt N+1. |
| `provider_reported_emergency` | The provider flagged an emergency (e.g. overpayment or a manual exchange choice) that OpenReceive could not resolve automatically. | Act in the provider dashboard, then `refresh_swap` to pull the new state. |
| `provider_order_expires_after_shadow_invoice` | Provider order `expires_at` outlives the shadow bolt11 minted before `/create`. | Raise `invoice_expiry_seconds` / margin; do not expect LN payout on this attempt. |

Alert on `attention` and route each reason to the right response. Do not auto-refund on
`attention` — only `refund_required` carries a nonce and a safe refund path.

## Testing Swaps Locally

`@openreceive/testkit` ships an in-memory, scriptable provider so you can build and test the
whole flow offline — no live FixedFloat keys, no real crypto:

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

## Auditing Swap Stress Tests

Wire a `logger` (and optional file logging at `debug`) so you can follow each attempt without
scraping provider response blobs. Server events never include `refund_nonce`, refund
addresses, or provider tokens — only `refund_nonce_present` / expiry timestamps.

| Event | Level | When |
| --- | --- | --- |
| `swap.created` | info | Provider order created |
| `swap.state.changed` | debug→warn | `provider_state` moved (poll, confirm, etc.) |
| `swap.attention.raised` | warn | Attention reason set (settlement SLA, create fail/stale, …) |
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

Set `logging.level: debug` in `openreceive.yml` (or pass `logger` that keeps debug) so
`order.status.*`, `swap.refund.nonce_issued`, and poll transitions are retained.

## Adding Providers

Use `protocol: fixedfloat` for providers that implement the same API shape as FixedFloat.

To register a provider from code — a custom one, or a FixedFloat-compatible one you build
yourself — pass it to `createOpenReceive`. Programmatic providers **merge** with the YAML
providers (they no longer replace them): entries are de-duplicated by `.name`, so a
programmatic provider with the same id overrides its YAML entry in place, and new ids are
appended after the YAML providers in priority order.

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
interface owns cached asset catalog data, quote, create, status, refund, and supported asset
behavior. A common pattern is "fake in dev, FixedFloat in prod" keyed on `NODE_ENV`, using
`createTestkitSwapProvider()` for the dev branch.
