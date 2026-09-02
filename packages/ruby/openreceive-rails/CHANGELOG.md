# Changelog

## 0.4.1 - 2026-09-02

Version lockstep with the 0.4.1 npm release. First version published from CI
through RubyGems Trusted Publishing (`.github/workflows/publish-gems.yml`)
instead of a maintainer's API key and OTP. No functional change in this gem.

## 0.4.0 - 2026-09-02

Version lockstep with the 0.4.0 npm release. The generated initializer's
`config.authorize` comment now states the resource guarantee:
`context[:resource][:reference]` is always a validated non-empty String
(200 characters or fewer) by the time the lambda runs, and `payment_hash` is
nil except on `payment.check`, `swap.read`, and `swap.refund`. No functional
change.

## 0.3.3 - 2026-09-02

### A missing migration says so, with the fix

When the `openreceive_meta` table is absent, the engine now raises
`OpenReceive::ConfigurationError` naming the exact commands —
`bin/rails generate openreceive:install`, then `bin/rails db:migrate` — and
linking the storage guide, instead of leaking a raw
`ActiveRecord::StatementInvalid` from the first query. The check runs only on
request-serving paths, so `db:migrate`, `db:prepare`, and the generator are
unaffected, and a healed database is retried rather than remembered as broken.

### NWC configuration errors reach Node parity

A missing `NWC_URI` explains the receive-only requirement and links the
get-a-code page (still starting with the pinned "Set NWC_URI"); a malformed
one is framed as "set, but not a valid NWC code" with the parse reason and the
same URL, instead of surfacing the bare parse error. `validate!` failures
(authorize, amount_for, on_paid, rate limiting, opportunistic reconcile) each
state their fix and link the owning guide, and the rate-limiting client-IP
warning links the rate-limiting guide.

### The gem carries the agent skills

`skills/` ships in the gem — the integrate and debug playbooks for coding
agents, kept byte-identical to the repository tree by
`npm run generate:skills`.

## 0.3.2 - 2026-08-29

No changes to this gem in 0.3.2. The release is the overpaid-deposit refund
mapping in `openreceive-server` and the browser packages' `resumePaymentHash`
resume path; the engine, its generators and the doctor task are byte-identical
to 0.3.1 and ship to keep the one-version-for-everything rule.

The Rails demo at `examples/buttons/server/rails` gained a testkit mode and a
`/checkout/:reference` route in this release. Neither is part of this gem.

## 0.3.1 - 2026-08-28

### The generated allow-all `config.authorize` is no longer silent

`openreceive:install` writes a `config.authorize` that allows every request,
treating possession of the reference as the authorization. It is now the named
constant `OpenReceive::ALLOW_ALL_AUTHORIZE`, for the same reason
`LOGGING_ON_PAID` is a constant: the engine detects it at boot by identity and
warns that anyone holding an order id can mint invoices, poll status and request
refunds for it. Safe only while references are unguessable. The five-minute demo
still works; it just stops being quiet about what it is.

### `bin/rails openreceive:doctor`

Step 0 of the agent directions as one command. It reports credential PRESENCE
only — every line is `set` or `unset`, and no secret is printed, echoed or
partially shown, which is what makes it safe to run in a shared terminal or
paste into an issue. Alongside that: whether `OpenReceive.configure` ran, which
hooks are missing or still the generated placeholders, where the engine is
mounted, and a wallet preflight.

The wallet line is last and best-effort. It builds the service — the same eager
preflight production boot runs, so a missing `NWC_URI`, a dead relay or a
SPEND-CAPABLE connection all answer here rather than on a payer's first checkout
— and reports the failure sanitized rather than raising it, because a doctor
that dies at line six tells an operator less than one that finishes.

"Look for `NWC_URI` in this app's server environment" has a different answer on
every host shape, and in a containerised app grepping the repo finds the name in
a compose file and proves nothing about the value. This asks the process, which
is the only place that always knows.

## 0.3.0 - 2026-08-26

### `config.amount_for` may return a `:description` beside the price

One optional display string — what the payer is buying — returned from the same
hook that already answers the price:

```ruby
config.amount_for = lambda do |reference|
  order = Order.find_by(reference: reference)
  next nil unless order
  { currency: "USD", value: order.total.to_s, description: "#{order.line_items.size} items" }
end
```

The engine peels it off before the amount reaches the minting service, and the
handler echoes it on the prepare and create responses, where both shipped
checkout renderers draw it above the amount. Deliberately one string and not a
line-item schema: OpenReceive owns no orders. The install generator's
initializer documents it inline.

The full release narrative lives in the repository-root
[CHANGELOG](https://github.com/openreceive/openreceive/blob/master/CHANGELOG.md).

## 0.2.4 - 2026-08-26

No Ruby changes in this release. 0.2.4 is browser-side only —
`@openreceive/browser`, `@openreceive/elements`, `@openreceive/react` and
`@openreceive/provider-data`. This gem is byte-identical to 0.2.3 and ships to
keep the one-version-for-everything rule, so the engine, the HTTP contract and
the settlement path are unchanged. The full release narrative lives in the
repository-root
[CHANGELOG](https://github.com/openreceive/openreceive/blob/master/CHANGELOG.md).

## 0.2.3 - 2026-08-25

The Ruby gems release in lockstep with the npm workspace version. The full
release narrative lives in the repository-root
[CHANGELOG](https://github.com/openreceive/openreceive/blob/master/CHANGELOG.md);
entries here are scoped to this gem.

- The mounted engine inherits `openreceive-server`'s `POST /checkouts` change:
  the response now carries `payment_methods` alongside `checkout` (HTTP
  contract 0.4.1). No configuration change; hosts using `@openreceive/browser`
  see no difference.

## 0.2.2 - 2026-08-25

The Ruby gems release in lockstep with the npm workspace version. The full
release narrative lives in the repository-root
[CHANGELOG](https://github.com/openreceive/openreceive/blob/master/CHANGELOG.md);
entries here are scoped to this gem.

- **Fixed: the generated migration would not load.** `openreceive:install` wrote
  `class CreateOpenreceiveTables`, but the engine's own acronym inflection makes
  Rails resolve the file name to `CreateOpenReceiveTables`, so
  `bin/rails db:migrate` failed with `NameError` on every install. The template
  declares the class Rails looks for, and a new generator test registers the
  acronym and runs the migration for real.
- **`nwc-ruby` is now a runtime dependency.** Building the client from `NWC_URI`
  is this gem's DEFAULT wallet path, so installing only `openreceive-rails`
  used to boot fine and then 500 on the first checkout with
  `Install nwc-ruby or configure nwc_client.` `config.nwc_client` remains the
  override for hosts bringing their own client.
- **Fixed: the boot preflight failed `assets:precompile`.** An image build is a
  production boot with no wallet secrets mounted, so the eager preflight failed
  the build rather than the deploy. Asset builds are now detected
  (`SECRET_KEY_BASE_DUMMY`, or an `assets:precompile`/`clean`/`clobber` rake
  invocation) and skipped with a log line.
- **Added `config.eager_preflight`** (default `true`) — the supported opt-out
  for any other boot that must come up without wallet secrets. It disables the
  BOOT check only; the wallet is still checked on the first request, and a real
  production boot with no `NWC_URI` still fails closed.
- The generated migration's `payment_hash` check constraint hoists its adapter
  branch to a local, so the first file a developer opens after running the
  generator reads as ordinary Ruby.

## 0.2.1 - 2026-08-24

The Ruby gems release in lockstep with the npm workspace version. The full
release narrative lives in the repository-root
[CHANGELOG](https://github.com/openreceive/openreceive/blob/master/CHANGELOG.md);
entries here are scoped to this gem.

- Packaging only: `npm run release:gem:build` now names the built `.gem` with
  the version RubyGems actually mints, so prerelease versions build and push.

## 0.1.1 - 2026-08-18

- First packaged release of `openreceive-rails`: the mountable engine, the
  engine-owned `OpenReceivePayment` model and reconciliation, and the
  `openreceive:install` generator.
- `config.price_provider` defaults to the built-in live price feed, and swap
  providers auto-build from `LSC_URI_PRIMARY`/`LSC_URI_BACKUP` — matching the
  Node engine's `createOpenReceive` defaults.
