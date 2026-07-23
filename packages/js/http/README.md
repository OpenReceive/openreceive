# @openreceive/http

Framework-neutral receive-checkout handler. It requires `service`, `authorize`,
`resolveCheckout`, and `onCheckoutCreated`. Create bodies never accept payer
amounts; the host resolver reads the order price, and the commit hook appends a
host-owned payment-attempt row before the invoice is returned.

`createOpenReceivePaymentHooks` supplies consistent multi-attempt selection on
top of an ORM-specific `OpenReceivePaymentRepository`. It reuses one live
attempt, permits new attempts after expiry, and verifies the `payment_hash`
selector belongs to the authorized order. `swapData` is never serialized into
an HTTP response. The runtime accepts no database connection or storage driver.
See the root README, Node ORM guide, and OpenAPI contract.
