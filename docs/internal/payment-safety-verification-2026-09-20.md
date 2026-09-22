# Payment safety implementation verification — 2026-09-20

Reviews later found defects in this implementation. The
[September 21 follow-up](payment-safety-verification-2026-09-21.md) records
those defects, their fixes and the expanded acceptance runs. The results
below are historical. On their own they do not show that those findings are closed.

This page verifies `zz-astra-sep20-fixes.txt`, findings F01–F20. It is evidence
about the source implementation. It is not a release, and it does not claim that
existing installations have been repaired. See the
[upgrade and repair guide](../guides/payment-safety-upgrade.md).

- Demo applications and database services ran in Docker.
- Commands below ran from the repository root unless another working directory is stated.
- Database URLs refer only to disposable local test services.

## Repository checks

| Command | Result |
| --- | --- |
| `npm run test:ci` | Passed, including all language, package, demo and standalone artifact checks. |
| `npm run typecheck` | Passed. |
| `npm test` | 713 passed, zero skipped. |
| `npm run check` | Contract/vector, secret and naming checks passed. |
| `npm run build:packages` | All 15 packages and the standalone checkout built. |
| `npm run build:docs` | Generated documentation and packaged skill mirrors passed. |
| `git diff --check` | Passed. |

The combined gate also covers:

- lint and formatting
- generated contracts and documentation
- public API snapshots
- Vue/Svelte compilation
- dead exports
- package installation smoke tests (all fifteen passed)
- all five language suites
- demo builds
- client bundle scanning
- standalone artifact verification

The run printed some output that did not fail it:

- six Biome warnings
- Node's experimental SQLite notice
- Svelte configuration discovery messages about unrelated Laravel vendor Vite files, whose optional Tailwind plugin is absent

Svelte's checked project reports zero errors and zero warnings.

Earlier combined runs found an unused Node re-export. They also found PHP
conformance fixture adapters that lost object/list identity or used fixed-size
offsets. We fixed both. The PHP harness now checks that unusable pages are
rejected and counts skipped rows physically. Neither failure was suppressed or excluded.

## JavaScript and browser boundaries

```sh
OPENRECEIVE_TEST_POSTGRES_URL=postgresql://postgres@127.0.0.1:15432/openreceive_test npm run test:orms
LOG_LEVEL=error node --import tsx --test tests/browser-payment-lifetime.test.mjs tests/element-lifecycle.test.mjs tests/react-checkout-behavior.test.mjs
OPENRECEIVE_E2E_BASE_URL=http://127.0.0.1:14173 npx playwright test --config tests/e2e swap.spec.ts
OPENRECEIVE_E2E_BASE_URL=http://127.0.0.1:14173 npx playwright test --config tests/e2e checkout-identity.spec.ts
```

Results:

- ORM suite: 4 passed, zero skipped. This includes real Knex PostgreSQL bindings and transactions.
- Focused browser suite: 61 passed.
- Docker swap E2E: 2 passed. The Docker reference-switch regression also passed.

These tests cover two scenarios:

- The deposit expires, and then the wallet settles, or refund entry and confirmation follow.
- A really mounted element rejects an old order's delayed invoice and settlement while a new order is loading.

Mounted wrapper tests in the full JS suite cover identity changes in Vue, Svelte
and Angular. The 713-test suite also covers cancellation, restart and progress,
transaction rollback, repair replay, and repository-backed HTTP goldens.

## Python and Ruby

```sh
PYTEST_ADDOPTS='-o addopts="-p no:cacheprovider"' npm run test:python
OPENRECEIVE_TEST_PGSQL_URL=postgresql://postgres@127.0.0.1:15432/openreceive_test \
OPENRECEIVE_TEST_MYSQL_URL=mysql+pymysql://root@127.0.0.1:13306/openreceive_test \
packages/python/openreceive/.venv/bin/python -m pytest \
  packages/python/openreceive/tests/storage packages/python/openreceive/tests/django \
  -o addopts='-p no:cacheprovider' -q
docker run --rm -v "$PWD:/work:ro" \
  -e UV_PROJECT_ENVIRONMENT=/tmp/openreceive-venv \
  -e OPENRECEIVE_TEST_DJANGO_MYSQL_URL=mysql://root@host.docker.internal:13306/openreceive_test \
  openreceive-python-db:sep20 sh -c \
  'uv sync --project /work/packages/python/openreceive --frozen --no-install-project --quiet && uv pip install --python /tmp/openreceive-venv/bin/python mysqlclient --quiet && /tmp/openreceive-venv/bin/python -m pytest /work/packages/python/openreceive/tests/django -o addopts="-p no:cacheprovider" -q --maxfail=3'
npm run test:ruby
docker run --rm -v "$PWD:/work:ro" \
  -e OPENRECEIVE_TEST_PGSQL_URL=postgresql://postgres@host.docker.internal:15432/openreceive_test \
  -e OPENRECEIVE_TEST_MYSQL_URL=mysql://root@host.docker.internal:13306/openreceive_test \
  openreceive-ruby-db:sep20 ruby \
  -Ipackages/ruby/openreceive/lib -Ipackages/ruby/openreceive-server/lib \
  -Ipackages/ruby/openreceive-rails/lib \
  packages/ruby/openreceive-rails/test/repository_dialects_test.rb
```

- Python default: 459 passed, one MySQL-only skip. Conformance, Ruff and mypy
  (87 files) passed. There were two upstream deprecation warnings, from Starlette/httpx and AnyIO.
- SQLAlchemy on SQLite/PostgreSQL/MySQL plus Django on PostgreSQL: 139 passed, one
  MySQL-only skip. In both runs the skipped test is
  `test_mysql_rejects_nested_reference_operation_before_acquiring_lock`, which only
  runs in the Django MySQL lane. It passed in that lane.
- Django MySQL: 46 passed, two intentional skips for after-commit behavior with an
  outer transaction or savepoint. On MySQL, the repository rejects unsupported ambient
  transactions (ones the host opened) before taking its lock. That rejection passed,
  and so did after-commit behavior on the configured database alias.
- Ruby default: 282 tests, 1,797 assertions, zero failures or errors. Two dialect
  tests skipped because the database URLs were unset. Conformance passed.
- Ruby real PostgreSQL/MySQL: we ran the two skipped tests separately and they passed,
  2 tests/24 assertions, zero skips. They cover competing settlements, gate
  claims, transition locking and MySQL ambient-transaction rejection.

## PHP

```sh
npm run test:php
```

Default suites:

- Laravel: 21 tests/122 assertions.
- OpenReceive: 109 tests/1,103 assertions.
- WordPress: 2 tests/6 assertions.

Cross-language conformance passed.

From `packages/php/openreceive`:

```sh
OPENRECEIVE_TEST_PGSQL_DSN='pgsql:host=127.0.0.1;port=15432;dbname=openreceive_test' \
OPENRECEIVE_TEST_PGSQL_USER=postgres \
OPENRECEIVE_TEST_MYSQL_DSN='mysql:host=127.0.0.1;port=13306;dbname=openreceive_test' \
OPENRECEIVE_TEST_MYSQL_USER=root vendor/bin/phpunit
vendor/bin/phpstan analyse --debug
```

On SQLite/PostgreSQL/MySQL, 147 tests/1,431 assertions passed, and static
analysis passed. The run includes races between forked processes for repair,
settlement and the gate, and failover tests for signed/encrypted relays. There
were no intentional skips.

## BTCPay and .NET

```sh
OPENRECEIVE_DOTNET_POSTGRES='Host=host.docker.internal;Port=15432;Database=btcpay_safety;Username=postgres' npm run test:dotnet -- --logger 'trx;LogFileName=safety.trx'
CONFIG=Debug bash packages/dotnet/docker/build-plugin.sh
npx --no-install playwright test --config tests/e2e-btcpay/playwright.config.ts payment-safety.spec.ts
npx --no-install playwright test --config tests/e2e-btcpay/playwright.config.ts payment-safety.spec.ts --grep 'historical BTC-LN survives partial remint and restart$'
```

Results: 353 tests passed with real PostgreSQL, zero skips. The plugin build
passed. Seven Docker E2E scenarios and the final-build Lightning smoke test passed.

Coverage includes:

- LN/LNURL partial remint and restart across expiry
- refund links for retired swaps
- missing and ambiguous mappings
- legacy and foreign account scope
- failed host insertion
- accounting replay
- additive migrations
- real `xmin` row versioning
- competing leases
- replacement rollback

The provider fairness test runs 400 orders over at least three budget windows,
with real HTTP requests, real 429 responses, and a restart.

The default combined .NET run leaves the PostgreSQL variable unset. There, 351
tests pass and two PostgreSQL tests skip. The explicit 353-test run above covers both.

## Live wallet and operational limits

```sh
OPENRECEIVE_LIVE_CREATE_INVOICE=0 OPENRECEIVE_LIVE_WAIT_FOR_PAYMENT=0 npm run test:live:nwc
OPENRECEIVE_LIVE_CREATE_INVOICE=0 OPENRECEIVE_LIVE_WAIT_FOR_PAYMENT=0 npm run test:live:php:nwc
```

Both configured receive-only preflights passed. A separate, bounded, read-only
Node history request passed through the cancellable transport without logging
payloads. We deliberately disabled live invoice creation and payment waiting.
We tested delayed settlement and refunds with controlled testkit services.
Chromium and Docker needed the approved execution environment. No sandbox denial
remains unresolved. We published no packages and no BTCPay plugin.

Recovery still needs decisions that the host reviews. These limits remain:

- A dense resumed history cannot prove that a payment is absent.
- Unsupported MySQL ambient transactions fail with an explicit error.
- External callbacks after commit remain best effort.
- The plugin's provider budgets apply per process and per configured connection.

The upgrade guides document these limits instead of hiding them behind a passing
aggregate test.
