# Automated Swaps

OpenReceive always settles merchant orders to Lightning. Automated swaps let a payer use supported crypto assets while the backend creates a shadow Lightning invoice for that attempt.

## Configure A Provider

Provider credentials stay server-side. The Node library auto-enables configured providers from environment variables, so app code does not need to construct providers.

```ts
import { createOpenReceive } from "@openreceive/node";

const openreceive = await createOpenReceive();
```

Set provider credentials only in backend environments:

```sh
OPENRECEIVE_SWAP_FIXED_FLOAT_KEY=...
OPENRECEIVE_SWAP_FIXED_FLOAT_SECRET=...
# Optional; defaults to https://ff.io
OPENRECEIVE_SWAP_FIXED_FLOAT_BASE_URL=https://ff.io
```

OpenReceive enables FixedFloat when both key and secret are present. Omit both to leave automated swaps disabled. Never send these values to browser code, mobile apps, source maps, fixtures, or logs.

## Payer Flow

The app asks `swapOptions({ orderId })` for configured payment methods. OpenReceive does not take a payer country code or perform geolocation gating for swap providers. If a provider cannot serve a payer's region, the application should hide or disable that method before calling `startSwap`, because the application owns payer geolocation and eligibility checks.

When the payer chooses an asset, the client shows the estimate and then calls `startSwap({ orderId, payInAsset })`. The response is a public invoice payload for the swap attempt:

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

Token payments use an address-only QR plus copyable exact amount and network warnings. Native ETH and SOL may use amount-bearing QR payloads. The UI should tell payers to pay with one method only.

## Refund Flow

If the provider reports `refund_required`, collect a refund address for the same network and call `refundSwap({ attemptId, refundAddress })`. Use `swap.attempt_id`; do not target refunds by order id plus asset, because a payer may have multiple attempts for the same asset.

Warn payers to use an address they control and not to paste the deposit address. Shape validation catches obvious mistakes, but it cannot prove that an address belongs to the intended wallet or network.

## Settlement Authority

Provider completion never marks an order paid by itself. OpenReceive only settles a checkout when the global pending-invoice sweep sees `settled_at` or a settled transaction state in `list_transactions`. Swap provider status refresh can update provider fields such as `provider_state` and `payout_tx_id`, but it does not run a shadow-invoice-specific wallet lookup. If the provider says completed and later global sweeps never find wallet settlement, the attempt is marked for attention.

## Adding Providers

Implement `OpenReceiveSwapProvider` for each provider. The interface owns quote, create, status, refund, and supported asset behavior. A FixedFloat-compatible provider can share protocol ideas, but SimpleSwap or any other provider should implement the interface directly rather than reusing FixedFloat-specific request code.
