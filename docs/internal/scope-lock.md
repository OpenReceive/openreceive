# Host-owned persistence boundary

The supported boundary is receive-only NWC invoice creation/verification, stateless mounted
routes, exact fiat conversion, passive notifications plus reconciliation, and optional
server-side swap recovery/refunds.

OpenReceive runtime packages do not accept database or Redis URLs, run migrations, own a
storage adapter, or use durable workflow cursors. The host owns its orders and a small
`openreceive_payments` attempt table.
Rails may scaffold that host model and migration; Node apps run
`npx openreceive scaffold payments` for Prisma, Drizzle, TypeORM, Sequelize, or Knex
(`--dialect postgres` or `sqlite`). Both
remain ordinary host application code.

Each payment row represents one direct payment attempt or one provider swap attempt. An order may
have many historical rows but only one live unpaid row. Host sessions, fulfillment state,
send-payment methods, and OpenReceive-owned persistence remain outside the product.
