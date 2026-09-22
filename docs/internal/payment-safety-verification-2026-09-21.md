# Payment safety review closure — 2026-09-21

We checked the reviews in `zz-cursor-sep21.txt` and `zz-kimi-sep21.txt` against the
F01–F20 requirements in `zz-astra-sep20-fixes.txt`. The September 20 implementation
still had defects, even though its aggregate checks passed. This follow-up fixes
them and extends the acceptance evidence below. It verifies source only. Existing
installations still need the [coordinated upgrade and reviewed recovery
procedure](../guides/payment-safety-upgrade.md). We published no packages and no plugin.

## Review disposition

| Requirement | Correction or additional verification |
| --- | --- |
| F01 | Node accepts wallet-deadline snapshots in camelCase and in legacy snake_case, including where the timestamp came from. A malformed snapshot fails with a storage error that contains no secrets. Deposit expiry stays a separate value. |
| F02, F09 | New explicit tests cover: the provider completes while the wallet is still pending; the wallet fails and refund recovery follows; stale staging or confirmation replies arrive after the controller is disposed. The existing mounted element, React and wrapper tests and the Docker identity-switching test stay green. |
| F03, F04, F08 | With Django `ATOMIC_REQUESTS`, `after_paid` waits until the request commits. PHP keeps the wallet finality it observed when fulfillment rolls back, so it no longer falsely expires the attempt after grace. PHP and Ruby test a failing payment next to a sibling hash that commits successfully. Real PostgreSQL tests cover atomic Node host writes and rollback. |
| F05, F12 | If the listener is disposed exactly between dequeue and the channel write, the mint is kept for cold recovery. Testkit mints lowercase hashes but emits settled history and authenticated notifications in uppercase. BTCPay acceptance feeds those responses through historical LN/LNURL recovery, partial remints and restarts. |
| F06, F10, F20 | If a provider refresh fails, the old order stays exposed and replacement is refused. The existing real PostgreSQL tests for migrations, `xmin` and leases, the provider-budget fairness tests, and the Docker refund recovery for retired swaps all pass. |
| F07 | The active batch is removed from its durable queue before any I/O. So two historical batches that always fail cannot fill every slot. A short repository page makes the scan wrap around to the start. So a steady stream of new arrivals cannot keep pushing back fulfillment retries for old attempts. Shared vectors cover both failures, and coverage that crosses the expiry-grace boundary. A PostgreSQL stress test adds 20 attempts per pass behind 401 existing attempts, recreates worker connections, fails two scans and one fulfillment, and checks that settlement is eventually committed under the shared gate. |
| F11 | Real Knex PostgreSQL tests pass for bindings, transaction identity, concurrency and rollback. A dedicated CI job now provides PostgreSQL and runs `npm run test:orms` on every push and PR. |
| F13 | Python passes the remaining monotonic scan deadline through negotiation, connection and the history RPC. Ruby bounds only wallet RPC I/O, including blocking reads backed by Async. Explicit Node and PHP tests prove that workers settle payments when HTTP opportunistic reconciliation is disabled. |
| F14, U1–U6 | The cross-engine suites still cover the existing reviewed paths: maintenance/requeue, audit, immutable settlement and upgrade. We added no automatic rewrite of historical terminal rows. |
| F15 | Direct Ruby and Node FixedFloat hooks receive only allowlisted metadata before anything reaches a host sink. Create, status and refund tests keep the real credentials in provider calls, keep them out of diagnostics, and prove that a throwing logger does not break anything. |
| F16–F18 | These stay green: authorization before the client is constructed, handling of scalar and unusable history, physical pagination, and PHP relay failover acceptance. |
| F19 | Node refuses a saved refund network that is missing, null, not a string or unknown. It answers 503 `INTERNAL` before any status or refund call to the provider. Checksum handling for valid networks is unchanged. |

The scheduler's metadata format and the payment tables are unchanged. Custom
repositories must fill the requested page with up to 200 pending rows, unless fewer
remain after the cursor. A short repository page now signals wraparound.
This does not change the wallet-history rule. A short wallet page is never
automatically evidence that the wallet history ended.

## Combined gate and focused checks

Commands ran from the repository root unless stated otherwise. The database URLs
below point at disposable local Docker services, not deployed infrastructure.

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed. |
| `npm run test:ci` | Passed: contracts/secrets, lint/format, docs/generated files, public API, JS/framework tests, all engines, package/demo builds and artifact checks. |
| `npm test` (within `test:ci`) | 722 passed, zero skipped. |
| `npm run check` (within `test:ci`) | Passed, including every consumer of the progress vectors. |
| `npm run test:ruby` (within `test:ci`) | 288 tests, 1,846 assertions, zero failures/errors. Two external-dialect skips were run separately below. |
| `npm run test:python` (within `test:ci`) | 466 collected, 465 passed. One MySQL-only skip was run in the MySQL lane. Conformance passed. |
| `npm run test:php` (within `test:ci`) | Core: 111 tests/1,136 assertions; Laravel: 21/122; WordPress: 2/6; conformance passed. |
| `npm run test:dotnet` (within `test:ci`) | 353 passed. Two external-PostgreSQL skips were run separately below. |
| `npm run build:docs` and `npm run check:docs` | Regenerated the site contract. All documentation and skill mirrors agree. |
| `packages/python/openreceive/.venv/bin/ruff check packages/python/openreceive` | Passed. |
| `packages/python/openreceive/.venv/bin/ruff format --check packages/python/openreceive` | 140 files formatted correctly. |
| `.venv/bin/mypy` from `packages/python/openreceive` | Passed, 90 source files. |
| `vendor/bin/phpstan analyse --no-progress` from `packages/php/openreceive` | Passed. |
| `git diff --check` | Passed. |

We ran focused regressions before the full gate:

- `tests/swap-address.test.mjs`, `tests/settlement-recovery.test.mjs`,
  `tests/reconcile-progress.test.mjs`, `tests/opportunistic-reconcile.test.mjs`,
  `tests/browser-payment-lifetime.test.mjs`, `tests/fixedfloat.test.mjs`, and the
  provider logging/failover tests, through `node --import tsx --test`.
- Python payment-safety, receive-client deadline and Django view tests, through pytest.
- PHP `vendor/bin/phpunit --filter PaymentSafetyTest`.
- Ruby `nwc_ruby_test.rb`, the provider diagnostic tests and `rails_test.rb --name
  '/PaymentSafetyProgress/'`.
- The focused .NET provider-refresh test.

Each new regression test first reproduced its bug: unsafe refund acceptance, the
alias failure, raw diagnostic payloads, PHP false closure, and starvation under
continuous arrivals. Intermediate combined checks also caught a test fixture that
looked like a credential and a stale generated documentation index. We fixed these
without weakening the scanners or excluding tests. Some existing output does not
fail the run: Biome warnings, Node's SQLite notice, two upstream Python
deprecations, and unrelated vendor Vite configuration discovery messages.

## Actual database acceptance

```sh
OPENRECEIVE_TEST_POSTGRES_URL=postgresql://postgres@127.0.0.1:15432/openreceive_test npm run test:orms

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

docker run --rm -v "$PWD:/work:ro" \
  -e OPENRECEIVE_TEST_PGSQL_URL=postgresql://postgres@host.docker.internal:15432/openreceive_test \
  -e OPENRECEIVE_TEST_MYSQL_URL=mysql://root@host.docker.internal:13306/openreceive_test \
  openreceive-ruby-db:sep20 ruby \
  -Ipackages/ruby/openreceive/lib -Ipackages/ruby/openreceive-server/lib \
  -Ipackages/ruby/openreceive-rails/lib \
  packages/ruby/openreceive-rails/test/repository_dialects_test.rb

OPENRECEIVE_DOTNET_POSTGRES='Host=host.docker.internal;Port=15432;Database=btcpay_safety;Username=postgres' npm run test:dotnet
```

Results:

- ORM: 4 passed, zero skips.
- Python on SQLite/PostgreSQL/MySQL plus Django on PostgreSQL: 149 passed, one MySQL-only skip.
- Django MySQL: 46 passed, three intentional ambient-transaction skips.
- Ruby PostgreSQL/MySQL: 2 tests/24 assertions, zero skips.
- .NET with real PostgreSQL: 355 passed, zero skips.

The Django MySQL skips cover outer transactions, savepoints and `ATOMIC_REQUESTS`.
On MySQL this backend refuses ambient transactions (ones the host opened) before it
takes its named lock. The test for that refusal passes.

Follow-up for users who started with the original single table: the PostgreSQL
upgrade test now runs three baselines:

- `InitialSwaps`
- `InitialSwaps` with its history entry removed
- `MintedInvoices`

All three pass through the real `PluginMigrationRunner`. For each, the test repeats
startup, compares every original swap column before and after, keeps active refunds,
refreshes only rows that were already superseded, and inserts a new mint through the
current EF model. The focused command was the PostgreSQL .NET command above with
`-- --filter FullyQualifiedName~Shipped_rows_upgrade` (3 passed, zero skipped).
Production migrations needed no changes. The plugin upgrade guide now separates the
additive schema upgrade from the legacy mint history, which is not available.
The full PostgreSQL-backed `npm run test:dotnet` rerun passed all 357 tests with
zero skips, zero build warnings and zero build errors. After this follow-up,
`npm run check`, `npm run check:docs` and `git diff --check` also passed.

From `packages/php/openreceive`:

```sh
OPENRECEIVE_TEST_PGSQL_DSN='pgsql:host=127.0.0.1;port=15432;dbname=openreceive_test' \
OPENRECEIVE_TEST_PGSQL_USER=postgres \
OPENRECEIVE_TEST_MYSQL_DSN='mysql:host=127.0.0.1;port=13306;dbname=openreceive_test' \
OPENRECEIVE_TEST_MYSQL_USER=root vendor/bin/phpunit
```

Result: 151 tests/1,518 assertions on SQLite/PostgreSQL/MySQL, zero skips.

## Browser, BTCPay and live wallet

We rebuilt the frontend demo from current source with
`docker build -t openreceive-ui-safety:sep21 -f examples/buttons/server/node-express/Dockerfile .`
and ran it with `DEMO_WALLET=testkit`, a disposable database directory and port 14173.
We rebuilt the BTCPay testkit image and restarted its wallet service to turn on
the mixed-case response control. All backing services and demo applications ran
in Docker. Chromium and the test runners ran on the host.

```sh
OPENRECEIVE_E2E_BASE_URL=http://127.0.0.1:14173 npx --no-install playwright test --config tests/e2e swap.spec.ts checkout-identity.spec.ts
npx --no-install playwright test --config tests/e2e-btcpay/playwright.config.ts payment-safety.spec.ts
OPENRECEIVE_LIVE_CREATE_INVOICE=0 OPENRECEIVE_LIVE_WAIT_FOR_PAYMENT=0 npm run test:live:nwc
```

Frontend: 3 passed. They cover settlement after the deposit expired, refund review
and confirmation, and switching references while a late response arrives.

BTCPay: all 7 passed with ordinary hash spelling. All 7 passed again with uppercase
settled history and notifications and lowercase mint and host identities. Both runs
include LN/LNURL partial remint, restart after expiry, retired refunds,
missing/ambiguous account mappings, host insertion failure and accounting replay.

The configured live receive-only NWC preflight passed with NIP-44 v2. We deliberately
disabled live invoice creation and payment waiting. We exercised delayed payments and
refunds with testkit/regtest services, not real funds.

Restart-before-payment follow-up: `npm run test:e2e:btcpay -- payment-safety.spec.ts`
passed all 9 Docker integration tests in 5.4 minutes, with zero skips. The two new
cases cover LN and LNURL. Each one:

1. Partially pays the host invoice so that BTCPay replaces its Lightning instructions.
2. Stops and starts BTCPay while the original mint is still unpaid.
3. Waits for startup recovery to revisit that mint and confirms it is still open.
4. Pays the original BOLT11.

Each case sees exactly one settled host payment, and the count stays the same after
a second restart. The existing cases also passed: pay while down, past expiry,
refund, account mapping and failed host write.

These also passed: `npm run typecheck`, `npm test` (722 passed, zero skipped),
`npm run check`, `npm run check:docs`,
`npx --no-install biome check tests/e2e-btcpay/payment-safety.spec.ts` and
`git diff --check`. The first sandboxed JavaScript run could not bind localhost for
two CLI tests. The rerun with localhost access passed the full suite. This follow-up
changed only tests and documentation. No payments with real funds were made.

These checks do not imply any automatic historical repair, host deployment, package
publication or plugin release. Some operational limits stay on purpose:

- effects after commit are best effort
- recovery needs explicit operator review
- closure for resumed dense history is conservative
- the plugin's provider budget is per process, as documented
