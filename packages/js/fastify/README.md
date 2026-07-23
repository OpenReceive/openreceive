# @openreceive/fastify

Fastify adapter for the storage-free `@openreceive/http` handler. Register it with `service`,
host `authorize`, `resolveCheckoutAmount`, and `onCheckoutCreated` hooks. The host commits the
payment hash before payer instructions are returned.
