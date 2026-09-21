# Payment safety review closure — 2026-09-21

Reviewed `zz-cursor-sep21.txt` and `zz-kimi-sep21.txt` against the F01–F20
requirements in `zz-astra-sep20-fixes.txt`. The September 20 implementation had
remaining defects despite its passing aggregate checks. This follow-up corrects
them and extends the acceptance evidence below. This is source verification;
existing installations still need the [coordinated upgrade and reviewed recovery
procedure](../guides/payment-safety-upgrade.md). No packages or plugin were published.

## Review disposition

| Requirement | Correction or additional verification |
| --- | --- |
| F01 | Node accepts camelCase and legacy snake_case wallet-deadline snapshots, including timestamp provenance; malformed snapshots fail with a secret-free storage error. Deposit expiry remains distinct. |
| F02, F09 | Explicit tests for provider completion with wallet pending, wallet failure with refund recovery, and stale staging/confirmation replies after controller disposal. Existing mounted element/React/wrapper tests and Docker identity switching remain green. |
| F03, F04, F08 | Django `ATOMIC_REQUESTS` defers `after_paid` until the request commits. PHP retains observed wallet finality when fulfillment rolls back, preventing false expiry after grace. PHP/Ruby test a failing payment alongside a successfully committed sibling hash. Real PostgreSQL tests cover atomic Node host writes and rollback. |
| F05, F12 | Listener disposal exactly between dequeue and channel write preserves the mint for cold recovery. Testkit emits uppercase settled history and authenticated notifications while minting lowercase; BTCPay acceptance uses those responses through historical LN/LNURL recovery, partial remints and restarts. |
| F06, F10, F20 | A failed provider refresh preserves the old exposed order and refuses replacement. Existing real PostgreSQL migration/xmin/lease tests, provider-budget fairness tests, and Docker retired-swap refund recovery pass. |
| F07 | Remove the active batch from its durable queue before I/O, so two permanently failing historical batches cannot occupy every slot. Wrap at the end of a short repository page, so continuous arrivals cannot postpone old fulfillment retries. Shared vectors cover both failures and coverage crossing the expiry-grace boundary. PostgreSQL stress adds 20 attempts per pass behind 401 existing attempts, recreates worker connections, fails two scans and one fulfillment, and verifies eventual committed settlement under the shared gate. |
| F11 | Real Knex PostgreSQL bindings, transaction identity, concurrency and rollback tests pass. A dedicated CI job now supplies PostgreSQL and runs `npm run test:orms` on every push/PR. |
| F13 | Python propagates the remaining monotonic scan deadline through negotiation, connection and history RPC. Ruby bounds only wallet RPC I/O, including Async-backed blocking reads. Explicit Node/PHP tests prove workers settle when HTTP opportunism is disabled. |
| F14, U1–U6 | Existing reviewed maintenance/requeue, audit, immutable settlement and upgrade paths remain covered by the cross-engine suites; no automatic rewrite of historical terminal rows was introduced. |
| F15 | Direct Ruby and Node FixedFloat hooks receive allowlisted metadata before any host sink. Create/status/refund tests retain actual credentials in provider calls, exclude them from diagnostics, and prove throwing loggers are nonfatal. |
| F16–F18 | Authorization-before-client-construction, scalar/unusable history handling, physical pagination and PHP relay failover acceptance remain green. |
| F19 | Node refuses missing, null, non-string and unknown saved refund networks with 503 `INTERNAL`, before status/refund provider I/O. Valid network checksum handling is unchanged. |

The scheduler's metadata format and payment tables are unchanged. Custom
repositories must fill the requested page up to 200 pending rows unless fewer
remain after the cursor; a short repository page now signals wraparound.
This does not change the wallet-history rule: a short wallet page is never
automatically evidence that the wallet history ended.

## Combined gate and focused checks

Commands ran from the repository root unless stated otherwise. Database URLs
below name disposable local Docker services, not deployed infrastructure.

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed. |
| `npm run test:ci` | Passed: contracts/secrets, lint/format, docs/generated files, public API, JS/framework tests, all engines, package/demo builds and artifact checks. |
| `npm test` (within `test:ci`) | 722 passed, zero skipped. |
| `npm run check` (within `test:ci`) | Passed, including all progress-vector consumers. |
| `npm run test:ruby` (within `test:ci`) | 288 tests, 1,846 assertions, zero failures/errors; two external-dialect skips exercised separately below. |
| `npm run test:python` (within `test:ci`) | 466 collected, 465 passed, one MySQL-only skip exercised in the MySQL lane; conformance passed. |
| `npm run test:php` (within `test:ci`) | Core: 111 tests/1,136 assertions; Laravel: 21/122; WordPress: 2/6; conformance passed. |
| `npm run test:dotnet` (within `test:ci`) | 353 passed, two external-PostgreSQL skips exercised separately below. |
| `npm run build:docs` and `npm run check:docs` | Regenerated the site contract; all documentation and skill mirrors agree. |
| `packages/python/openreceive/.venv/bin/ruff check packages/python/openreceive` | Passed. |
| `packages/python/openreceive/.venv/bin/ruff format --check packages/python/openreceive` | 140 files formatted correctly. |
| `.venv/bin/mypy` from `packages/python/openreceive` | Passed, 90 source files. |
| `vendor/bin/phpstan analyse --no-progress` from `packages/php/openreceive` | Passed. |
| `git diff --check` | Passed. |

Focused regressions were run before the full gate: `tests/swap-address.test.mjs`,
`tests/settlement-recovery.test.mjs`, `tests/reconcile-progress.test.mjs`,
`tests/opportunistic-reconcile.test.mjs`, `tests/browser-payment-lifetime.test.mjs`,
`tests/fixedfloat.test.mjs`, and the provider logging/failover tests through
`node --import tsx --test`; Python payment-safety, receive-client deadline and
Django view tests through pytest; PHP `vendor/bin/phpunit --filter PaymentSafetyTest`;
Ruby `nwc_ruby_test.rb`, provider diagnostic tests and `rails_test.rb --name
'/PaymentSafetyProgress/'`; and the focused .NET provider-refresh test.

The new regressions first reproduced unsafe refund acceptance, the alias failure,
raw diagnostic payloads, PHP false closure, and starvation under continuous
arrivals. Intermediate combined checks also caught a synthetic credential-shaped
fixture and a stale generated documentation index. These were corrected without
weakening the scanners or excluding tests. Existing nonfatal output includes
Biome warnings, Node's SQLite notice, two upstream Python deprecations, and
unrelated vendor Vite configuration discovery messages.

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

Results: ORM 4 passed with zero skips; Python SQLite/PostgreSQL/MySQL and Django
PostgreSQL 149 passed/one MySQL-only skip; Django MySQL 46 passed/three intentional
ambient-transaction skips; Ruby PostgreSQL/MySQL 2 tests/24 assertions, zero
skips; .NET with actual PostgreSQL 355 passed, zero skips. The Django MySQL skips
cover outer transactions, savepoints and `ATOMIC_REQUESTS`: this backend explicitly
refuses ambient transactions before acquiring its named lock. Its rejection test passes.

Follow-up for original single-table users: the PostgreSQL upgrade test now runs
three baselines—`InitialSwaps`, `InitialSwaps` with its history entry removed, and
`MintedInvoices`. All three pass through the actual `PluginMigrationRunner`,
repeat startup, compare every original swap column before/after, preserve active
refunds, refresh only previously superseded rows, and insert a new mint through
the current EF model. The focused command was the same PostgreSQL .NET command
above with `-- --filter FullyQualifiedName~Shipped_rows_upgrade` (3 passed,
zero skipped). Production migrations needed no changes. The plugin upgrade guide
now distinguishes the additive schema upgrade from unavailable legacy mint history.
The full PostgreSQL-backed `npm run test:dotnet` rerun passed all 357 tests with
zero skips, zero build warnings and zero build errors. `npm run check`,
`npm run check:docs` and `git diff --check` also passed after this follow-up.

From `packages/php/openreceive`:

```sh
OPENRECEIVE_TEST_PGSQL_DSN='pgsql:host=127.0.0.1;port=15432;dbname=openreceive_test' \
OPENRECEIVE_TEST_PGSQL_USER=postgres \
OPENRECEIVE_TEST_MYSQL_DSN='mysql:host=127.0.0.1;port=13306;dbname=openreceive_test' \
OPENRECEIVE_TEST_MYSQL_USER=root vendor/bin/phpunit
```

Result: 151 tests/1,518 assertions on SQLite/PostgreSQL/MySQL, zero skips.

## Browser, BTCPay and live wallet

The frontend demo was rebuilt from current source using
`docker build -t openreceive-ui-safety:sep21 -f examples/buttons/server/node-express/Dockerfile .`
and run with `DEMO_WALLET=testkit`, a disposable database directory and port 14173.
The BTCPay testkit image was rebuilt and its wallet service restarted to enable
the mixed-case response control. All backing services and demo applications ran
in Docker; Chromium and test runners ran on the host.

```sh
OPENRECEIVE_E2E_BASE_URL=http://127.0.0.1:14173 npx --no-install playwright test --config tests/e2e swap.spec.ts checkout-identity.spec.ts
npx --no-install playwright test --config tests/e2e-btcpay/playwright.config.ts payment-safety.spec.ts
OPENRECEIVE_LIVE_CREATE_INVOICE=0 OPENRECEIVE_LIVE_WAIT_FOR_PAYMENT=0 npm run test:live:nwc
```

Frontend: 3 passed, including post-deposit-expiry settlement, refund review and
confirmation, and reference switching with a late response. BTCPay: all 7 passed
with ordinary hash spelling and all 7 passed again with uppercase settled
history/notifications and lowercase mint/host identities. Both runs include
LN/LNURL partial remint, restart beyond expiry, retired refunds, missing/ambiguous
account mappings, host insertion failure and accounting replay.
Configured live receive-only NWC preflight passed with NIP-44 v2. Live invoice
creation and payment waiting were intentionally disabled. Delayed payments and
refund behavior were exercised using testkit/regtest services, not real funds.

Restart-before-payment follow-up: `npm run test:e2e:btcpay -- payment-safety.spec.ts`
passed all 9 Docker integration tests in 5.4 minutes, with zero skips. The two new
cases cover both LN and LNURL: partially pay the host invoice to replace its
Lightning instructions, stop/start BTCPay while the original mint remains unpaid,
wait for startup recovery to revisit that mint and confirm it remains open, then
pay the original BOLT11. Each case observes exactly one settled host payment and
retains that count after a second restart. Existing pay-while-down, past-expiry,
refund, account-mapping and failed-host-write cases also passed.
`npm run typecheck`, `npm test` (722 passed, zero skipped), `npm run check`,
`npm run check:docs`, `npx --no-install biome check tests/e2e-btcpay/payment-safety.spec.ts`
and `git diff --check` passed. The initial sandboxed JavaScript run could not bind
localhost for two CLI tests; the rerun with localhost access passed the full suite.
Only tests and documentation changed in this follow-up; no real-fund payments were made.

No automatic historical repair, host deployment, package publication, or plugin
release is implied by these checks. Best-effort post-commit effects, explicit
operator review, conservative closure for resumed dense history, and the plugin's
documented per-process provider budget remain intentional operational limits.
