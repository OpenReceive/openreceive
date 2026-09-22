# Payment safety audit — 2026-09-20

We reviewed checkout `e9683627`. That commit includes payment changes that were still uncommitted when the audit started. While we were finishing, a concurrent edit to `NwcRelayTransport.cs` appeared. We inspected it, but the BTCPay build and test claims below refer to the earlier snapshot. The audit changed no production code. Each finding describes a failure path we could reproduce. None is evidence of losses in a deployed service.

The review covered:

- JavaScript: core, Node, HTTP, SQL/ORM adapters, notifications, browser, elements, React, and the Vue/Svelte/Angular wrappers.
- Ruby: core, server, Rails.
- Python: core, server, SQLAlchemy, Django, FastAPI.
- PHP: core, server, Laravel, WordPress.
- The BTCPay plugin and the relevant behavior of BTCPay's upstream Lightning listener.
- Representative example host integrations.

We focused on these questions: is the payment persisted before payment instructions are shown, how is settlement discovered, and how do retries, transaction boundaries, concurrency, refund recovery and fulfillment behave?

There are **11 actionable findings: seven P1 and four P2**. Fix a P1 before relying on the affected path for live payments. A P2 is a narrower configuration, timing or recovery problem that still needs a fix. As the repository rules require, we treated wallets and configured providers as trusted.

1. **P1 — Backend swap attempts leave reconciliation before the actual Lightning invoice expires.**

   Affected: Node HTTP, Rails, Python repositories including Django, and PHP repositories including Laravel/WordPress.

   Sources: [JS payment-repository.ts:242](/Users/perls/workspace/openrecieve/packages/js/http/src/payment-repository.ts:242), [Rails open_receive_payment.rb:315](/Users/perls/workspace/openrecieve/packages/ruby/openreceive-rails/app/models/open_receive_payment.rb:315), [Python repository.py:230](/Users/perls/workspace/openrecieve/packages/python/openreceive/src/openreceive/storage/repository.py:230), [PHP SqlPaymentRepository.php:356](/Users/perls/workspace/openrecieve/packages/php/openreceive/src/Storage/SqlPaymentRepository.php:356).

   These implementations store the provider's deposit deadline as the attempt expiry. They prefer it over the expiry of the shadow Lightning invoice (the invoice the swap provider pays). With default FixedFloat settings, the deposit window is 600 seconds but the Lightning invoice lasts 1,800 seconds. At second 1,500, the provider deadline plus the 900-second grace has passed. A successful wallet scan can then mark the attempt `expired` or `attention`, even though the invoice stays payable for another 300 seconds. Both statuses remove the attempt from the pending scan set. Notification handling also accepts only pending attempts.

   **Evidence:** separate Node and Ruby reproductions closed an attempt before its invoice expired. They then supplied a wallet result shaped like a real settlement, inside the invoice's payable lifetime. No fulfillment happened. The Ruby reproduction also showed that the later authenticated notification was ignored. Python and PHP choose the expiry the same way in source. We did not run their late-payout scenario separately.

   **Fix direction:** store the deposit/reuse deadline separately from the wallet settlement deadline. Keep monitoring until the actual Lightning expiry plus grace. Do not just switch the single expiry to the longer value. Without the deposit/reuse rules, that creates a different bug: stale deposit instructions get served again.

2. **P1 — The shared browser stops polling a funded swap at its deposit deadline.**

   Sources: [swap-http.ts:97](/Users/perls/workspace/openrecieve/packages/js/browser/src/internal/swap-http.ts:97), [checkout-state.ts:335](/Users/perls/workspace/openrecieve/packages/js/browser/src/internal/checkout-state.ts:335), [checkout-watcher.ts:207](/Users/perls/workspace/openrecieve/packages/js/browser/src/internal/checkout-watcher.ts:207).

   Swap snapshots put `provider_expires_at` into the generic invoice expiry. When that time arrives, the local countdown makes the checkout terminal. This happens even if the provider says `confirming`, `exchanging` or `refund_required`. The watcher then removes both timers. It stops payment and provider status requests without a final scan. This is separate from finding 1. It happens at the deposit deadline itself, before the backend grace period.

   **Evidence:** a deterministic watcher reproduction used a funded `confirming` swap. When it reached the deposit deadline, it lost all polling timers without another status read. With the default request-driven reconciliation and no other traffic, nothing automatically discovers a later wallet payout. A separate worker covers backend discovery, but it does not refresh the frozen refund panel.

   **Fix direction:** stop offering deposits at the deadline. Keep monitoring funded swaps, Lightning settlement and refund states until authoritative terminal results arrive.

3. **P1 — Django's `after_paid` runs before the outer transaction commits and can dispatch fulfillment twice.**

   Sources: [server/reconcile.py:86](/Users/perls/workspace/openrecieve/packages/python/openreceive/src/openreceive/server/reconcile.py:86), [django/repository.py:216](/Users/perls/workspace/openrecieve/packages/python/openreceive/src/openreceive/django/repository.py:216).

   `Reconciler.settle` assumes that a return from `record_settlement` means COMMIT, and it calls `after_paid` right away. Inside an enclosing `transaction.atomic()` block, including `ATOMIC_REQUESTS`, the repository only exits a nested transaction (a savepoint). If the outer transaction rolls back, the attempt returns to pending, but the callback has already run and had outside effects. Retrying the settlement calls it again.

   **Evidence:** a real Django/SQLite reproduction recorded `after_paid_inside_atomic=True`. The outer rollback left the attempt pending with one delivery recorded. The retry left it settled with two deliveries. The docs call this an after-COMMIT hook, so hosts may send emails, jobs or shipment requests from it, and those can go out twice. The final effect depends on the host's own idempotency.

   **Fix direction:** defer the hook with Django `transaction.on_commit` on the correct database alias. Otherwise, enforce an outermost transaction boundary before claiming the hook runs after commit.

4. **P1 — Node custom-repository mode permanently consumes the settlement claim before a fallible fulfillment callback.**

   Source: [host-payments.ts:183](/Users/perls/workspace/openrecieve/packages/js/http/src/host-payments.ts:183).

   `createHost({ payments, onPaid })` first awaits the durable `recordSettlement` claim. It then calls `onPaid` outside that transaction. If the callback throws, or the process exits between the two steps, the attempt is already settled and later claims return false. Neither reconciliation nor redelivery retries the host callback. The bug is in the library's ordering, so it happens even when the custom repository implements the documented contract correctly. The normal `db` mode wraps fulfillment in the transaction and does not have this issue.

   **Evidence:** we passed the library's SQL repository through custom-repository mode, threw from `onPaid`, and redelivered the event. The callback ran only once. The row stayed settled. No attempt was left to reconcile, even though fulfillment had failed.

   **Fix direction:** give the repository a transactional fulfillment callback, or persist a separate retryable delivery (outbox) state. An irreversible boolean claim followed by an external callback cannot deliver reliable retries.

5. **P1 — BTCPay loses old payable Lightning invoices after remint and restart.**

   Sources: [ScanMemo.cs:483](/Users/perls/workspace/openrecieve/packages/dotnet/BTCPayServer.Plugins.OpenReceive/Nwc/ScanMemo.cs:483), [NwcConnectionStringHandler.cs:84](/Users/perls/workspace/openrecieve/packages/dotnet/BTCPayServer.Plugins.OpenReceive/Nwc/NwcConnectionStringHandler.cs:84), [ReceiveOnlyNwcClient.cs:406](/Users/perls/workspace/openrecieve/packages/dotnet/BTCPayServer.Plugins.OpenReceive/Nwc/ReceiveOnlyNwcClient.cs:406).

   A partial payment through another BTCPay payment method makes BTCPay mint a replacement Lightning invoice. Cancellation is unsupported, so the old invoice stays payable. BTCPay replaces the current payment prompt. After a restart, it restores listeners from that current prompt only. The plugin persists old minted hashes, but it restores only the hashes BTCPay asks for. It has no stored mapping from old hashes to host invoices and no way to list them. `ScanMemo` announces settlement only for watched hashes. So the old invoice can be seen as settled without being credited to its BTCPay invoice.

   Relevant host code: [LightningListener.cs:184](/Users/perls/workspace/openrecieve/packages/dotnet/submodules/btcpayserver/BTCPayServer/Payments/Lightning/LightningListener.cs:184), [InvoiceRepository.cs:406](/Users/perls/workspace/openrecieve/packages/dotnet/submodules/btcpayserver/BTCPayServer/Services/Invoices/InvoiceRepository.cs:406).

   **Evidence:** a reproduction using the production components minted an original and a replacement invoice, settled the original, restarted state, and watched the current prompt as BTCPay does. Output: `OldWalletState=settled`, `WatchedOld=false`, `EmittedSettlementCount=0`. This finding combines an integration path traced in source with a component reproduction. We did not run a complete BTCPay/PostgreSQL restart test.

   **Fix direction:** persist and restore the link between every minted hash that can still be reconciled and its host invoice, including superseded prompts. Make sure BTCPay can consume settlement for those old hashes after a restart.

6. **P1 — BTCPay supersedes a potentially funded swap using stale provider state, then stops its recovery polling.**

   Sources: [SwapService.cs:203](/Users/perls/workspace/openrecieve/packages/dotnet/BTCPayServer.Plugins.OpenReceive/Swaps/SwapService.cs:203), [SwapService.cs:364](/Users/perls/workspace/openrecieve/packages/dotnet/BTCPayServer.Plugins.OpenReceive/Swaps/SwapService.cs:364).

   A second create request in the last 60 seconds of the deposit window marks the old order `expired` based on cached database state. The provider may already know about a deposit or a refund requirement that the poller has not seen yet. That deposit or refund then drops out of the active workflow. Terminal rows stop provider polling, and GET just returns the stale row. Funds can stay at the provider with no refund prompt and no automatic recovery. The operator or provider may still recover them by hand.

   **Evidence:** we set the fake provider to `refund_required` while the persisted row still said `awaiting_deposit`. A create at expiry minus 59 seconds expired the original. Later polling and GET kept reporting terminal expiry with no refund reason.

   **Fix direction:** retire payment instructions separately from provider recovery. Refresh from the provider before deciding on a replacement. Keep old orders eligible for deposit and refund discovery after replacement.

7. **P1 — Oldest-first batches and restarting capped scans can permanently starve paid attempts.**

   Sources: [sql-payments.ts:249](/Users/perls/workspace/openrecieve/packages/js/http/src/sql-payments.ts:249), [reconcile-gate.ts:133](/Users/perls/workspace/openrecieve/packages/js/http/src/reconcile-gate.ts:133), [core/payments.ts:152](/Users/perls/workspace/openrecieve/packages/js/core/src/payments.ts:152). Rails, Python and PHP also use a fixed oldest-first pending batch.

   Every pass selects the same oldest 200 pending attempts. Every capped wallet walk starts again at offset zero. The default request-path cap is 50 pages of 20 transactions. If the cap is not enough to resolve those old attempts, they correctly stay pending. But nothing moves the next pass forward: no cursor, no rotation, no narrower window. Newer paid rows can never enter the repository batch. A wallet that only exposes paid history, or drops old unpaid invoices, triggers this after more than 1,000 later incoming transactions.

   **Evidence:** we used the real Node SQL repository and core scanner with 200 old unresolved attempts plus one newer paid attempt. Three passes made 300 wallet page calls, returned zero decisions, and left the paid attempt pending. Its transaction was even in the returned history, but the attempt was outside the repository batch. Every later pass selects the same rows and window. We ran the exact capped-history reproduction in Node only. For the other languages we reviewed the matching batch policy in source.

   **Fix direction:** guarantee forward progress with durable scan cursors or window partitioning, and select attempts fairly. Keep the existing rule that a truncated scan cannot prove absence. Simply closing the rows a scan skipped would turn this into data loss.

8. **P2 — Ruby, Python, and PHP can report settled after the fulfillment transaction rolled back.**

   Sources: [Ruby reconcile.rb:193](/Users/perls/workspace/openrecieve/packages/ruby/openreceive-rails/lib/openreceive/reconcile.rb:193), [Python reconcile.py:245](/Users/perls/workspace/openrecieve/packages/python/openreceive/src/openreceive/server/reconcile.py:245), [PHP Reconciler.php:249](/Users/perls/workspace/openrecieve/packages/php/openreceive/src/Server/Reconciler.php:249).

   These reconcilers catch failures in the settlement callback, but still return the original wallet check as settled. The HTTP check route serves that result instead of the committed attempt status. The browser treats it as terminal and stops polling. Without the optional worker or unrelated later traffic, a transient callback failure loses its automatic retry trigger. The pending row is not destroyed, so a later reconciliation can still recover it.

   **Evidence:** separate Ruby, Python and PHP reproductions returned HTTP 200 with `status=settled`. Meanwhile the database row stayed pending and host fulfillment had rolled back. Node's normal database path propagates the combined delivery failures, so it does not have this false success.

   **Fix direction:** leave failed settlement results out of the success response, or serve the committed status or a retryable failure. Keep processing the other entries in the batch, but keep each entry's own persistence outcome.

9. **P2 — Late browser responses can show another order's payment instructions.**

   Sources: [checkout-session.ts:219](/Users/perls/workspace/openrecieve/packages/js/browser/src/internal/checkout-session.ts:219), [checkout-session.ts:288](/Users/perls/workspace/openrecieve/packages/js/browser/src/internal/checkout-session.ts:288), [element-checkout-session.ts:157](/Users/perls/workspace/openrecieve/packages/js/elements/src/element-checkout-session.ts:157).

   The shared session captures a reference for each request but does not check it again after awaits. Suppose a host reuses the checkout component for order B while a mint or swap for order A is still in flight. A's delayed response can then overwrite B's state. React keeps the shared session across renders. The elements keep it across attribute changes, so the wrappers built on them are affected too.

   **Evidence:** a real custom-element DOM test switched from A to B, prepared B successfully, then resolved A's delayed mint. The element reset its reference to A and showed A's payable invoice. A separate shared-session swap reproduction merged A's hash and deposit address into B's snapshot. That made B's polling fail ownership checks. A payer who pays the displayed instructions credits A while intending to pay B.

   **Fix direction:** invalidate session requests when the reference or endpoint identity changes. After every await, check the captured identity or generation before publishing instructions or errors.

10. **P2 — BTCPay hides recovery for existing swaps when creating a new swap is no longer allowed.**

    Sources: [SwapService.cs:175](/Users/perls/workspace/openrecieve/packages/dotnet/BTCPayServer.Plugins.OpenReceive/Swaps/SwapService.cs:175), [CheckoutPaymentExtension.cshtml:11](/Users/perls/workspace/openrecieve/packages/dotnet/BTCPayServer.Plugins.OpenReceive/Views/Shared/OpenReceive/CheckoutPaymentExtension.cshtml:11), [openreceive_swap_checkout.js:54](/Users/perls/workspace/openrecieve/packages/dotnet/BTCPayServer.Plugins.OpenReceive/Resources/js/openreceive_swap_checkout.js:54).

    The plugin checks whether a new swap may be created before it looks up an existing swap. The checkout hides the swap and refund UI when availability is false. So reloading an existing funded or `refund_required` swap can fail when the invoice has too little life left, receives a partial payment, or becomes nonpayable.

    **Evidence:** a persisted `refund_required` swap could not reopen when the invoice had 29 minutes left and new swaps required 30. Manual GET and refund still work if you kept the swap ID. Provider credentials are not deleted.

    **Fix direction:** resolve existing attempts before applying the new-swap eligibility check. Render their status and refund recovery whether or not new swaps are offered.

11. **P2 — The Node Knex/PostgreSQL adapter rejects the repository's parameterized SQL.**

    Source: [orm-adapters.ts:35](/Users/perls/workspace/openrecieve/packages/js/http/src/orm-adapters.ts:35).

    The repository renders PostgreSQL placeholders as `$1`, `$2` and so on. The adapter passes them, with a bindings array, to `knex.raw`. Knex compiles its own `?` placeholders and rejects this combination before sending anything to the database. So reads, attempt persistence and reconciliation all fail through this advertised adapter. Creating a new payment usually fails safely with an error. Existing attempts cannot be credited while the host uses this adapter. The existing real-ORM tests use SQLite, not PostgreSQL.

    **Evidence:** the actual installed Knex compiler, called through `knexDb`, rejected `SELECT ... WHERE reference = $1` with one binding: `Expected 1 bindings, saw 0`. This fails before dispatch, so no PostgreSQL server was needed.

    **Fix direction:** implement a parameter path that suits Knex while preserving host SQL literals and operators. Add a real PostgreSQL adapter integration check.

**Validation and reproducibility**

The existing checks and our isolated reproductions complement each other. The existing suites passed, but they did not cover these edge cases. We kept the reproduction files outside the source tree. They deliberately assert the current faulty behavior, so they are neither fixes nor regression tests.

- `npm run check`: passed contract/vector validation, the secret scan and the naming check.
- `npm run typecheck`: passed.
- `npm test`: 678 passed, zero failures or skips on the final run. The first sandboxed run had 676 passes and two CLI failures with `EPERM` on localhost binding. With binding allowed, `node --import tsx --test tests/cli-doctor.test.mjs` passed all nine tests, and then the full run passed.
- `npm run test:ruby`: 258 runs, 1,713 assertions, zero failures, errors or skips, plus cross-language conformance.
- Python focused command from `packages/python/openreceive`: `.venv/bin/python -m pytest tests/server/test_app.py tests/storage tests/django/test_repository.py tests/vectors/test_wallet_scan_truncation.py tests/vectors/test_nwc_request_response.py`: 48 passed.
- Full Python command from `packages/python/openreceive`: `.venv/bin/python -m pytest tests -q`: 403 passed once local test-relay sockets were allowed. The first restricted run failed the socket fixtures with permission errors. Two dependency deprecation warnings remained. `packages/python/openreceive/.venv/bin/python tools/conformance/python-crosslang.py` also passed.
- PHP focused command from `packages/php/openreceive`: `php vendor/bin/phpunit tests/Server/EngineTest.php tests/Server/ServiceReconcileTest.php tests/Storage tests/Vectors/WalletScanTruncationTest.php tests/Vectors/NwcRequestResponseTest.php`: 34 tests, 255 assertions, passed.
- `npm run test:php`: all three packages passed, 113 tests and 969 assertions in total (Laravel 21, core 90, WordPress 2), plus Composer manifest validation and cross-language conformance. The two WordPress tests are unit tests, not a running WooCommerce integration.
- Frontend: `LOG_LEVEL=error node --import tsx --test tests/browser-checkout-controller.test.mjs tests/element-lifecycle.test.mjs tests/react-checkout-behavior.test.mjs tests/wrapper-behavior.test.mjs tests/wrapper-parity.test.mjs`: 89 passed, zero failures or skips.
- BTCPay: `/Users/perls/.dotnet/dotnet packages/dotnet/BTCPayServer.Plugins.OpenReceive.Tests/bin/Debug/net10.0/BTCPayServer.Plugins.OpenReceive.Tests.dll -noColor -class '*Swaps.SwapServiceTests' -class '*Nwc.ScanMemoTests' -class '*Nwc.ReceiveOnlyNwcClientTests'`: 80 passed, zero skipped, against rebuilt sources. Standard VSTest hit sandbox socket restrictions, so we used the in-process runner, which succeeded.
- `OPENRECEIVE_LIVE_CREATE_INVOICE=0 OPENRECEIVE_LIVE_WAIT_FOR_PAYMENT=0 npm run test:live:nwc`: with network access, passed wallet preflight, receive checkout ready, NIP-44 v2. The first attempt, with restricted network, failed to connect. No invoice was minted and no payment was made.

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

What each reproduced:

- Node: three cases.
- Ruby: two cases with 12 assertions.
- Python: the false success, and the rollback/retry duplication.
- PHP: the false success.
- Browser: three cases plus one real DOM lifecycle case.
- BTCPay: three component scenarios.
- Knex: an extra inline compiler reproduction, described in finding 11.

**Limits:**

- We did not run live payment or refund transfers, real PostgreSQL/MySQL concurrency fault injection, a full BTCPay restart E2E, or Docker demo/browser E2E.
- We reviewed WordPress lifecycle, fulfillment and migrations in source only. We did not inject WooCommerce storage failures in a running installation.
- We deliberately did not run `npm run test:ci`. This was a source audit whose only repository change was the report, not a route, schema or release change.
- We found no separate path that runs an unintended destructive migration or deletion. We confirmed no double-credit defect on the normal Rails or BTCPay path. Django's after-commit boundary is the confirmed duplicate-delivery case.

Because of these limits, the audit does not prove that no other loss paths exist.
