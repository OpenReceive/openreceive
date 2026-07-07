# Automated Swaps

OpenReceive always settles merchant orders to Lightning. Automated swaps let a payer use supported crypto assets while the backend creates a shadow Lightning invoice for that attempt.

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
      invoice_expiry_seconds: 1620

    - id: otherfloat
      protocol: fixedfloat
      base_url: https://swap.example.com
      key: ...
      secret: ...
      invoice_expiry_seconds: 1620
```

`providers` order is priority order. `id` must be unique and becomes the public `swap.provider` value. `protocol: fixedfloat` means the service uses the FixedFloat-compatible API shape for currency discovery, quotes, order creation, status, and refunds. The `invoice_expiry_seconds` value must cover the deposit window, settlement SLA, and margin. Leave `swap.providers` empty or leave provider keys blank to keep automated swaps disabled.

Never send provider keys, provider secrets, or `openreceive.yml` to browser code, mobile apps, source maps, fixtures, or logs. Commit `openreceive.yml.example`, not the real file.

## Payer Flow

The whole payer experience is one backend route plus one checkout attribute. Your
route authorizes the order its own way, then forwards the request body to
`openreceive.order(body)`:

```ts
// app-owned route — you authorize, OpenReceive routes the rest
export async function POST(request: Request): Promise<Response> {
  const body = await request.json();
  await authorizeOrderAccess(request, body.order_id); // your own session/ownership check
  return Response.json(await openreceive.order(body));
}
```

OpenReceive performs no authentication or authorization. Treat `order_id` and
`attempt_id` as non-secret identifiers, not capabilities — authorize the caller in
your route before forwarding. `order()` takes no auth callback and adds no new
payment logic; it is a thin router over the existing server behavior.

Point the checkout element at that one route with `order-url` (or the `orderUrl`
prop on the framework components):

```html
<openreceive-checkout order-id="order_123" order-url="/order"></openreceive-checkout>
```

The element drives everything else through that single route: it polls the order
for status, lists the payable assets, creates the deposit address the payer sends
to, and handles refunds. Payable assets ride on the order object itself as
`payment_methods`, so listing methods costs no extra call:

```json
{
  "order_id": "order_123",
  "status": "pending",
  "paid": false,
  "payment_methods": [
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

Behavior is unchanged from the lower-level methods: OpenReceive owns duplicate
protection (repeated starts for the same order, checkout, and asset reuse the
active attempt), provider tokens never reach the browser, and payer geolocation
and eligibility stay the application's responsibility.

The payer sees the deposit address, exact amount, asset and network, and provider
expiry. Token payments use an address-only QR plus a copyable exact amount and
network warnings; native ETH and SOL may use amount-bearing QR payloads. Warn
payers to pay with one method only — if a payer pays the Lightning invoice and
also sends funds to a deposit address, the merchant can receive both.

## Refund Flow

Refunds ride the same route with no extra wiring. When the provider reports
`refund_required`, the checkout element collects a refund address for the same
network, shows it back for explicit confirmation, and submits the confirmed
refund — all through `order-url`.

Warn payers to use an address they control and not to paste the deposit address.
Shape validation catches obvious mistakes, but it cannot prove that an address
belongs to the intended wallet or network.

## Custom UIs

The single route covers the built-in checkout. To build a fully custom UI,
`openreceive.order(body)` is a thin router over four lower-level methods that stay
available as escape hatches. Call them only from backend routes where you have
already authorized the caller. The `action` in the forwarded body selects one:

| `action` | routes to | returns |
| --- | --- | --- |
| omitted / `"status"` | `getOrder` + `swapOptions` | order object + `payment_methods` |
| `"quote"` | `swapQuote` | `{ quote }` — one live estimate |
| `"start"` | `startSwap` | `{ invoice }` — the swap attempt payload |
| `"refund"` | `refundSwap` | `{ invoice }` |

`startSwap` returns a public invoice whose `swap` block carries `attempt_id`,
`deposit_address`, `deposit_amount`, `pay_in_asset`, `provider_state`, and the
provider expiry. Refund is two-phase: submit with `confirm: false` to stage and
echo the address while the state is `refund_required`, then `confirm: true` to
request the provider refund. Target refunds by `attempt_id`, not order id plus
asset, because a payer may have multiple attempts for one asset.

## Settlement Authority

Provider completion never marks an order paid by itself. OpenReceive only settles a checkout when the global pending-invoice sweep sees `settled_at` or a settled transaction state in `list_transactions`. Swap provider status refresh can update provider fields such as `provider_state` and `payout_tx_id`, but it does not run a shadow-invoice-specific wallet lookup. If the provider says completed and later global sweeps never find wallet settlement, the attempt is marked for attention.

## Adding Providers

Use `protocol: fixedfloat` for providers that implement the same API shape as FixedFloat. For a provider with a different API, implement `OpenReceiveSwapProvider` directly; the interface owns cached asset catalog data, quote, create, status, refund, and supported asset behavior.
