# Payment safety audit — 2026-09-20

Reviewed checkout `e9683627`, including the payment changes that were initially uncommitted and became part of that commit during the audit. A later concurrent edit to `NwcRelayTransport.cs` appeared while finishing; it was inspected, but the BTCPay build/test claims below refer to the earlier snapshot. No production code was changed by this audit. Findings describe reproducible failure paths, not evidence of losses in a deployed service.

The review covered JavaScript core, Node, HTTP, SQL/ORM adapters, notifications, browser/elements/React and the Vue/Svelte/Angular wrappers; Ruby core/server/Rails; Python core/server/SQLAlchemy/Django/FastAPI; PHP core/server/Laravel/WordPress; the BTCPay plugin and relevant upstream Lightning listener behavior; and representative example host integrations. Focus was persistence before exposing payment instructions, settlement discovery, retries, transaction boundaries, concurrency, refund recovery, and fulfillment.

There are **11 actionable findings: seven P1 and four P2**. P1 means prioritize before relying on the affected path for live payments. P2 means a narrower configuration, timing, or recovery problem that still needs correction. Wallets and configured providers were treated as trusted, as required by the repository rules.

1. **P1 — Backend swap attempts leave reconciliation before the actual Lightning invoice expires.**

   Affected: Node HTTP, Rails, Python repositories including Django, and PHP repositories including Laravel/WordPress.

   Sources: [JS payment-repository.ts:242](/Users/perls/workspace/openrecieve/packages/js/http/src/payment-repository.ts:242), [Rails open_receive_payment.rb:315](/Users/perls/workspace/openrecieve/packages/ruby/openreceive-rails/app/models/open_receive_payment.rb:315), [Python repository.py:230](/Users/perls/workspace/openrecieve/packages/python/openreceive/src/openreceive/storage/repository.py:230), [PHP SqlPaymentRepository.php:356](/Users/perls/workspace/openrecieve/packages/php/openreceive/src/Storage/SqlPaymentRepository.php:356).

   These implementations store the provider's deposit deadline as the attempt expiry in preference to the shadow Lightning invoice's expiry. Default FixedFloat settings allow 600 seconds for deposits but mint a Lightning invoice lasting 1,800 seconds. At second 1,500, the provider deadline plus the 900-second grace has elapsed, so a successful wallet scan can mark the attempt `expired` or `attention` while the invoice remains payable for another 300 seconds. Both statuses leave the pending scan set. Notification handling also accepts only pending attempts.

   **Evidence:** independent Node and Ruby reproductions closed an attempt before its invoice expired, then supplied a real-settlement-shaped wallet result within that invoice's payable lifetime. No fulfillment occurred. The Ruby reproduction also demonstrated that the subsequent authenticated notification was ignored. Python/PHP share the same expiry selection in source; their specific late-payout scenario was not separately executed.

   **Fix direction:** represent the deposit/reuse deadline separately from the wallet settlement deadline. Keep monitoring through the actual Lightning expiry plus grace. Changing the single expiry to the longer value without preserving deposit/reuse rules would create a different bug by re-serving stale deposit instructions.

2. **P1 — The shared browser stops polling a funded swap at its deposit deadline.**

   Sources: [swap-http.ts:97](/Users/perls/workspace/openrecieve/packages/js/browser/src/internal/swap-http.ts:97), [checkout-state.ts:335](/Users/perls/workspace/openrecieve/packages/js/browser/src/internal/checkout-state.ts:335), [checkout-watcher.ts:207](/Users/perls/workspace/openrecieve/packages/js/browser/src/internal/checkout-watcher.ts:207).

   Swap snapshots put `provider_expires_at` into the generic invoice expiry. The local countdown makes the checkout terminal when that time arrives, even if the provider says `confirming`, `exchanging`, or `refund_required`. The watcher then removes both timers, stopping payment and provider status requests without a final scan. This is independent of finding 1: it happens at the deposit deadline itself, before the backend grace period.

   **Evidence:** a deterministic watcher reproduction with a funded `confirming` swap reached the deposit deadline and lost all polling timers without another status read. With default request-driven reconciliation and no other traffic, a later wallet payout has no automatic discovery trigger. A separate worker mitigates backend discovery but does not refresh the frozen refund panel.

   **Fix direction:** stop offering deposits at the deadline while continuing to monitor funded swaps, Lightning settlement, and refund states until authoritative terminal results arrive.

3. **P1 — Django's `after_paid` runs before the outer transaction commits and can dispatch fulfillment twice.**

   Sources: [server/reconcile.py:86](/Users/perls/workspace/openrecieve/packages/python/openreceive/src/openreceive/server/reconcile.py:86), [django/repository.py:216](/Users/perls/workspace/openrecieve/packages/python/openreceive/src/openreceive/django/repository.py:216).

   `Reconciler.settle` assumes that returning from `record_settlement` means COMMIT and immediately invokes `after_paid`. Under an enclosing `transaction.atomic()` block, including `ATOMIC_REQUESTS`, the repository only exits a nested transaction/savepoint. An outer rollback restores the attempt to pending after the externally visible callback has already run. Retrying the settlement invokes that callback again.

   **Evidence:** actual Django/SQLite reproduction recorded `after_paid_inside_atomic=True`; outer rollback left the attempt pending with one delivery recorded; retry left it settled with two deliveries. This can duplicate emails, jobs, or shipment requests dispatched from the documented after-COMMIT hook. The final downstream effect depends on the host's own idempotency.

   **Fix direction:** defer via Django `transaction.on_commit` on the correct database alias, or explicitly enforce an outermost transaction boundary before claiming the hook has run after commit.

4. **P1 — Node custom-repository mode permanently consumes the settlement claim before a fallible fulfillment callback.**

   Source: [host-payments.ts:183](/Users/perls/workspace/openrecieve/packages/js/http/src/host-payments.ts:183).

   `createHost({ payments, onPaid })` first awaits the durable `recordSettlement` claim, then calls `onPaid` outside that transaction. If the callback throws, or the process exits between these operations, the attempt is already settled and subsequent claims return false. Neither reconciliation nor redelivery retries the host callback. This is a library sequencing problem even when the custom repository correctly implements the documented contract. The normal `db` mode wraps fulfillment in the transaction and is not affected by this specific issue.

   **Evidence:** passed the library's SQL repository through custom-repository mode, threw from `onPaid`, and redelivered the event. The callback ran only once, the row stayed settled, and no reconcilable attempt remained although fulfillment had failed.

   **Fix direction:** provide a transactional fulfillment callback to the repository or persist a separate retryable delivery/outbox state. An irreversible boolean claim followed by an external callback cannot provide reliable retry delivery.

5. **P1 — BTCPay loses old payable Lightning invoices after remint and restart.**

   Sources: [ScanMemo.cs:483](/Users/perls/workspace/openrecieve/packages/dotnet/BTCPayServer.Plugins.OpenReceive/Nwc/ScanMemo.cs:483), [NwcConnectionStringHandler.cs:84](/Users/perls/workspace/openrecieve/packages/dotnet/BTCPayServer.Plugins.OpenReceive/Nwc/NwcConnectionStringHandler.cs:84), [ReceiveOnlyNwcClient.cs:406](/Users/perls/workspace/openrecieve/packages/dotnet/BTCPayServer.Plugins.OpenReceive/Nwc/ReceiveOnlyNwcClient.cs:406).

   A partial payment through another BTCPay rail causes a replacement Lightning invoice. Cancellation is unsupported, so the old invoice remains payable. BTCPay replaces the current payment prompt and, after restart, restores listeners from that current prompt. The plugin persists old minted hashes but restores only specifically requested hashes, with no historical host-invoice mapping/enumeration. `ScanMemo` announces settlement only for watched hashes; the old invoice can therefore be seen as settled without being credited to its BTCPay invoice.

   Relevant host code: [LightningListener.cs:184](/Users/perls/workspace/openrecieve/packages/dotnet/submodules/btcpayserver/BTCPayServer/Payments/Lightning/LightningListener.cs:184), [InvoiceRepository.cs:406](/Users/perls/workspace/openrecieve/packages/dotnet/submodules/btcpayserver/BTCPayServer/Services/Invoices/InvoiceRepository.cs:406).

   **Evidence:** production-component reproduction minted original/replacement invoices, settled the original, restarted state, and watched the current prompt as BTCPay does. Output: `OldWalletState=settled`, `WatchedOld=false`, `EmittedSettlementCount=0`. This finding combines a source-traced integration path with a component reproduction; a complete BTCPay/PostgreSQL restart test was not run.

   **Fix direction:** persist and restore the association between every still-reconcilable minted hash and its host invoice, including superseded prompts. Ensure BTCPay can consume settlement for those historical hashes after restart.

6. **P1 — BTCPay supersedes a potentially funded swap using stale provider state, then stops its recovery polling.**

   Sources: [SwapService.cs:203](/Users/perls/workspace/openrecieve/packages/dotnet/BTCPayServer.Plugins.OpenReceive/Swaps/SwapService.cs:203), [SwapService.cs:364](/Users/perls/workspace/openrecieve/packages/dotnet/BTCPayServer.Plugins.OpenReceive/Swaps/SwapService.cs:364).

   Another create request within the last 60 seconds of the deposit window marks the old order `expired` from cached database state. A deposit or refund requirement that the provider knows about but the poller has not observed is lost from the active workflow. Terminal rows stop provider polling, and GET simply returns the stale row. Funds may remain at the provider without any refund prompt or automatic recovery; direct operator/provider intervention may still recover them.

   **Evidence:** changed the fake provider to `refund_required` while the persisted row still said `awaiting_deposit`. Creating at expiry minus 59 seconds expired the original. Later polling and GET continued to report terminal expiry with no refund reason.

   **Fix direction:** retire payment instructions separately from provider recovery. Refresh before making replacement decisions, and keep historical orders eligible for deposit/refund discovery after replacement.

7. **P1 — Oldest-first batches and restarting capped scans can permanently starve paid attempts.**

   Sources: [sql-payments.ts:249](/Users/perls/workspace/openrecieve/packages/js/http/src/sql-payments.ts:249), [reconcile-gate.ts:133](/Users/perls/workspace/openrecieve/packages/js/http/src/reconcile-gate.ts:133), [core/payments.ts:152](/Users/perls/workspace/openrecieve/packages/js/core/src/payments.ts:152). Rails, Python, and PHP also use a fixed oldest-first pending batch.

   Each pass selects the same oldest 200 pending attempts. Each capped wallet walk restarts at offset zero; the default request-path cap is 50 pages of 20 transactions. If those old attempts cannot be resolved within the cap, they correctly remain pending, but no cursor, rotation, or narrower window progresses the next pass. Newer paid rows cannot enter the repository batch. A wallet that only exposes paid history or drops old unpaid invoices can trigger this with more than 1,000 later incoming transactions.

   **Evidence:** actual Node SQL repository and core scanner with 200 old unresolved attempts plus a newer paid attempt. Three passes made 300 wallet page calls, returned zero decisions, and left the paid attempt pending. Its transaction was even present in the returned history but was outside the expected repository batch. Every subsequent pass has the same selection/window behavior. The exact capped-history reproduction was executed in Node; the matching batch policy in other languages was source-reviewed.

   **Fix direction:** guarantee forward progress with durable scan cursors/window partitioning and fair attempt selection. Keep the existing rule that a truncated scan cannot prove absence; simply closing omitted rows would turn this into data loss.

8. **P2 — Ruby, Python, and PHP can report settled after the fulfillment transaction rolled back.**

   Sources: [Ruby reconcile.rb:193](/Users/perls/workspace/openrecieve/packages/ruby/openreceive-rails/lib/openreceive/reconcile.rb:193), [Python reconcile.py:245](/Users/perls/workspace/openrecieve/packages/python/openreceive/src/openreceive/server/reconcile.py:245), [PHP Reconciler.php:249](/Users/perls/workspace/openrecieve/packages/php/openreceive/src/Server/Reconciler.php:249).

   These reconcilers catch settlement callback failures but return the original wallet check as settled. The HTTP check route serves that result rather than the committed attempt status. The browser considers it terminal and stops polling. Without the optional worker or subsequent unrelated traffic, a transient callback failure loses its automatic retry trigger. This does not destroy the pending row; later reconciliation can still recover it.

   **Evidence:** independent Ruby, Python, and PHP reproductions returned HTTP 200 with `status=settled` while the database row remained pending and host fulfillment had rolled back. Node's normal database path propagates aggregated delivery failures and does not have this same false-success behavior.

   **Fix direction:** suppress failed settlement results from the successful response or serve the committed status/retryable failure. Continue processing the other batch entries, but preserve each entry's persistence outcome.

9. **P2 — Late browser responses can show another order's payment instructions.**

   Sources: [checkout-session.ts:219](/Users/perls/workspace/openrecieve/packages/js/browser/src/internal/checkout-session.ts:219), [checkout-session.ts:288](/Users/perls/workspace/openrecieve/packages/js/browser/src/internal/checkout-session.ts:288), [element-checkout-session.ts:157](/Users/perls/workspace/openrecieve/packages/js/elements/src/element-checkout-session.ts:157).

   The shared session captures a reference for the request but does not verify it after awaits. If a host reuses the checkout component for order B while an order A mint/swap remains in flight, A's delayed response can overwrite B's state. React retains the shared session across renders; the elements retain it across attribute changes, affecting the wrappers built on them.

   **Evidence:** actual custom-element DOM test switched A to B, successfully prepared B, then resolved A's delayed mint. The element reset its reference to A and exposed A's payable invoice. A separate shared-session swap reproduction merged A's hash/deposit address into B's snapshot, causing ownership-check failures on B's polling. Paying the displayed instructions credits A while the payer intended B.

   **Fix direction:** invalidate session requests when reference or endpoint identity changes, and check the captured identity/generation after every await before publishing instructions or errors.

10. **P2 — BTCPay hides recovery for existing swaps when creating a new swap is no longer allowed.**

    Sources: [SwapService.cs:175](/Users/perls/workspace/openrecieve/packages/dotnet/BTCPayServer.Plugins.OpenReceive/Swaps/SwapService.cs:175), [CheckoutPaymentExtension.cshtml:11](/Users/perls/workspace/openrecieve/packages/dotnet/BTCPayServer.Plugins.OpenReceive/Views/Shared/OpenReceive/CheckoutPaymentExtension.cshtml:11), [openreceive_swap_checkout.js:54](/Users/perls/workspace/openrecieve/packages/dotnet/BTCPayServer.Plugins.OpenReceive/Resources/js/openreceive_swap_checkout.js:54).

    Creation eligibility is checked before looking up an existing swap, and the checkout hides swap/refund UI when availability is false. Reloading an existing funded/refund-required swap can therefore fail when the invoice has too little lifetime remaining, receives a partial payment, or becomes nonpayable.

    **Evidence:** a persisted `refund_required` swap could not reopen when the invoice had 29 minutes left and new swaps required 30. Manual GET/refund with a previously retained swap ID still works; provider credentials are not deleted.

    **Fix direction:** resolve existing attempts before applying new-swap eligibility, and render their status/refund recovery independently of whether new swaps are offered.

11. **P2 — The Node Knex/PostgreSQL adapter rejects the repository's parameterized SQL.**

    Source: [orm-adapters.ts:35](/Users/perls/workspace/openrecieve/packages/js/http/src/orm-adapters.ts:35).

    The repository renders PostgreSQL placeholders as `$1`, `$2`, etc. The adapter forwards them with a bindings array to `knex.raw`, which compiles its own `?` placeholders and rejects that combination before dispatch. Reads, attempt persistence, and reconciliation through the advertised adapter fail. Fresh creation generally fails closed; existing attempts become uncreditable while the host uses this adapter. Existing real-ORM tests exercise SQLite, not PostgreSQL.

    **Evidence:** actual installed Knex compiler, through `knexDb`, rejected `SELECT ... WHERE reference = $1` with one binding: `Expected 1 bindings, saw 0`. No PostgreSQL server was necessary for this pre-dispatch reproduction.

    **Fix direction:** implement a Knex-appropriate parameter path while preserving host SQL literals/operators, and add an actual PostgreSQL adapter integration check.

**Validation and reproducibility**

Existing checks and isolated reproductions complement each other: passing existing suites did not cover these edge cases. Reproduction artifacts were kept outside the source tree; they deliberately assert the currently faulty behavior and are not fixes/regression coverage.

- `npm run check`: passed contract/vector validation, secret scan, and naming check.
- `npm run typecheck`: passed.
- `npm test`: 678 passed, zero failures/skips on the final run. The first sandboxed run had 676 passes and two CLI localhost-binding `EPERM` failures; `node --import tsx --test tests/cli-doctor.test.mjs` then passed all nine tests with binding allowed, followed by the successful full run.
- `npm run test:ruby`: 258 runs, 1,713 assertions, zero failures/errors/skips, plus cross-language conformance.
- Python focused command from `packages/python/openreceive`: `.venv/bin/python -m pytest tests/server/test_app.py tests/storage tests/django/test_repository.py tests/vectors/test_wallet_scan_truncation.py tests/vectors/test_nwc_request_response.py`: 48 passed.
- Full Python command from `packages/python/openreceive`: `.venv/bin/python -m pytest tests -q`: 403 passed after allowing local test-relay sockets; the first restricted run failed socket fixtures with permission errors. Two dependency deprecation warnings remained. `packages/python/openreceive/.venv/bin/python tools/conformance/python-crosslang.py` also passed.
- PHP focused command from `packages/php/openreceive`: `php vendor/bin/phpunit tests/Server/EngineTest.php tests/Server/ServiceReconcileTest.php tests/Storage tests/Vectors/WalletScanTruncationTest.php tests/Vectors/NwcRequestResponseTest.php`: 34 tests, 255 assertions, passed.
- `npm run test:php`: all three packages passed, totaling 113 tests and 969 assertions (Laravel 21, core 90, WordPress 2), plus Composer manifest validation and cross-language conformance. The two WordPress tests are unit tests, not a running WooCommerce integration.
- Frontend: `LOG_LEVEL=error node --import tsx --test tests/browser-checkout-controller.test.mjs tests/element-lifecycle.test.mjs tests/react-checkout-behavior.test.mjs tests/wrapper-behavior.test.mjs tests/wrapper-parity.test.mjs`: 89 passed, zero failures/skips.
- BTCPay: `/Users/perls/.dotnet/dotnet packages/dotnet/BTCPayServer.Plugins.OpenReceive.Tests/bin/Debug/net10.0/BTCPayServer.Plugins.OpenReceive.Tests.dll -noColor -class '*Swaps.SwapServiceTests' -class '*Nwc.ScanMemoTests' -class '*Nwc.ReceiveOnlyNwcClientTests'`: 80 passed, zero skipped against rebuilt sources. Standard VSTest encountered sandbox socket restrictions; the in-process runner succeeded.
- `OPENRECEIVE_LIVE_CREATE_INVOICE=0 OPENRECEIVE_LIVE_WAIT_FOR_PAYMENT=0 npm run test:live:nwc`: passed wallet preflight with network access, receive checkout ready, NIP-44 v2. The initial restricted-network attempt failed to connect. No invoice was minted or payment made.

Executed reproduction commands:

```sh
node --import tsx /tmp/openreceive-audit-node-repros.mjs
packages/python/openreceive/.venv/bin/python /tmp/openreceive-audit-python-repros.py
php /tmp/openreceive-audit-php-repros.php
ruby -Ipackages/ruby/openreceive/lib -Ipackages/ruby/openreceive-server/lib -Ipackages/ruby/openreceive-rails/lib /tmp/openreceive-ruby-audit-repro.rb --name '/test_audit_/'
LOG_LEVEL=error node --import tsx --test /tmp/openreceive-browser-audit-repro.mjs
LOG_LEVEL=error node --import tsx --test /tmp/openreceive-element-audit-repro.mjs
/Users/perls/.dotnet/dotnet /private/tmp/openreceive-btcpay-audit-repro/bin/Debug/net10.0/repro.dll
```

Node reproduced three cases; Ruby two cases with 12 assertions; Python false success and rollback/retry duplication; PHP false success; browser three cases plus one actual DOM lifecycle case; BTCPay three component scenarios. Knex was additionally checked with an inline compiler reproduction described in finding 11.

**Limits:** no live payment/refund transfers, real PostgreSQL/MySQL concurrency fault injection, full BTCPay restart E2E, or Docker demo/browser E2E were run. WordPress lifecycle/fulfillment and migrations were source-reviewed; WooCommerce storage failures were not fault-injected in a running installation. `npm run test:ci` was intentionally not run: this was a source audit with a report-only repository change, not a route/schema/release implementation. No independent unintended destructive migration/deletion path or normal-path Rails/BTCPay double-credit defect was confirmed. Django's after-commit boundary is the confirmed duplicate-delivery case. These limits prevent treating the audit as proof that other loss paths do not exist.
