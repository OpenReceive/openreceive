# Automated swaps

A swap creates a shadow Lightning invoice in the merchant wallet, then asks a configured
provider for deposit instructions. Both values are committed on one `openreceive_payments`
attempt row before those instructions reach the payer. One row holds exactly one provider
order; a swap retry creates another row with a fresh invoice hash.

Node hosts configure provider credentials with optional `LSC_URI_PRIMARY` and
`LSC_URI_BACKUP` environment variables. Primary is used exclusively while it is
healthy; backup is only for primary outage. See
[Lightning Swap Connect](lightning-swap-connect.md) for the URI grammar and
security requirements. OpenReceive only quotes its small fixed pay-in asset
list into Lightning — provider market dumps are not merged in.

The two recovery planes are independent:

- wallet settlement is proven by payment hash through NWC;
- unresolved provider state is queried with the provider details in `swap_data`.

`swap_data` is a JSON-serializable object containing provider order credentials. It lives only
on the attempt row and stays server-only; never return it to browsers or log it. Hosts may use
framework/database field encryption, but OpenReceive does not require a separate encryption
key. Provider `completed` does not fulfill an order unless the wallet also reports settlement.

Refunds are authorized by the host and pass the row's `orderId`, `paymentHash`, `swapData`, and
refund address. The service refreshes provider state immediately before requesting the refund
and refuses states other than `refund_required`.

## Provider state after settlement

Once the wallet reports the shadow invoice settled, the order's outcome can no longer change,
so OpenReceive stops polling the provider. The stored `provider_state` is therefore the last
snapshot taken *before* settlement, and it can lag arbitrarily far behind the provider's real
terminal status. A fast provider can run its whole deposit → payout sequence inside one poll
interval — a settled order can legitimately still record `awaiting_deposit` even though the
provider finished (paying the Lightning invoice is what settled the order).

This is by design, not data loss:

- settlement authority is the wallet sweep, proven by payment hash — never provider status;
- continued provider polling after settlement would spend provider request budget to learn
  nothing that can change the order.

The transaction-details UI reflects this by labeling the row **Last provider state** (instead
of **Provider state**) once the order is settled. Checkout panels ignore the stale snapshot
entirely and show final payment confirmation. If a host wants the provider's terminal record
(e.g. the payout transaction id) for bookkeeping, it can call `getSwap` with the stored
`swap_data` at any time — provider status remains queryable after settlement.
