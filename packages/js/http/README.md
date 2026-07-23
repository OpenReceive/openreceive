# @openreceive/http

Framework-neutral storage-free receive-checkout handler. It requires `service`, `authorize`,
`resolveCheckoutAmount`, and `onCheckoutCreated`. Create bodies never accept payer amounts;
the host resolver reads the order price, and the commit hook stores `payment_hash` before the
invoice is returned. On retries the resolver returns `{ amount, paymentHash,
swapRecoveryToken? }` from the host row so the handler reconstructs the live checkout. See the
root README and OpenAPI contract.
