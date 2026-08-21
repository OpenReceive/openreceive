# Library-owned persistence boundary

The supported boundary is receive-only NWC invoice creation/verification, stateless mounted
routes, exact fiat conversion, passive notifications plus reconciliation, and optional
server-side swap recovery/refunds.

OpenReceive never owns orders, users, prices, or fulfillment, and never requires a separate
database, Redis, or migration runner. It MAY own payment-attempt rows (`openreceive_payments`)
inside the host application's existing database: the host passes its database handle and runs
the migration through its own workflow; the library owns the schema, locking, settlement
write-once, and the reconciliation state machine. Rails installs the migration via
`openreceive:install` with an engine-owned model; Node apps run
`npx openreceive scaffold payments` (Prisma, Drizzle, TypeORM, Sequelize, or Knex;
`--dialect postgres` or `sqlite`) to emit the migration only. A custom
`OpenReceivePaymentRepository` is the documented escape hatch, never the quickstart.

Each payment row represents one direct payment attempt or one provider swap attempt, with an
explicit status (`pending | settled | expired | failed | attention`). An order has one live
payment session with at most one live attempt per rail/asset. Host sessions, fulfillment state,
and send-payment methods remain outside the product.
