# Swap operations

The host stores each swap attempt in `openreceive_payments`, with optional server-only
`swap_data` beside its `payment_hash`. Wallet settlement and provider workflow recovery remain
independent:

| Question | Authority | Host data |
| --- | --- | --- |
| Did the merchant receive Lightning? | NWC wallet | `payment_hash` |
| What is the provider doing? | Swap provider | `swap_data` |

Provider `completed` is not payment. Fulfillment waits for NWC `settled_at` or transaction
`state == "settled"`; a preimage alone is corroboration.

## Creation and recovery

Creation order is fixed:

1. Mint the shadow Lightning invoice.
2. Create the provider order using that BOLT11.
3. Build JSON-serializable `swap_data` containing only the provider order recovery details.
4. Have the host atomically commit `payment_hash` and `swap_data`.
5. Only then return the public deposit address and exact amount. Never serialize `swap_data`.

If provider creation times out without returning credentials, no deposit address was shown. The
orphan may expire at the provider; OpenReceive has no local workflow row to reconcile.

`getSwap({ reference, paymentHash, swapData })` validates the stored object, selects the named provider, calls its current
status endpoint, verifies provider/order identity, and returns a normalized public snapshot.
Cached provider state is process-local and disposable.

## State handling

Common normalized states are `awaiting_deposit`, `confirming`, `exchanging`,
`paying_invoice`, `completed`, `expired`, `refund_required`, `refund_pending`, `refunded`,
`attention`, and `failed`. Treat them as provider presentation state only:

- `completed` means finalizing until the wallet settles;
- `refund_required` enables the refund flow;
- `refunded`, `expired`, `attention`, and `failed` stop payer use of deposit instructions;
- a late wallet settlement still wins and must be delivered to the host.

Polling stops at settlement: the checkout controller drops its status watcher as soon as the
order is settled, so the persisted `provider_state` is the last pre-settlement snapshot, not
the provider's terminal status. Fast providers finish deposit → payout inside one poll
interval, so a settled order may still record `awaiting_deposit`. Do not "fix" this by
resuming polling — settlement authority is the wallet, and the snapshot is presentation state
only. UIs must label the field as last-known once settled (`createTransactionDetails`
renders it as "Last provider state"); anything needing the true terminal record calls
`getSwap` on demand.

## Refund safety

The browser sends `reference`, `payment_hash`, and `refund_address`. The host authorizes order
access, verifies that attempt belongs to it, loads `swap_data`, and then calls:

```ts
await openreceive.refundSwap({
  reference: order.id,
  paymentHash: payment.paymentHash,
  swapData: payment.swapData,
  refundAddress,
});
```

`refundSwap` queries the provider immediately before acting and permits only
`refund_required`. Repeated or stale calls therefore fail against provider authority. The host
may add its own approval or single-use guard when its product requires one.

## Storage and loss

The provider token inside `swap_data` is sensitive. Keep it server-side and exclude it from
logs, serializers, and browser bundles. Hosts may use Rails encrypted attributes, database
encryption, or another at-rest policy; OpenReceive does not require a second key.

Losing `swap_data` does not prevent wallet settlement by payment hash, but provider status and
refund recovery then require provider dashboard/support access.

## Multi-instance behavior

No OpenReceive coordination service is required. Each process may poll the provider or wallet
independently; callbacks can repeat. The library's write-once settlement and first-settlement
fulfillment absorb duplicate delivery. Process-local rate/catalog caches and request-weight guards are
performance aids, not durable correctness state.
