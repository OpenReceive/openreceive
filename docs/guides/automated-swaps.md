# Automated swaps

A swap creates a shadow Lightning invoice in the merchant wallet, then asks a configured
provider for deposit instructions. The host commits both `payment_hash` and the opaque
`swap_recovery_token` before those instructions reach the payer.

The two recovery planes are independent:

- wallet settlement is proven by payment hash through NWC;
- unresolved provider state is queried with the recovery token.

The token is authenticated encrypted and contains provider order credentials. Never log it or
store plaintext provider tokens. Provider `completed` does not fulfill an order unless the
wallet also reports settlement.

Refunds call `createSwapRefundConfirmation`, then `refundSwap` with the short-lived token. The
service refreshes provider state immediately before requesting the refund and refuses states
other than `refund_required`.
