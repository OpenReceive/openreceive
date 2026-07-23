# API reference

The normal Node/Ruby service primitives are:

- `createCheckout({ orderId, amount })`
- `checkPayment({ paymentHash })`
- `reconcilePayments({ paymentHashes })`
- `watchPayments({ onPaid })`
- `quoteSwap`, `createSwap`, `getSwap`, `refundSwap`

`amount` is exactly `{ sats }` or `{ currency, value }`; public results use `amount_msats`.
Fiat conversion uses exact decimal/integer math.

The mounted HTTP routes are defined normatively in
[`spec/openapi/openreceive-http.v1.yaml`](../../spec/openapi/openreceive-http.v1.yaml). Create
routes reject payer amounts and call the required host resolver. Payment and swap reads send
`order_id`; after host authorization the resolver supplies `payment_hash` / server-only
`swap_data`.
