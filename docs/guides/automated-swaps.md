# Automated swaps

A swap creates a shadow Lightning invoice in the merchant wallet, then asks a configured
provider for deposit instructions. The host commits both values on one payment-attempt row
before those instructions reach the payer.

Node hosts configure provider credentials with optional `LSC_URI_PRIMARY` and
`LSC_URI_BACKUP` environment variables. See
[Lightning Swap Connect](lightning-swap-connect.md) for the URI grammar and
security requirements.

The two recovery planes are independent:

- wallet settlement is proven by payment hash through NWC;
- unresolved provider state is queried with the provider details in `swap_data`.

`swap_data` is a JSON-serializable object containing provider order credentials. Keep it in the
host database; never return it to browsers or log it. Hosts may use framework/database field
encryption, but OpenReceive does not require a separate encryption key. Provider `completed`
does not fulfill an order unless the wallet also reports settlement.

Refunds are authorized by the host and pass the row's `orderId`, `paymentHash`, `swapData`, and
refund address. The service refreshes provider state immediately before requesting the refund
and refuses states other than `refund_required`.
