# Swap operations

The host stores each swap attempt in `openreceive_payments`. Next to its `payment_hash`, the
row can hold server-only `swap_data`. Wallet settlement and provider workflow recovery stay
independent:

| Question | Authority | Host data |
| --- | --- | --- |
| Did the merchant receive Lightning? | NWC wallet | `payment_hash` |
| What is the provider doing? | Swap provider | `swap_data` |

A provider status of `completed` is not a payment. Fulfillment waits for NWC `settled_at` or
transaction `state == "settled"`. A preimage alone only corroborates payment.

## Creation and recovery

Creation order is fixed:

1. Mint the shadow Lightning invoice.
2. Create the provider order using that BOLT11.
3. Build JSON-serializable `swap_data` containing only the provider order recovery details.
4. Have the host atomically commit `payment_hash` and `swap_data`.
5. Only then return the public deposit address and exact amount. Never serialize `swap_data`.

If provider creation times out without returning credentials, the payer never saw a deposit
address. The orphaned order may expire at the provider. OpenReceive has no local workflow row to
reconcile.

`getSwap({ reference, paymentHash, swapData })` validates the stored object and selects the
named provider. It calls the provider's current status endpoint, verifies the provider and order
identity, and returns a normalized public snapshot. Cached provider state is process-local and
disposable.

## State handling

Common normalized states are `awaiting_deposit`, `confirming`, `exchanging`,
`paying_invoice`, `completed`, `expired`, `refund_required`, `refund_pending`, `refunded`,
`attention`, and `failed`. Treat them only as provider state for display:

- `completed` means finalizing until the wallet settles.
- `refund_required` enables the refund flow.
- `refunded`, `expired`, `attention`, and `failed` stop the payer from using the deposit
  instructions.
- A late wallet settlement still wins and must be delivered to the host.

Polling stops at settlement. The checkout controller drops its status watcher as soon as the
order is settled. The persisted `provider_state` is therefore the last snapshot before
settlement, not the provider's terminal status. Fast providers finish deposit → payout inside one
poll interval, so a settled order may still record `awaiting_deposit`.

Do not "fix" this by resuming polling. The wallet decides settlement, and the snapshot is only
for display. Once the order is settled, UIs must label the field as last-known.
`createTransactionDetails` renders it as "Last provider state". Code that needs the true
terminal record calls `getSwap` on demand.

## Refund safety

The browser sends `reference`, `payment_hash`, and `refund_address`. The host authorizes access
to the order, verifies that the attempt belongs to it, loads `swap_data`, and then calls:

```ts
await openreceive.refundSwap({
  reference: order.id,
  paymentHash: payment.paymentHash,
  swapData: payment.swapData,
  refundAddress,
});
```

`refundSwap` queries the provider right before acting, and proceeds only when the state is
`refund_required`. Repeated or stale calls therefore fail, because the provider's state decides.
The host may add its own approval step or single-use guard if its product needs one.

## Storage and loss

The provider token inside `swap_data` is sensitive. Keep it on the server and out of
logs, serializers, and browser bundles. Hosts may encrypt it at rest with Rails encrypted
attributes, database encryption, or another policy. OpenReceive does not require a second key.

Losing `swap_data` does not prevent wallet settlement by payment hash. Provider status and
refund recovery then need access to the provider's dashboard or support.

## Multi-instance behavior

No OpenReceive coordination service is required. Each process may poll the provider or wallet
on its own, so callbacks can repeat. The library absorbs duplicate delivery: settlement is
write-once, and fulfillment runs only for the first settlement. Process-local rate and catalog
caches and request-weight guards only help performance. Correctness never depends on them.
