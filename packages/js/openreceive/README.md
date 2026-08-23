# openreceive

The `openreceive` command-line tool. The library itself ships as the
`@openreceive/*` packages: install the adapter for your server and the UI
package for your frontend, and the rest comes along as dependencies.

```sh
npm install @openreceive/express @openreceive/react
```

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
