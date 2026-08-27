# Buy a Button — Rails + Postgres

Rails 8.1, Postgres, Shakapacker + webpack, Minitest, uuid primary keys. The
shop UI comes from [`../../shared`](../../shared); this directory is the host:
its routes, its models, its migrations, its build.

See [`../../README.md`](../../README.md) for what the demo is and why the
boundary falls where it does.

## Running it

From the repository root, in Docker:

```sh
cp -n .env.example .env      # set a receive-only NWC_URI
npm run demo buttons         # http://localhost:3003
```

For an edit-reload loop, from this directory:

```sh
bin/setup                    # bundle, create the database, migrate, seed
bin/dev                      # Puma on :3003 + the Shakapacker dev server
```

`bin/dev` needs the webpack dev server actually running — `compile: false` in
development means there is no lazy compile-on-request fallback, and a
stale-looking page is usually a dead webpack process rather than a cache bug.

**The browser never receives your NWC code.** It is read from the
repository-root `.env` by server code only, and no part of it reaches a bundle,
a log or an asset.

## Persistence is host-owned

This app owns its Postgres database. OpenReceive has no database configuration
of its own — the engine's two tables (`openreceive_payments`,
`openreceive_meta`) live in this same host database, created by the migration
the install generator produced.

Four tables are ours:

| table | what it is |
| --- | --- |
| `shop_products` | the price authority. Read fresh on every order creation — never memoized. |
| `shop_users` | a visitor. Two uuids, two timestamps, no credentials. |
| `shop_orders` | one cart checkout. `id` IS the OpenReceive reference. |
| `shop_order_items` | one sku on one order, with name and price SNAPSHOTTED beside a nullable product FK. |

The snapshots are why deactivating or deleting a product cannot break a receipt,
a download or a feed row somebody already paid for, and why renaming a product
does not retroactively rewrite the public order history.

## Where to read

| file | what it decides |
| --- | --- |
| `config/initializers/openreceive.rb` | the three hooks. The whole bridge. |
| `app/models/shop_order.rb` | `claim_paid!` — the guarded UPDATE the money rests on. |
| `app/controllers/concerns/shop_identity.rb` | the signed cookie, and why `find_by` rather than `find`. |
| `app/controllers/shop_controller.rb` | `normalized_lines` (the trust boundary) and the two payload builders that must never converge. |
| `config/initializers/assets.rb` | how one images directory serves four stacks with digested URLs. |
| `app/channels/shop_order_channel.rb` | why a settlement push is authorized, and why its envelope is empty. |
| `config/cable.yml` | why the cable adapter is database-backed rather than in-memory. |

## The artwork

`examples/buttons/images` holds the only copy of the six product files. It is on
the Propshaft load path (`config/initializers/assets.rb`), which is what makes
`asset_path("openreceive-signal-red-button.webp")` return a digested URL — and
in turn why the catalog ships from the server in the bootstrap payload rather
than being a constant in the bundle: the browser could not derive that URL and
must not be allowed to supply it.

There is no ActiveStorage. Six static files that ship in the repo; the table
stores FILENAMES.

## The two processes

`compose.yml` runs the same image twice:

| service | command | what it is |
| --- | --- | --- |
| `buttons-rails` | the image default (Puma) | the web process |
| `notifications` | `rails openreceive:notifications` | the long-running worker |

The worker listens for NWC-02 `payment_received` from the wallet and runs a
periodic reconcile pass in the same process — the safety net for notifications
missed while it was down. It is the engine's only long-lived task; a one-shot
`openreceive:reconcile` exists but scheduling it beside this would duplicate the
thread already running here.

That worker settles orders in a process holding none of the payers' websockets,
which is exactly why `config/cable.yml` uses solid_cable: the broadcast reaches
Puma through the database both containers already share.

Locally, `bin/dev` runs only Puma. Settlement still pushes — the web process
settles on the payer's own `payments/check` call — so the cable path is fully
exercised without the worker.

## Tests

```sh
bin/rails test    # the suite
bin/ci            # setup, the suite, three drift/boundary checks, the gem audit
npx tsc --noEmit -p .   # the ONLY typecheck — swc-loader strips types without checking them
```

`bin/ci` also runs:

- `script/check-migration-drift.rb` — the committed openreceive migration is a
  snapshot of the install generator's template; this re-renders and diffs it.
- `script/check-catalog-artwork.mjs` — every row in `shared/shop-catalog.json`
  names a file that exists in `examples/buttons/images`.
- `script/check-shared-boundary.rb` — this stack may import
  `shared/shop-types.ts` and `shared/client/**`, and never
  `shared/server-node/**`.

The one test that is not automated is the acceptance demo in
[`../../README.md`](../../README.md). It is run by hand, by a person, in two
real browsers, and nothing replaces it.

## Build failure modes, ranked by how long they cost

1. A missing `observer` on a component. State correct, screen frozen.
2. A mutation after an `await` outside a `@modelAction`. Runtime throw.
3. `data-selected={false}` instead of `cond || undefined` — the attribute
   renders as the string "false", `[data-selected]` matches it, and everything
   looks selected.
4. A computed reading `CheckoutSession` without the `void this.sessionTick`
   line. The spinner never stops and there is no error anywhere.
5. A new flex child with no `min-height: 0`. The panel grows, the page jumps.
6. `frozen()` omitted on a foreign wire object stored in a prop.
7. **A type error that never surfaced.** Shakapacker compiles TypeScript with
   swc-loader, which strips types WITHOUT CHECKING them: a type error does not
   fail the build and does not appear in the browser. `npx tsc --noEmit` is the
   only typecheck.
8. `compile: false` in development — the dev server must actually be running.
9. A cable adapter that is not database-backed. Every broadcast from the
   `notifications` container is silently dropped, and the demo looks like it is
   merely polling.
