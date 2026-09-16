# BTCPay Server plugin changelog

## 0.4.10 — release candidate

Addresses both findings of the Plugin Builder review of 0.4.8.0. The plugin
version skips 0.4.9 to match the npm and gem release of 2026-09-16; the
plugin's version stays independent of those releases.

- **Settings API no longer discloses Lightning credentials.** The
  `GET /api/v1/stores/{storeId}/openreceive/settings` route (permission
  `CanViewStoreSettings`) returned the raw first field of a store's
  Lightning connection string when the backend was not OpenReceive. For
  BTCPay's `lndhub://login:password@…` form, and for key=value strings
  written server-first, that field carried the credential — for any store on
  the installation. `lightningNode` now names only the backend type word
  (`lndhub`, `lnd-rest`, `eclair`, …), or the redacted OpenReceive string as
  before, and the helper never throws. Every other view-only response was
  audited: swap rows omit the provider token and the BOLT11, swap-connect
  codes appear as booleans only, the preflight snapshot is non-secret.
- **Every monitored invoice stays reconcilable across pagination, long
  expiry and restart.** The scan memo no longer walks a fixed 24-hour,
  500-row window. It watches the hashes BTCPay monitors (every invoice
  minted here and every hash BTCPay asks about) and walks
  `list_transactions` for exactly those, from the oldest watched pending
  invoice, stopping once every watched hash is seen — the same targeted
  reconcile pass the Node and Ruby engines run. A watched hash leaves the
  set only when the wallet's row is terminal, when a complete walk at or
  after its expiry plus 900 seconds still shows it unpaid, or when the wallet
  proves it absent. A hash a truncated walk cannot reach falls back to
  `lookup_invoice` when the wallet grants it and otherwise stays pending and
  watched; it is never closed. A hash of unknown age (asked about after a
  restart) is looked up first when granted, else walked once without a lower
  bound. Wallet capabilities, including `lookup_invoice`, are learned from
  the wallet's info event when the connection is created, so a restart no
  longer waits for a preflight. Nothing watched costs no requests, so the
  everyday request budget drops.
- Lightning invoices are minted for at most 24 hours, whatever the store's
  invoice expiration asks for: most NWC wallets allow no more, and a wallet
  that clamped a longer request would have failed the plugin's expiry check
  and left the checkout without Lightning. Saving the wallet lowers a store
  expiration above 24 hours to 24 hours so the checkout timer and the
  invoice agree; the doctor flags a setting raised afterwards.
- The doctor's "Last wallet scan" probe shows how many invoices the memo
  watches and whether any could not be reached, and "Invoice expiration
  within the scan window" became "Invoice expiration within a day".
- Regression coverage: a unit table and a docker integration test (a
  view-only API key against an lndhub backend with a known password) for the
  settings route; and, through the production client and both listeners
  against the testkit wallet: a paid invoice buried under 1,200 newer rows,
  an invoice older than 24 hours, a restarted connection with no
  capabilities recorded (with and without `lookup_invoice`), a wallet that
  ignores `offset` (fallback to `lookup_invoice`; stays Unpaid and watched
  without it), dropped notifications, and a wallet without notifications.

### Validation record — 2026-09-16

`npm run test:dotnet` passed (323 .NET tests in the SDK container).
`npm run test:btcpay:latest` passed against latest stable BTCPay 2.4.4
(source commit 2d5a0d80, matching the pinned commit): the unit suite plus the
Chromium preflight/save/reload/checkout smoke (run before the 24-hour expiry
cap was added; the cap is covered by the unit and integration suites that ran
after it). The docker regtest stack (`docker/up.sh` + `docker/test-e2e.sh`)
passed all 6 integration tests, including the new view-only-key credential
test against an `lndhub://` backend and the lowered store timer on wallet
save. `npm run check` passed. The official PluginPacker produced a 0.4.10.0
package (11 files, no host assemblies) requiring BTCPay `>=2.4.4`.
The Release build reports upstream warning NU1902 for
`Microsoft.Build.Tasks.Git` 8.0.0; it has not been suppressed.

Real payments, provider deposits/refunds, a second Alby Hub, and coexistence
with the Nostr plugin were not exercised in this release session; see
[`docs/internal/btcpay-e2e.md`](../../docs/internal/btcpay-e2e.md).

## 0.4.8 — release candidate

- Fix saving an OpenReceive wallet as the store's Lightning backend on
  BTCPay Server 2.4.4. The plugin now passes the required store argument to
  `PaymentMethodConfigValidationContext` and builds against BTCPay 2.4.4.
- Require BTCPay Server 2.4.4 or later. The receive-only NWC connection and
  wallet permissions do not need to change when upgrading from 0.4.7.
- Add a browser regression check covering wallet preflight, saving the
  backend, reloading settings, and opening a Lightning invoice checkout.
- Check compatibility against the latest stable upstream source and runtime
  automatically, in addition to the pinned BTCPay version.
- Add `npm run demo btcpayserver` for local browser testing with the root
  `.env` wallet and swap providers; `--testkit` uses funded regtest wallets.

### Validation record — 2026-09-15

`npm run test:btcpay:latest` passed for 0.4.8 against latest stable BTCPay
2.4.4: 283 .NET tests plus the Chromium preflight/save/reload/checkout smoke.
The pinned and latest source commits matched.

`npm run test:ci`, `npm run check`, and `npm run check:workflows` passed.
The official PluginPacker produced a 0.4.8.0 package requiring BTCPay
`>=2.4.4`. The Release build reports upstream warning NU1902 for
`Microsoft.Build.Tasks.Git` 8.0.0; it has not been suppressed.

Before preparing this candidate, the BTCPay 2.4.4 demo passed receive-only
Rizful NWC preflight (`nip44_v2`), saved the live wallet as the Lightning
backend, and passed browser login and both configured swap providers' read-only
catalog probes. Credentials remained absent from the setup form fields.

Real payments, provider deposits/refunds, a second Alby Hub, and coexistence
with the Nostr plugin were not exercised in this release session. Those
manual scenarios remain unverified; see
[`docs/internal/btcpay-e2e.md`](../../docs/internal/btcpay-e2e.md).
