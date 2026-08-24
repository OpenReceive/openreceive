# Shared test vectors

Cross-language conformance data. Every applicable vector runs in BOTH engines:
the JS suite (`tests/`) and the Ruby harness
(`tools/conformance/ruby-crosslang.rb`, wired into `npm run test:ruby` and CI).
A schema or route change must update its vector in the same change.

Formats in use (one per file family):

- **`schema_version` + `cases`** — most vectors. Each case has a `name`, an
  input, and an `expected` result (or `expected_error` code); sibling top-level
  keys (`rule`, `decision`, `algorithm`, …) document the behavior under test:
  `fiat-to-msats.usd`, `amount-boundaries`, `settlement-detection`,
  `make-invoice-validation`, `nwc-uri-parse`, `nwc-request-response`,
  `error-normalization`, `nwc-info` (NIP-47 info events normalized into receive
  capabilities and an encryption mode), `swap-address` (checksum validation of
  refund/deposit addresses), `rate-limit-window` (which timestamp column the
  per-IP budget counts on — `inserted_at` — plus the
  `(client_ip, inserted_at)` index and window-membership cases).
- **`version` + `valid`/`invalid`** — `lsc-uri`: parse expectations for valid
  `lightning+swapconnect://` URIs and a list of URIs that must be refused.
- **`expiry_grace_seconds` + `vectors`** — `attempt-reconciliation`: the
  decision table for closing pending attempts, plus the shared grace constant.
- **`page_limit` + `cases`** — `wallet-scan-truncation`: truncated
  wallet-history walk semantics for `reconcilePaymentAttempts` /
  `reconcile_payments`. A walk cut short (page cap, pass deadline, or a wallet
  that ignores `offset`) must OMIT undecided hashes rather than report
  `not_found`, so a truncated scan can never close a paid attempt.
- **`http-golden/*.json`** (`schema_version: 2`) — one HTTP request/response
  expectation per file, run against the JS handler and the Ruby Rack app.
  `request` is the wire request: `method`, `path`, a JSON `body` (or
  `body_bytes`, an oversized synthetic body), an optional `content_type`
  (default `application/json`), and optional extra request `headers`, sent
  verbatim. An optional `handler` selects a preconfigured handler (e.g.
  `rate_limited`). `expected` carries the `status`, the FULL
  response `body`, and any `headers` that must be present (names compared
  case-insensitively; other response headers may exist). Both harnesses
  deep-compare the whole body — key set AND values — so an extra or missing
  field in either engine fails the run.

  Dynamic values use placeholder strings, which both harnesses treat as
  "present and matching this pattern" (this is the only normalization
  mechanism; there is no volatile-key replacement list):

  | Placeholder        | Matches                                             |
  | ------------------ | --------------------------------------------------- |
  | `<request_id>`     | `req_` + lowercase UUID (`req_[0-9a-f]{8}-…{12}`)   |
  | `<payment_hash>`   | 64 lowercase hex characters                         |
  | `<bolt11>`         | non-empty string starting with `ln`                 |
  | `<unix_seconds>`   | non-negative integer                                |

  Placeholders work in `body` values and `headers` values alike. The matcher
  tables live in `tests/http-boundaries.test.mjs` and
  `packages/ruby/openreceive-server/test/server_test.rb` and must stay
  identical — change both together.
`provider-route.*.json` files (`request` + `expected`) describe provider wizard
routes and are consumed by the provider-data tests.
