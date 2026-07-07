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

The app asks `swapOptions({ orderId, countryCode })` for available payment methods. The country code is used to hide providers that cannot serve that region; FixedFloat is unavailable to US payers.

When the payer chooses an asset, the client shows the estimate and then calls `startSwap` with an app-generated `idempotencyKey`. The service first reserves a durable attempt row, then calls the provider. The public response includes `swap.attempt_id`, deposit instructions, provider order details, and support references. The provider token remains private.

Token payments use an address-only QR plus copyable exact amount and network warnings. Native ETH and SOL may use amount-bearing QR payloads. The UI should tell payers to pay with one method only.

## Refund Flow

If the provider reports `refund_required`, collect a refund address for the same network and call `refundSwap({ attemptId, refundAddress })`. Use `swap.attempt_id`; do not target refunds by order id plus asset, because a payer may have multiple attempts for the same asset.

Warn payers to use an address they control and not to paste the deposit address. Shape validation catches obvious mistakes, but it cannot prove that an address belongs to the intended wallet or network.

## Settlement Authority

Provider completion never marks an order paid by itself. OpenReceive only settles a checkout when the receive wallet scan sees `settled_at` or a settled transaction state. When a provider reports completion, OpenReceive immediately performs a bounded wallet lookup for that shadow invoice and keeps watching. If the provider says completed but the wallet never settles, the attempt is marked for attention.

## Adding Providers

Implement `OpenReceiveSwapProvider` for each provider. The interface owns quote, create, status, refund, supported asset, and optional region-availability behavior. A FixedFloat-compatible provider can share protocol ideas, but SimpleSwap or any other provider should implement the interface directly rather than reusing FixedFloat-specific request code.
