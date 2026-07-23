# Authorization and host hooks

OpenReceive never inspects your session. Mounted handlers require:

- `authorize(context)`: your authentication/ownership policy;
- `resolveCheckoutAmount(context)`: read the host order/catalog and return its price;
- `onCheckoutCreated(payment)`: compare-and-set `payment_hash` before responding.

`rateLimit` is optional. `createDefaultAuthorize()` permits anonymous create/quote actions and
requires a valid stateless capability for payment reads. Signed-in applications should supply
their own policy.

The create body cannot contain `amount` or `amount_msats`. This prevents a browser from being
the price authority. A failed `onCheckoutCreated` returns 409 without invoice or swap payer
instructions.

Capability tokens are authenticated encrypted envelopes bound to order ID, payment hash, and
expiry. OpenReceive stores no token hash. Treat them as secrets and never log them.
