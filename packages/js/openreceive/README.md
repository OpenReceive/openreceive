# openreceive

Set up and inspect your OpenReceive payment integration from the command
line. Generate payment-table migrations for your ORM and check your
receive-only wallet connection with `openreceive scaffold` and
`openreceive doctor`. The payment libraries ship as the `@openreceive/*`
packages; choose the adapter for your server and the UI for your frontend.

OpenReceive supports optional swaps from **USDT, USDC, SOL, and ETH** through
a configured swap provider. The provider converts the payment to **BTC over
Lightning**, which settles into the merchant's connected wallet. Available
assets and networks depend on the provider; swaps are optional.

```sh
npm install @openreceive/express @openreceive/react
```

Those two are an example, not a requirement. Swap `@openreceive/express` for
`@openreceive/fastify` or `@openreceive/next`, and `@openreceive/react` for
`@openreceive/vue`, `@openreceive/svelte`, `@openreceive/angular`, or
`@openreceive/elements` (framework-free custom element). On Rails, use the
`openreceive-rails` gem instead of a Node adapter.

See the [Node quickstart](https://github.com/openreceive/openreceive/blob/master/docs/guides/quickstart-node.md).

This package is ESM-only and requires Node >= 22.

## Use

No install needed:

```sh
npx openreceive scaffold payments --orm prisma   # or drizzle | typeorm | sequelize | knex
npx openreceive doctor
```

- `scaffold payments` emits the `openreceive_payments` and `openreceive_meta`
  schema/migration for your ORM plus a wiring guide; it never touches a
  database.
- `doctor` checks the environment and the receive-only NWC connection.

The command is implemented in `@openreceive/node` (`@openreceive/node/cli`).
This package exists so that `npx openreceive` resolves under every package
manager, including the ones that never hoist a transitive dependency's bin.

## License

MIT
