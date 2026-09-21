# Payment safety implementation verification — 2026-09-20

The [September 21 follow-up](payment-safety-verification-2026-09-21.md) records
review-discovered defects, their corrections and the expanded acceptance runs.
The historical results below alone do not establish closure of those findings.

Verification for `zz-astra-sep20-fixes.txt`, findings F01–F20. This is source
implementation evidence, not a release or a claim that existing installations
have been repaired. See the [upgrade and repair guide](../guides/payment-safety-upgrade.md).
Demo applications and database services ran in Docker. Commands below ran from
the repository root unless another working directory is stated. Database URLs
refer only to disposable local test services.

## Repository checks

| Command | Result |
| --- | --- |
| `npm run test:ci` | Passed, including all language, package, demo and standalone artifact checks. |
| `npm run typecheck` | Passed. |
| `npm test` | 713 passed, zero skipped. |
| `npm run check` | Contract/vector, secret and naming checks passed. |
| `npm run build:packages` | All 15 packages and standalone checkout built. |
| `npm run build:docs` | Generated documentation and packaged skill mirrors passed. |
| `git diff --check` | Passed. |

The combined gate also covers lint/formatting, generated contracts, documentation,
public API snapshots, Vue/Svelte compilation, dead exports, package installation
smoke tests, all five language suites, demo builds, client bundle scanning and
standalone artifact verification. Fifteen package installation smoke tests passed.
Nonfatal output includes six Biome warnings, Node's experimental SQLite notice,
and Svelte configuration discovery messages for unrelated Laravel vendor Vite
files whose optional Tailwind plugin is absent. Svelte's checked project reports
zero errors and zero warnings.

Earlier combined runs identified an unused Node re-export and PHP conformance
fixture adapters that lost object/list identity or used fixed-size offsets.
These were corrected; the PHP harness now checks unusable-page rejection and
physical skipped-row counts. Neither failure was suppressed or excluded.

## JavaScript and browser boundaries

```sh
OPENRECEIVE_TEST_POSTGRES_URL=postgresql://postgres@127.0.0.1:15432/openreceive_test npm run test:orms
LOG_LEVEL=error node --import tsx --test tests/browser-payment-lifetime.test.mjs tests/element-lifecycle.test.mjs tests/react-checkout-behavior.test.mjs
OPENRECEIVE_E2E_BASE_URL=http://127.0.0.1:14173 npx playwright test --config tests/e2e swap.spec.ts
OPENRECEIVE_E2E_BASE_URL=http://127.0.0.1:14173 npx playwright test --config tests/e2e checkout-identity.spec.ts
```

Results: ORM suite 4 passed, zero skipped, including actual Knex PostgreSQL
bindings and transactions; focused browser suite 61 passed; Docker swap E2E
2 passed, plus the Docker reference-switch regression passed. These cover deposit
expiry followed by wallet settlement or refund entry and confirmation, and a real
mounted element rejecting an old order's delayed invoice and settlement while a
new order is loading. Mounted wrapper tests in the full JS suite cover
Vue, Svelte and Angular identity changes. Cancellation, restart/progress,
transaction rollback, repair replay and repository-backed HTTP goldens are part
of the 713-test suite.

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

- Python default: 459 passed, one MySQL-only skip; conformance, Ruff and mypy
  (87 files) passed. Two upstream Starlette/httpx and AnyIO deprecation warnings.
- SQLAlchemy SQLite/PostgreSQL/MySQL plus Django PostgreSQL: 139 passed, one
  MySQL-only skip. Both skips are
  `test_mysql_rejects_nested_reference_operation_before_acquiring_lock` outside
  the Django MySQL lane; it passed in that lane.
- Django MySQL: 46 passed, two intentional skips for outer-transaction/savepoint
  after-commit behavior. MySQL rejects unsupported ambient transactions before
  locking; that rejection and configured-alias after-commit behavior passed.
- Ruby default: 282 tests, 1,797 assertions, zero failures/errors, two dialect
  skips because database URLs were unset; conformance passed.
- Ruby real PostgreSQL/MySQL: both skipped tests ran separately and passed,
  2 tests/24 assertions, zero skips. Includes competing settlements, gate
  claims, transition locking and MySQL ambient-transaction rejection.

## PHP

```sh
npm run test:php
```

Default suites: Laravel 21 tests/122 assertions; OpenReceive 109 tests/1,103
assertions; WordPress 2 tests/6 assertions. Cross-language conformance passed.

From `packages/php/openreceive`:

```sh
OPENRECEIVE_TEST_PGSQL_DSN='pgsql:host=127.0.0.1;port=15432;dbname=openreceive_test' \
OPENRECEIVE_TEST_PGSQL_USER=postgres \
OPENRECEIVE_TEST_MYSQL_DSN='mysql:host=127.0.0.1;port=13306;dbname=openreceive_test' \
OPENRECEIVE_TEST_MYSQL_USER=root vendor/bin/phpunit
vendor/bin/phpstan analyse --debug
```

SQLite/PostgreSQL/MySQL: 147 tests/1,431 assertions passed; static analysis passed.
Includes forked repair/settlement/gate
races and signed/encrypted relay failover tests. No intentional skips.

## BTCPay and .NET

```sh
OPENRECEIVE_DOTNET_POSTGRES='Host=host.docker.internal;Port=15432;Database=btcpay_safety;Username=postgres' npm run test:dotnet -- --logger 'trx;LogFileName=safety.trx'
CONFIG=Debug bash packages/dotnet/docker/build-plugin.sh
npx --no-install playwright test --config tests/e2e-btcpay/playwright.config.ts payment-safety.spec.ts
npx --no-install playwright test --config tests/e2e-btcpay/playwright.config.ts payment-safety.spec.ts --grep 'historical BTC-LN survives partial remint and restart$'
```

353 tests passed with real PostgreSQL, zero skips; plugin build passed; seven
Docker E2E scenarios and the final-build Lightning smoke passed. Coverage includes
LN/LNURL partial remint/restart across expiry, retired-swap refund links, missing
and ambiguous mappings, legacy and foreign account scope, failed host insertion,
accounting replay, additive migrations, actual `xmin`, competing leases and
replacement rollback. Provider fairness exercises 400 orders over at least three
budget windows with real HTTP requests/429s and restart.

The default combined .NET run leaves the PostgreSQL variable unset, so 351 pass
and two PostgreSQL tests skip; the explicit 353-test run above covers both.

## Live wallet and operational limits

```sh
OPENRECEIVE_LIVE_CREATE_INVOICE=0 OPENRECEIVE_LIVE_WAIT_FOR_PAYMENT=0 npm run test:live:nwc
OPENRECEIVE_LIVE_CREATE_INVOICE=0 OPENRECEIVE_LIVE_WAIT_FOR_PAYMENT=0 npm run test:live:php:nwc
```

Both configured receive-only preflights passed. A separate bounded read-only Node
history request passed through the cancellable transport without logging payloads.
Live invoice creation and payment waiting were intentionally disabled; delayed
settlement and refunds were tested with controlled testkit services. Chromium and
Docker required the approved execution environment. No unresolved sandbox denial
remains. No packages or BTCPay plugin were published.

Recovery still requires reviewed host decisions. Dense resumed history cannot
prove absence; unsupported MySQL ambient transactions fail explicitly;
post-commit external callbacks remain best effort; plugin provider budgets are
per process/configured connection. These limitations are documented in the
upgrade guides rather than hidden behind a passing aggregate test.
