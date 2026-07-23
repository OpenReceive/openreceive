# @openreceive/fastify

Fastify adapter for `@openreceive/http`. Register it with `service`, host
`authorize`, and the hooks returned by `createOpenReceivePaymentHooks`. The
host-owned repository commits a payment-attempt row before payer instructions
are returned; the runtime has no database configuration.
