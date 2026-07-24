# @openreceive/http

Framework-neutral receive-checkout handler. Its normal form requires `service`,
`authorize`, and the generated `host` integration. Create bodies never accept payer
amounts; the host resolver reads the order price, and the commit hook appends a
host-owned payment-attempt row before the invoice is returned.

`createOpenReceiveHost` creates that host integration with consistent multi-attempt selection,
settlement delivery, and reconciliation on top of an ORM-specific
`OpenReceiveHostRepository`. It reuses one live
attempt, permits new attempts after expiry, and verifies the `payment_hash`
selector belongs to the authorized order. Committed retries use the stored safe
checkout snapshot. `swapData` is never serialized into
an HTTP response. The runtime accepts no database connection or storage driver.
See the root README, Node ORM guide, and OpenAPI contract.
