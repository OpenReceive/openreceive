# Automated Swaps

OpenReceive always settles merchant orders to Lightning. Automated swaps let a payer use supported crypto assets while the backend creates a shadow Lightning invoice for that attempt.

## Configure A Provider

Provider credentials stay server-side. The Node library auto-enables providers from a backend-only YAML config whose entries reference secret environment variables, so app code does not need to construct providers.

```ts
import { createOpenReceive } from "@openreceive/node";

const openreceive = await createOpenReceive();
```

Set the config path and provider credentials only in backend environments:

```sh
OPENRECEIVE_SWAP_CONFIG=./openreceive.swap.yml
OPENRECEIVE_FIXEDFLOAT_KEY=...
OPENRECEIVE_FIXEDFLOAT_SECRET=...
OTHERFLOAT_KEY=...
OTHERFLOAT_SECRET=...
```

The YAML file stores provider structure, not secret values:

```yaml
swap:
  providers:
    - id: fixedfloat
      protocol: fixedfloat
      base_url: https://ff.io
      key_env: OPENRECEIVE_FIXEDFLOAT_KEY
      secret_env: OPENRECEIVE_FIXEDFLOAT_SECRET
      invoice_expiry_seconds: 1620

    - id: otherfloat
      protocol: fixedfloat
      base_url: https://swap.example.com
      key_env: OTHERFLOAT_KEY
      secret_env: OTHERFLOAT_SECRET
      invoice_expiry_seconds: 1620
```

`providers` order is priority order. `id` must be unique and becomes the public `swap.provider` value. `protocol: fixedfloat` means the service uses the FixedFloat-compatible API shape for currency discovery, quotes, order creation, status, and refunds. The `invoice_expiry_seconds` value must cover the deposit window, settlement SLA, and margin. Omit `OPENRECEIVE_SWAP_CONFIG` to leave automated swaps disabled.

Never send provider keys, provider secrets, or the YAML config to browser code, mobile apps, source maps, fixtures, or logs. OpenReceive also supports the older `OPENRECEIVE_SWAP_FIXED_FLOAT_KEY` and `OPENRECEIVE_SWAP_FIXED_FLOAT_SECRET` env pair when `OPENRECEIVE_SWAP_CONFIG` is not set, but YAML is the preferred multi-provider convention.

## Payer Flow

OpenReceive performs no authentication or authorization. Treat `order_id` and
`attempt_id` as non-secret identifiers, not capabilities. Call `swapOptions`,
`swapQuote`, `startSwap`, and `refundSwap` only from backend routes where your
application has already authorized the caller to act on that order.

The app asks `swapOptions({ orderId })` for configured payment methods and cached provider limits. This catalog call does not request live provider prices, so it should not block the primary Lightning checkout path. OpenReceive does not take a payer country code or perform geolocation gating for swap providers. If a provider cannot serve a payer's region, the application should hide or disable that method before calling `swapQuote` or `startSwap`, because the application owns payer geolocation and eligibility checks.

When the payer chooses an asset, call `swapQuote({ orderId, payInAsset })` to make the single live quote request for that asset and show the estimate. Then call `startSwap({ orderId, payInAsset })` to create the provider order. The response is a public invoice payload for the swap attempt:

```json
{
  "invoice_id": "or_inv_swap_shadow_1",
  "type": "incoming",
  "rail": "swap",
  "status": "pending",
  "transaction_state": "pending",
  "workflow_state": "invoice_created",
  "invoice": null,
  "payment_hash": "9b8c...",
  "amount_msats": 200000,
  "order_id": "order_123",
  "created_at": 1783360530,
  "expires_at": 1783361130,
  "fiat_quote": null,
  "settlement_action_state": "pending",
  "swap": {
    "attempt_id": "or_inv_swap_shadow_1",
    "provider": "fixedfloat",
    "provider_order_id": "ff-order-1",
    "pay_in_asset": "USDT_TRON",
    "deposit_address": "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
    "deposit_amount": "1.05",
    "provider_state": "awaiting_deposit",
    "provider_expires_at": 1783361130
  }
}
```

Show the payer `swap.deposit_address`, `swap.deposit_amount`, `swap.pay_in_asset`, and the provider expiry. Provider tokens are private and never appear in this response.

Do not send an idempotency key for swap start. OpenReceive owns duplicate protection on the server: repeated `startSwap` calls for the same order's current checkout and asset reuse the existing active attempt, or return a conflict while the provider order is still being prepared. A new attempt is created only after the existing attempt expires or reaches a terminal provider state.

Token payments use an address-only QR plus copyable exact amount and network warnings. Native ETH and SOL may use amount-bearing QR payloads. Show a prominent warning that payers must pay with one method only. If a payer pays the original Lightning invoice and also sends funds to a swap deposit address, the merchant can receive both payments; OpenReceive dedupes fulfillment semantics, not payer funds.

## Refund Flow

If the provider reports `refund_required`, the public swap payload includes a
short-lived `refund_nonce`. Collect a refund address for the same network from
the authorized order session, then call:

```ts
await openreceive.refundSwap({
  attemptId: swap.attempt_id,
  refundAddress,
  refundNonce: swap.refund_nonce,
  confirm: false
});
```

OpenReceive stores and echoes the address while the provider state remains
`refund_required`. Show the payer the address, asset, and network for explicit
confirmation, then call the same method with `confirm: true`. The provider refund
is requested only after the confirmation call succeeds.

Use `swap.attempt_id`; do not target refunds by order id plus asset, because a payer may have multiple attempts for the same asset.

Warn payers to use an address they control and not to paste the deposit address. Shape validation catches obvious mistakes, but it cannot prove that an address belongs to the intended wallet or network.

## Settlement Authority

Provider completion never marks an order paid by itself. OpenReceive only settles a checkout when the global pending-invoice sweep sees `settled_at` or a settled transaction state in `list_transactions`. Swap provider status refresh can update provider fields such as `provider_state` and `payout_tx_id`, but it does not run a shadow-invoice-specific wallet lookup. If the provider says completed and later global sweeps never find wallet settlement, the attempt is marked for attention.

## Adding Providers

Use `protocol: fixedfloat` for providers that implement the same API shape as FixedFloat. For a provider with a different API, implement `OpenReceiveSwapProvider` directly; the interface owns cached asset catalog data, quote, create, status, refund, and supported asset behavior.
