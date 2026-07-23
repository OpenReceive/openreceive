# @openreceive/http

Framework-neutral storage-free receive-checkout handler. It requires `service`, `authorize`,
`resolveCheckout`, and `onCheckoutCreated`. Create bodies never accept payer amounts;
the host resolver reads the order price, and the commit hook stores `payment_hash` before the
invoice is returned. On retries/reads the resolver returns `{ amount?, paymentHash?,
swapData? }` from the host row so the handler reconstructs the live checkout or provider state.
`swapData` is never serialized into an HTTP response. See the
root README and OpenAPI contract.
