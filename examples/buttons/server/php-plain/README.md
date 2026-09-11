# Buy a Button — plain PHP

See Bitcoin Lightning checkout in a PHP shop without a web framework.
A front controller, a PDO database handle, and three host methods connect
the packaged PHP engine to orders and fulfillment.

OpenReceive supports optional swaps from **USDT, USDC, SOL, and ETH** through
a configured swap provider. The provider converts the payment to **BTC over
Lightning**, which settles into the merchant's connected wallet. Available
assets and networks depend on the provider; swaps are optional.

For your own app, start with the [integration quickstart](../../../../docs/guides/quickstart-php.md).
Run demo servers and backing services in Docker. Development-process commands
below are for a Docker environment; builds and test runners may run on the host.

```sh
npm run demo php               # Docker, :3008
cd examples/buttons/server/php-plain && npm run dev    # Vite + php -S, :3008
```

## Why this demo exists

To prove the Composer package works with **nothing** around it: no Laravel, no
PSR-15 middleware stack, no dependency container, no bundler on the page. A
PDO handle, a `Host` with three methods, `Engine`, and a path switch are the
whole integration. If it holds here, the framework adapters are conveniences,
not requirements.

It is also the reference for the **standalone checkout build**. A plain-PHP
host has no JS bundler, so the payment step is the
`standalone-checkout-<version>.tar.gz` attached to every release — one
self-contained ES module, its stylesheet and the provider assets — unpacked
under the web root. This demo uses the in-repo build of that same tarball:
`vite.config.ts` copies `packages/js/elements/dist/standalone/` into
`public/openreceive/` (gitignored; `npm run build:packages` writes the source),
`index.html` links the stylesheet, and the shared client's
`@openreceive/elements` import is pointed at the copied file. The vanilla shop
runs unchanged; only where the element comes from differs.

## The server, in one file

`public/index.php` is a 180-line front controller:

- **Static files first.** `php -S` calls this file for every request; anything
  that exists under `public/` — the built shop, the standalone checkout —
  makes it `return false`, and the built-in server serves the file itself.
- **The three hooks** are an anonymous `OpenReceive\Host`. `authorize` reads
  the signed `shop_user_id` cookie off the PSR-7 request and checks the order
  belongs to this browser; `amountFor` prices from the shop's own order row and
  returns the description the checkout renders; `onPaid` runs the guarded
  `awaiting_payment → paid` UPDATE on `$settlement->connection` — the
  settlement transaction — so the flip commits with the payment record.
- **The engine** is `new Engine($host, new SqlPaymentRepository(new PdoConnection($pdo)), $service)`
  and `$engine->psr15Handler()->handle($request)`, with `nyholm/psr7-server`
  building the request. Every payment route first runs the gated
  opportunistic reconcile — the gate is a row in `openreceive_meta`, so a
  fleet of PHP processes shares one wallet-scan budget with nothing in memory.
- **The shop's own API** — `/shop/bootstrap`, `/shop/orders`,
  `/shop/orders/:reference`, `/shop/orders/:reference/downloads/:sku`,
  `/shop/recent_orders` — is `src/ShopRoutes.php` over `src/Store.php`, route
  for route and payload for payload the same as the Node stacks'
  `shared/server-node`, which is what lets the vanilla client run unchanged.
- **`/images/*`** is the one copy of the artwork, outside the docroot; the SPA
  fallback (`/checkout/:reference` included) is `public/index.html`.

**No CSRF layer.** Plain PHP ships none, exactly like Express; the engine's own
`Sec-Fetch-Site: cross-site` refusal is the protection, and `bin/ci` proves it
answers 403. `<meta name="csrf-token">` is optional here.

## `php -S` is a development server

This image runs `php -S` with a few forked workers (`PHP_CLI_SERVER_WORKERS`),
which is enough for a demo and is NOT a deployment: it has no TLS, no request
limits, and a single accept loop. A deployment puts PHP-FPM behind nginx, or
Apache with `mod_php`, in front of the same `public/index.php` with rewrites
to it — nothing in the file changes. The engine's "settlement discovery is
shared by every worker" claim is what makes that move free: the reconcile gate
never lived in the process.

Every PHP request starts from nothing. That is why the engine keeps the gate
in the database rather than in memory, and it is why **testkit mode has to
persist its fakes** (below) where a long-lived Node or Python process simply
keeps them.

## The boundary

**The browser never receives your NWC code.** `NWC_URI` is read by
`Service::fromEnvironment()` on the server for the engine routes only, and no
part of it reaches a bundle, a log or an asset. The payer's browser talks to
the mounted OpenReceive routes; the wallet connection stays on this side of
them.

Persistence is host-owned in the same way. The shop's four tables and the
engine's two live in ONE local SQLite database that this application opens —
`OPENRECEIVE_DEMO_DB` names the directory, `/data` in the container, a named
volume in compose so orders survive `docker compose restart`. OpenReceive
brings no datastore of its own; migration `004` renders its DDL with
`PaymentsSchema::statements('sqlite')` and the store runs it like any other
step.

## Running it with no wallet

```sh
DEMO_WALLET=testkit npm run dev     # no NWC_URI, no LSC keys, no network
```

Testkit mode replaces THREE THINGS — the wallet, the swap provider and the
price feed — with the engine's own `OpenReceive\Testing\FakeWallet`,
`FakeSwapProvider` and `Rates\StaticPriceProvider`, and nothing else. The
fakes follow the shared [testkit contract](../../../../docs/internal/testkit-contract.md):
payment hashes are the mint counter in 64 hex characters, `testkit-swap-N`
orders, the Tron address `T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb`, BTC at a static
$50,000 so a $1.00 button is 2,000 sats — which is what lets the one Playwright
suite drive this stack (`OPENRECEIVE_E2E_STACK=php-plain npm run test:e2e:smoke`).

The control surface is the one every stack mounts, and a JSON 404 in any other
mode:

- `POST /__testkit/settle { payment_hash }`
- `POST /__testkit/expire { payment_hash }`
- `POST /__testkit/swap-step { provider_order_id | pay_in_asset, state }`
- `GET /__testkit/state`

`src/Testkit.php` is where PHP differs: it serialises the fakes' state to
`<data dir>/php-plain.testkit` after every request and restores it before the
next, under a lock held for the request, because a fake wallet that forgot
its invoices between requests would settle nothing.

## Development

```sh
composer install                # the engine by path repository, nyholm/psr7(-server)
npm run dev                     # Vite on :3008 spawns php -S on :3108 and proxies
                                # /shop, /openreceive, /images and /__testkit to it
bin/ci                          # composer validate, php -l, catalog drift, the
                                # shared-boundary check, an HTTP order→settle→download smoke
bin/doctor                      # the credential/mount/preflight report, no values
```

`npm run dev` needs the standalone build to exist (`npm run build:packages` at
the repository root writes it) and runs `composer install` itself when
`vendor/` is missing.
