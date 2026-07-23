# API reference

The normal Node/Ruby service primitives are:

- `createCheckout({ orderId, amount })`
- `checkPayment({ paymentHash })`
- `reconcilePayments({ paymentHashes })`
- `watchPayments({ onPaid })`
- `quoteSwap`, `createSwap`, `getSwap`, `createSwapRefundConfirmation`, `refundSwap`

`amount` is exactly `{ sats }` or `{ currency, value }`; public results use `amount_msats`.
Fiat conversion uses exact decimal/integer math.

The mounted HTTP routes are defined normatively in
[`spec/openapi/openreceive-http.v1.yaml`](../../spec/openapi/openreceive-http.v1.yaml). Create
routes reject payer amounts and call the required host amount resolver. Payment and swap reads
use opaque stateless capability/recovery tokens.
