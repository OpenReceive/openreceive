# BTCPay Server plugin changelog

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
