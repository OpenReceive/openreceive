# Swap operations

OpenReceive keeps no swap row. Every unresolved provider workflow is recovered from the opaque,
authenticated encrypted `swap_recovery_token` stored by the host. Wallet settlement and provider
workflow recovery are intentionally independent:

| Question | Authority | Recovery identifier |
| --- | --- | --- |
| Did the merchant receive Lightning? | NWC wallet | `payment_hash` |
| What is the provider doing? | Swap provider | encrypted recovery token |

Provider `completed` is not payment. Fulfillment waits for NWC `settled_at` or transaction
`state == "settled"`; a preimage alone is corroboration.

## Creation and recovery

Creation order is fixed:

1. Mint the shadow Lightning invoice.
2. Create the provider order using that BOLT11.
3. Seal provider identity, order credentials, payment hash, order id, asset, and expiry.
4. Have the host commit `payment_hash` and `swap_recovery_token`.
5. Only then return the deposit address and exact amount.

If provider creation times out without returning credentials, no deposit address was shown. The
orphan may expire at the provider; OpenReceive has no local workflow row to reconcile.

`getSwap({ recoveryToken })` decrypts the token, selects the named provider, calls its current
status endpoint, verifies provider/order identity, and returns a normalized snapshot. Cached
provider state is process-local and disposable.

## State handling

Common normalized states are `awaiting_deposit`, `confirming`, `exchanging`,
`paying_invoice`, `completed`, `expired`, `refund_required`, `refund_pending`, `refunded`,
`attention`, and `failed`. Treat them as provider presentation state only:

- `completed` means finalizing until the wallet settles;
- `refund_required` enables the refund flow;
- `refunded`, `expired`, `attention`, and `failed` stop payer use of the deposit instructions;
- a late wallet settlement still wins and must be delivered to the host.

## Refund safety

Refunds are two-step and stateless:

```ts
const confirmation = await openreceive.createSwapRefundConfirmation({
  recoveryToken,
  refundAddress,
});

await openreceive.refundSwap({
  recoveryToken,
  refundAddress,
  confirmationToken: confirmation.confirmationToken,
});
```

The confirmation token binds the payment, provider order, refund address, and expiry. Strict
local single-use enforcement is impossible without persistence, so `refundSwap` queries the
provider immediately before acting and permits only `refund_required`. Repeated or stale calls
therefore fail against provider authority. A host may add its own refund guard if desired.

## Key rotation and loss

The first configured key seals new tokens; retained older keys only decrypt in-flight tokens.
Removing an old key makes its unresolved swaps unrecoverable. Losing only a recovery token does
not prevent wallet settlement by payment hash, but provider status/refunds require dashboard or
support recovery. Never expose raw provider credentials or receive-only NWC secrets in logs.

## Multi-instance behavior

No coordination service is required. Each process may poll the provider or wallet independently;
callbacks can repeat. The host's write-once `paid_at` and fulfillment transaction absorb duplicate
delivery. Process-local rate/catalog caches and request-weight guards are performance aids, not
durable correctness state.
