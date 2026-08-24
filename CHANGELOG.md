# Changelog

## 0.2.1 - Unreleased

## 0.2.1

First test publish to NPM and RubyGems

### Second audit sweep

A second full-repo audit fixed 24 correctness bugs, removed 22 trust-model
violations, closed 7 wrapper-parity gaps, and finished the `order_id` →
`reference` rename. The behavior changes worth knowing:

- **Settlement.** A notified `payment_received` now checks pendingness BY HASH
  (`payments.findPendingAttempt`) instead of membership in the oldest-200
  batch, so a notified settlement no longer waits for a backlog to drain.
  A reconcile result that reports `settled` with no `paidAt` is reported as a
  failure instead of skipped silently, and the request-path reconcile pass now
  runs AFTER the body's cheap refusals so an anonymous garbage POST cannot
  claim the gate. Rails exempts unauthenticated `GET /rates` from the pass,
  matching the JS handler.
- **Wallet scans.** A `list_transactions` page whose rows are all unusable now
  fails the scan in both engines rather than reading as an empty wallet — an
  empty-looking scan at expiry+grace closes unpaid attempts. Within a page, a
  row whose PRESENT fields cannot be read (a non-hex `payment_hash`, an
  unparsable amount) is skipped and counted; absent fields still mean absent.
- **Invoice expiry.** A wallet that clamps expiry no longer fails every
  checkout: the ledger stores the wallet's own `expires_at` and logs
  `checkout.invoice_expiry.adjusted`. A caller-supplied `expirySeconds` (only
  the swap path sets one) stays a hard floor, and only when the wallet comes
  in short.
- **Swaps.** Provider transport failures on `/swaps`, `/swaps/status` and
  `/swaps/refunds` map to 502/503 instead of a generic 500. A provider order
  without an expiry fails the create rather than inventing a 10-minute window,
  and a provider amount that is present-but-unparsable throws instead of
  vanishing. When every configured provider fails its catalog fetch, methods
  report `provider_unreachable`, not `provider_unconfigured`. A 429 backoff no
  longer resets when the weight window rolls.
- **Checkout UI.** `startSwap` now quotes before it starts, in the SHARED
  session, so React and the custom element behave identically — an
  out-of-range amount is an accepted-range panel in both, built from one
  `createSwapUnavailableModel`. Expired-mid-swap keeps the wizard in both. The
  refund review gate is explicitly client-side: `refund_nonce` and
  `refund_nonce_expires_at` are gone from the browser wire types (the server
  never sent them), and `SwapDisplayModel` carries `refundAllowed: boolean`.
  A swap deposit QR that cannot encode its amount now throws instead of
  silently degrading to an amount-less payment URI.
- **Renames.** Option types match their factories (`CreateHostOptions`,
  `CreateStackOptions`, `CreateHttpHandlerOptions`, `DefineElementsOptions`,
  …). `@openreceive/browser` exports `createLightningUri` / `createQrSvg` /
  `createQrPngDataUrl` under those names on both entry points, and no longer
  exports the internal `readJsonResponse`. The adapter packages no longer
  re-export the 14 generated `Wire*` body types (still on
  `@openreceive/http`). Ad-hoc app-route console loggers are
  `createAppConsoleLogger` / `createAppBrowserConsoleLogger`, so `Host` names
  only the persistence object.
- **New.** `createStack` takes `onBootFailure`, and a failed boot answers
  `503 WALLET_UNAVAILABLE` in the error contract instead of rethrowing the raw
  cause. `payInAssetNetwork` in `@openreceive/core` owns the
  `pay_in_asset` → network split that four call sites re-derived.

### ORM handles wrap in one call: `knexDb`, `prismaDb`, `typeOrmDb`, `sequelizeDb`

- `@openreceive/http` ships a named `SqlAdapter` factory per ORM whose handle
  `createSqlPayments` cannot accept directly. The parameter types are
  structural (no ORM dependency); `dialect` stays a required argument. The
  guide's copy-paste recipes are gone — and the shipped `prismaDb` fixes a bug
  the Prisma recipe carried: only `^select` statements ran through
  `$queryRawUnsafe`, so an `UPDATE … RETURNING` fulfillment claim (the
  guide's own `onPaid` example) lost its rows and never fulfilled.
- `sequelizeDb` closes the last gap: Sequelize was a first-class scaffold flag
  whose only documented wiring was "open a second `pg` Pool to the same
  database, or hand-roll an adapter". It binds parameters through Sequelize's
  `bind` option and threads the managed transaction into every statement
  inside it — Sequelize carries the transaction on the same instance, so a
  hand-rolled adapter that missed that ran settlement outside the transaction.
- The scaffold's wiring guide no longer prints hand-rolled `SqlAdapter`
  snippets for Prisma/Knex/TypeORM/Sequelize; each section is now the shipped
  factory in one line.
- `npm run test:orms` proves the factories against the real ORMs: knex,
  typeorm, and prisma (7, via its better-sqlite3 driver adapter) each drive
  the payments repository — commit, write-once settlement, reconcile-gate
  CAS — on sqlite. Weekly `orm-adapters` job in `demos.yml`; the ORMs are
  devDependencies only. The no-database-driver gate now checks the root
  workspace manifest on its runtime dependencies (package and example
  manifests stay strict in full) so the lane's sqlite driver can exist at
  dev time.

### The browser's swap requests no longer throw `Illegal invocation`

- Every swap route call (`/swaps`, `/swaps/quote`, `/swaps/status`,
  `/swaps/refunds`) invoked the caller's fetch as a method of its options
  object, rebinding `this` — and `window.fetch`, the default, throws
  `Illegal invocation` for any `this` but the window. The swap flow was
  broken in real browsers across all four wrappers; the e2e swap specs catch
  it now. Checkout and status requests always bare-called a local and were
  unaffected.

### Cross-site requests are refused by the handler; the Rails engine inherits `protect_from_forgery`

- Every body-bearing route now answers `415` for a body that is not
  `application/json` and `403` for a request the browser labels
  `Sec-Fetch-Site: cross-site`, in both engines and before `authorize` runs. A
  cross-site form cannot set a JSON content type, a cross-origin `fetch` that
  does is CORS-preflighted (never answered), and the `Sec-Fetch-Site` gate
  covers the remaining `no-cors` forgery. Golden vectors `11` and `12` pin
  both refusals; vectors may now declare extra request `headers`.
- `OpenReceive::ApplicationController` no longer calls
  `skip_forgery_protection`: the host's `protect_from_forgery` applies to the
  engine's routes as it does to the host's own, and a failed check is the
  shared `403` instead of an opaque `500`. The browser client sends
  `X-CSRF-Token` from `<meta name="csrf-token">` on every request when the
  page renders one (`csrf_meta_tags`), from one shared `requestHeaders`
  helper; a host `headers` value still wins. The Rails demo drops its
  `:null_session` override and runs Rails' default.

### `reference`, not `order_id`: the host's order is not part of the story

- The grouping key OpenReceive stores is now called `reference` everywhere —
  the `openreceive_payments` column, every HTTP request and response body,
  the browser snapshots, the `<Checkout reference>` prop (`route-reference`
  for the element wrappers), `AuthorizeResource.reference`, and the
  settlement passed to `onPaid` / `config.on_paid` (`PaymentSettlement`,
  formerly `OrderSettlement`). It is a string the host chooses — its order
  id, one per payable thing and never reused — that OpenReceive groups
  attempts under and fulfills at most once. Rails hosts recreate the engine tables
  (`bin/rails db:reset` on a development database).
- `loadOrder` + `amountForOrder` collapsed into one hook: `amountFor(reference)`
  returns the trusted price or `null` for a 404 (Rails: `config.amount_for`,
  `nil`). The host is consulted only where a price is minted or quoted; status
  polls and refunds are answered from OpenReceive's own rows. This also fixes
  the Rails engine selecting attempts by the loaded object's `.id` rather than
  the id it was given, which broke hosts whose lookup key was not their
  primary key.
- `openreceive:install` no longer takes `--order-model`; the generated
  initializer names no model. `authorize` defaults to possession of the
  reference and `config.amount_for` is left for you to write (the engine
  refuses to serve checkouts until it is set).
- The fulfillment note rendered into every scaffolded migration, the Rails
  initializer, and the wiring guide now says only what OpenReceive guarantees
  about `onPaid` and what the host must guarantee. Its "optional foreign key"
  recipe is gone, as is every "OpenReceive never reads, locks, or joins your
  order table" paragraph in the docs and source — there is no relationship to
  explain. `npx openreceive scaffold payments` rejects the long-removed
  `--order-model`/`--order-table`/`--order-id-type`/`--skip-foreign-key` flags
  as plain unknown options.

### One subpath under the UI: `@openreceive/browser/headless`

- `@openreceive/browser/internal` is gone. It was public API with a
  discouraging name — 130 values and 46 types that `@openreceive/react`,
  `@openreceive/elements`, and the wrappers imported and nothing documented.
  Those names now live on `./headless`, the one curated, documented surface
  the renderers and headless integrations share; 15 names only tests used are
  no longer exported. `npm run check:example-imports` had nothing left to
  reject and is removed.
- `docs/internal/display-boundary-findings.md` was deleted. Its
  display-boundary rule (formatters throw, display boundaries blank) is
  superseded by the AGENTS.md trust model: our own server, the configured NWC
  wallet, and the configured swap provider are trusted, and a throw in a
  checkout panel is our own API surfacing, not a display-boundary bug class to
  defend against.

### The OpenReceive prefix is gone; the import path is the namespace

- 415 exported and internal names drop the `OpenReceive` / `openReceive`
  prefix: `createOpenReceiveHttpHandler` → `createHttpHandler`,
  `createOpenReceiveHost` → `createHost`, `createOpenReceiveStack` →
  `createStack`, `OpenReceiveHttpError` → `HttpError`,
  `OpenReceiveServiceError` → `ServiceError`, `OpenReceiveDecimalError` →
  `DecimalError`, `openReceiveCheckoutLabels` → `checkoutLabels`,
  `formatOpenReceiveMsats` → `formatMsats`, `OpenReceiveWire*` → `Wire*`, and
  so on, one rule throughout. Kept, each for a reason: `OPENRECEIVE_*`
  constants (they read as config keys) and the custom-element tag names;
  `OpenReceive`, `createOpenReceive`, and `OpenReceiveError` (OpenReceive is
  the noun there, and `Error` is taken); the three mounts `openReceiveExpress`,
  `openReceiveFastify`, `openReceiveNextHandlers`; and `markOpenReceivePaidOnce`
  / `createOpenReceiveCheckoutElementAttributes`, which sit beside an
  unprefixed sibling that means something else. Where the bare name was
  already taken the rename picks a clearer one: `openReceiveRoutes` →
  `checkoutRoutes`, `reconcileOpenReceivePayments` → `reconcileHostPayments`,
  `openReceiveClientIp` → `resolveClientIp`.
- `status` is `deriveStatus` (its only in-tree caller already renamed it on
  import), and `OpenReceiveFiatAmount` — a currency-tagged decimal that is
  fiat OR BTC/SAT — is `MoneyAmount`.

### Fewer exports: what nothing outside the package reaches for

- 51 names leave the public surface because no guide, example, smoke check,
  or other package named them — only tests, which now read the source
  modules directly. `@openreceive/node` lists its public types explicitly
  instead of `export type *`, so its service-internal types
  (`NodeOptions`, `OpenReceiveServiceContext`, `ResolvedCreateAmount`,
  `NormalizedCreateCheckoutRequest`) stay internal. Gone, by package:
  - core: the price-feed tuning constants (`OPENRECEIVE_PRICE_FEED_*`,
    `OPENRECEIVE_*_PRICE_FEED_URL`, `OPENRECEIVE_INVOICE_QUOTE_TTL_SECONDS`,
    `OPENRECEIVE_STATIC_BTC_FIAT_RATES`) — `spec/data/rates/price-sources.json`
    is their contract; the `*_URL_ENV` names stay.
  - node: `normalizeNwcWalletError`, `summarizeWalletCapabilities`, the LSC
    env helpers (`parseLscUri`, `readLscConnectionsFromEnvironment`,
    `createLscSwapProvidersFromEnvironment`, `LSC_ENV_NAMES`,
    `LSC_URI_PROTOCOL`), the log-level helpers and
    `createOpenReceiveConsoleLogger`, `requireNwcFromEnvironment`,
    `SPEND_CAPABILITY_WARNING_DELAY_MS`, `isOpenReceiveSwapTerminalState`.
  - http: `resolveSqlAdapter`, `openReceivePaymentInsert`,
    `openReceiveClientIpBucket`, `OPENRECEIVE_DEFAULT_IP_RATE_LIMIT_PER_HOUR`,
    `OPENRECEIVE_ATTEMPT_REUSE_BUFFER_SECONDS`.
  - browser: the console-logger level helpers and
    `createOpenReceiveBrowserConsoleLogger`.
  - elements: `renderCheckoutCreatingHtml`, `renderOpenReceivePaymentWizardHtml`,
    `wireTransactionDetailsCopy`, `OpenReceiveElementsSwapOption`.
  - react: `useCheckoutResume` and its option/result types (unused,
    undocumented); `CheckoutEventHandlers`.
  - provider-data: `listCryptoRoutes`, `getCryptoRoute`,
    `listDisqualifiedProviders` (no caller anywhere).

### `checkPayment` is gone; `reconcilePayments` is the only wallet-history read

- `service.checkPayment`, `@openreceive/core`'s `checkPayment`, and Ruby
  `Service#check_payment` were a one-hash wrapper around the same
  `list_transactions` walk `reconcilePayments` already runs. The mounted
  `POST /payments/check` route never called them. Check one invoice with
  `reconcilePayments({ attempts: [{ paymentHash, createdAt }] })`. A truncated
  walk omits that hash (retry next pass) instead of throwing
  `WALLET_UNAVAILABLE`.

### The all-in-one options say which mode they are

- `createOpenReceiveStack` and the adapters' all-in-one form take
  `wallet: { nwc } | { service }` and `storage: { db, onPaid, tableName? } |
{ payments, onPaid }` instead of five optional, mutually-constrained
  top-level keys. `onPaid`'s parameter type follows the storage branch, the
  "exactly one of nwc or service" runtime check is gone (the type says so),
  and the cast that once landed a custom repository in db mode is gone with
  it.

### The spec's own response shapes are closed

- `PaymentMethod`, `FiatQuote`, and `PaymentDetails` are named, closed
  component schemas; `PrepareCheckoutResponse`, `Checkout`, and
  `PaymentCheck` reference them instead of `additionalProperties: true`.
  `Swap` and `SwapCheckout` compose an open `SwapBase` and close themselves
  with `unevaluatedProperties: false` (OpenAPI 3.1 is JSON Schema 2020-12),
  replacing the hand-copied field list. The generated wire types follow
  (`OpenReceiveWirePaymentMethod`, `OpenReceiveWireFiatQuote`,
  `OpenReceiveWirePaymentDetails`; every wire type is now closed).

### One status vocabulary; one error vocabulary per layer

- `TransactionSettlementStatus` (`pending | settled | expired | failed`) is
  the base every status extends: `PaymentStatus` adds `not_found`,
  `OpenReceiveAttemptStatus` adds `attention`, the browser's `Status` is
  exactly the base. The relationship is now in the types, not only the prose.
  `TransactionSettlementDetection` is readonly like everything else.
- The host's `authorize()` returning `false` is `403 FORBIDDEN` (was
  `UNAUTHORIZED`, which in NIP-47 means the key has no wallet). The HTTP
  error vocabulary drops `INSUFFICIENT_BALANCE` and `PAYMENT_FAILED` — a
  receive-only library can never send them — and a wallet's own `FORBIDDEN`
  still normalizes to `RESTRICTED`. Both engines and the vectors move
  together; Ruby's `UnauthorizedError` is `ForbiddenError`.

### Maintenance

- `swap.providers` is `swap.provider` + `swap.failoverProviders`: the name
  now says what the code always did — failovers are consulted only when the
  primary throws, never to fill assets it omits.
- `prepareCheckout` takes `PrepareCheckoutOptions` (order id, prefix, fetch,
  headers): the type no longer accepts a `memo` it silently dropped.
- The spend-capability warning no longer pauses boot (the 5-second delay
  defaults to 0; nothing in the repo constructs a wallet client from a
  terminal, so there was no CLI site to keep it). The stack's boot-failure
  line logs the error message, not the object and its raw cause.
- `@openreceive/http` describes itself as framework-neutral over Web
  Request/Response and built on the Node runtime. `openReceivePaymentsIndexName`
  measures identifiers with `.length` (they are ASCII by construction) and
  keeps the digest that makes truncated names unique.

- `fixedfloat.ts` (1,134 lines, nine jobs) is six modules along the seams
  its siblings already used — transport, currencies, orders, quote, field
  readers, and the provider assembly. Move-only: the conformance vectors
  prove it.
- The hand-rolled Keccak-256 in the Ruby gem now has known-answer tests
  (NIST/Keccak digests and the EIP-55 specification addresses).

### `openreceive` is the CLI; the library is `@openreceive/*`

- The unscoped `openreceive` package no longer re-exports the library. It
  ships the `openreceive` command only (`npx openreceive scaffold payments`,
  `npx openreceive doctor`), forwarding to `@openreceive/node/cli`. Its 23
  `openreceive/*` subpaths are gone: import the scoped package you installed
  (`@openreceive/express`, `@openreceive/react`, …). One package per install,
  one package per import, and 646 fewer symbols in the public-API snapshot.

### Compatibility ranges are ranges that run

- `@getalby/sdk` `^8` (was `^7`; v8's one breaking change is requiring Node
  22, already this repo's floor). `@openreceive/next` declares
  `next ^14 || ^15 || ^16` (13 dropped; the adapter uses Web
  Request/Response only). `openreceive-rails` requires Rails `>= 8.0` (7.1
  and 7.2 are past security support and were never run here; 8.1 is what CI
  runs).

### Wallet preflight proves receive-only from the connection's own list

- Receive-only is proved from NIP-47 `get_info.methods` — what this
  connection may call — rather than the kind-13194 info event, which
  advertises the wallet service at large. A receive-only connection on a
  service that also serves spend-capable apps now boots; a connection whose
  own list carries `pay_invoice` is still refused. The event still supplies
  encryption modes, and stands in for the method list only when the client
  exposes no `get_info` (logged as `nwc.info_event.methods_fallback`). Ruby
  already read `get_info` first; both engines now agree.
- `AlbyNwcReceiveClient.close()` waits for an in-flight client construction,
  closes the relay client exactly once, and makes later calls reject.

### Naming: camelCase TypeScript, `Checkout` everywhere

- Server-side TypeScript surfaces are all camelCase now: the `authorize`
  resource carries `orderId`/`paymentHash`, and the rate quote carries
  `btcFiatPrice`/`amountSats`/`amountMsats`/`asOf`/`expiresAt`. The wire
  itself stays snake_case.
- The minted invoice is `Checkout` at every layer: the service type `Checkout`
  (was `CheckoutInvoice`), the generated wire body type `WireCheckout` (was
  `OpenReceiveWireCheckout`; from the OpenAPI document, shipped by
  `@openreceive/http`), and the browser's client-held snapshot type
  `CheckoutSnapshot`.
- The advanced rate-limit hook option is `rateLimitHook` (was `rateLimit`), so
  it reads as what it is and composes with the boolean `rateLimiting`.

### `onPaid` in both host modes (`onSettlement` removed)

- The settlement hook is `onPaid` in BOTH host modes; `onSettlement` no longer
  exists. db mode receives `PaymentSettlement` (was
  `OpenReceiveOrderSettlement`: `reference`, was `orderId`, plus the
  transactional `query`); custom-repository mode receives `SettlementEvent`
  (was `OpenReceiveSettlementEvent`: `paymentHash`/`paidAt`/`details`), with
  write-once still enforced by the library.

### Curated exports and the public-api gate

- `@openreceive/express`, `@openreceive/fastify`, and `@openreceive/next`
  re-export only the curated `@openreceive/http` surface: handler/stack
  factories, the error surface, the notification worker, and the
  options/context/hook types. The generated `Wire*` body types (was
  `OpenReceiveWire*`) and the host-integration internals — the SQL payment
  repository, the reconcile gate, `createHost` (was `createOpenReceiveHost`),
  the rate-limit helpers — live only on `@openreceive/http` (and
  `openreceive/http`).
- The UI wrappers export only the wrapper factories plus props/theme types,
  and `@openreceive/core` no longer exports internal formatting helpers
  (`satsToFiatValue`, `formatBtcFromSats`, …).
- A new `npm run check:public-api` gate pins every public surface in CI.
- `trustProxyIpHeader` (opt-in proxy-set client-IP header for `rateLimiting`)
  now exists on all three adapters.

### Scan topology

- Every scan entry point — the opportunistic request-path pass, the
  notification worker's periodic pass, and `startReconciler` (was
  `startOpenReceiveReconciler`) — claims the durable `openreceive_meta`
  reconcile gate, so all of them share the one NWC scan budget.
  Unauthenticated `GET /rates` never triggers a scan.
- `payments/check` serves `payment_methods` from a 60-second per-amount warm
  cache instead of one provider call per poll.
- Superseded rows are excluded from live-attempt matching, and the 409 create
  conflict no longer leaks the live/supersede vocabulary on the wire ("An
  unpaid checkout for this payment method is already in progress for this
  order.").

### `prefix` is the only URL the browser takes

- `prefix` — the base path the shipped router is mounted at — is now the
  single URL input of `@openreceive/browser`, `@openreceive/react`,
  `@openreceive/elements` and the Vue/Svelte/Angular wrappers. All seven
  routes are derived from it (`/checkouts`, `/checkouts/prepare`,
  `/payments/check`, `/swaps`, `/swaps/quote`, `/swaps/status`,
  `/swaps/refunds`), so create and settle can no longer point at different
  mounts.
- Removed: `checkoutUrl` (both the string and the `(orderId) => string`
  callback) on `prepareCheckout`/`requestCheckout` — pass `prefix`, which is
  now required, not optional.
- Removed: `{orderId}` / `{order_id}` templating in checkout URLs. The order
  id travels in the request body, as it already did for every other route.
- Removed: the `orderUrl` prop (React `<Checkout>`, `useCheckout`,
  `PaymentWizard`) and the matching `order-url` element attribute — pass
  `prefix` instead.
- Removed: `orderUrl={false}` as the polling switch. Use `polling={false}`
  (`polling="false"` on the element), which was already the documented knob.
  Behaviour note: `orderUrl={false}` also cut the payment wizard off from
  `/swaps*`, so it silently disabled swaps; `polling={false}` stops status
  polling only and leaves the swap flow working.

### Frontend

- The fiat/country wing and the crypto method tile are removed: the payment
  method union is `"bitcoin"`, and the swap flow is unchanged behind it.
- `@openreceive/elements` and `@openreceive/react` ship self-contained
  compiled `styles.css` files — a plain `<link rel="stylesheet">` works.
- React snapshot mode polls through the default `/openreceive` prefix like
  create mode; `polling` and `poll-interval-ms` (`pollIntervalMs`) knobs exist
  on the element and every wrapper.

### Schema

- `openreceive_payments` gains a locally clocked `inserted_at` column and
  CHECK constraints, and the install migrations seed the shared
  `schema_version` row in `openreceive_meta`. The per-IP rate-limit budget
  counts on `inserted_at` with a `(client_ip, inserted_at)` index in both
  engines (vector: `rate-limit-window.json`).

### Ruby engine parity

- Truncation-safe reconcile: a wallet-history walk cut short (page cap, pass
  deadline, or a wallet that ignores `offset`) omits undecided hashes instead
  of reporting `not_found`, so a truncated scan can never close a paid attempt
  — pinned by the new cross-language `wallet-scan-truncation.json` vector
  family. Each pass takes the oldest 200 pending attempts
  (`RECONCILE_BATCH_SIZE`).
- Schema-version refusal: the engine refuses to operate a database whose
  stored `schema_version` is newer than the library.
- The generated Rails migration supports MySQL alongside PostgreSQL and
  SQLite.
- Production boot builds the service (and its wallet preflight) eagerly, so a
  bad deploy fails closed instead of surfacing checkout-time 500s. The
  initializer template defaults `config.on_paid` to
  `OpenReceive::LOGGING_ON_PAID`, and the engine warns at every boot until it
  is replaced.
- `rake test` works from each gem directory, and the Ruby suites use glob
  test discovery.

### CI

- Per-push `rails-example` job; `check:public-api` runs per push; wrapper type
  checks (`vue-tsc`, `svelte-check`) and real wrapper mount tests.

### Release

- `npm run release:gem:build` works on prerelease versions. RubyGems rewrites
  an npm-style prerelease through `Gem::Version` (`0.2.0-alpha.0` becomes
  `0.2.0.pre.alpha.0`), so the release script no longer guesses the artifact
  filename from the workspace version — it normalizes through Ruby, builds
  straight into the output directory with `gem build --output`, and compares
  that same normalized version against rubygems.org when checking whether a
  version is already published.

## 0.1.1 - 2026-08-18

OpenReceive is pre-release and has no compatibility or migration commitments.

Version semantics: JS packages and Ruby gems share the workspace version
(0.1.1). The OpenAPI (`spec/openapi`, 0.4.x) and AsyncAPI (0.2.x) documents
version the wire contracts independently, and `docs/manifest.json` versions the
docs index; none of these three track the package release number.

### Opportunistic reconcile (no default long-running process)

- Settlement of abandoned checkouts now piggybacks on OpenReceive API calls:
  every mounted route (JS handler dispatch; Rails engine `around_action`) first
  runs one reconcile pass gated by the restored durable `openreceive_meta`
  key/value/rev table (CAS claim, `transaction_scan_gate`, minimum 2 seconds
  between real wallet scans, stretched 2/6/12s by pending-invoice age). Every
  worker sharing the host database races on the one gate row, so rapid calls
  collapse to one `list_transactions` scan per interval — the gate is the NWC
  scan budget. The awaited pass is time/page bounded (9s timeout, capped
  pages); a failed or timed-out scan warns, never fails the user's request,
  and leaves `claimed_at` so a broken wallet cannot stampede.
- `openreceive_meta` ships in `openReceivePaymentsSchemaSql`, every scaffold
  ORM template, and the Rails install migration — same host database as
  `openreceive_payments`. One migration creates both tables everywhere, and it
  is now named for what it does: `openreceive:install` writes
  `db/migrate/*_create_openreceive_tables.rb` (`CreateOpenreceiveTables`, with
  `--skip-migration` replacing `--skip-payment-migration`), and the JS scaffold
  emits a per-ORM migration: knex `db/migrations/*_create_openreceive_tables.mjs`,
  sequelize and typeorm `*-create-openreceive-tables.{cjs,ts}`, drizzle
  `src/db/openreceive-tables.ts`, prisma `prisma/schema.openreceive.prisma`.
  Custom repositories must implement
  `claimReconcileGate({ now, intervalSeconds })` or pass
  `opportunisticReconcile: false` (Rails: `config.opportunistic_reconcile`);
  construction throws otherwise, like `rateLimiting`.
- `reconcileOpenReceivePayments` / `OpenReceive.reconcile!` now return the
  pass's per-hash check results. `POST /payments/check` consumes the
  request-level pass instead of running its own per-invoice wallet walk: the
  gate winner serves status/`paid_at`/`details` straight from the pass; on
  `gate_busy` (or a hash outside the pending set) the host row serves
  status/`paid_at` with `details` omitted, and row `attention` reads as
  `pending` on the wire. Exactly one gate claim per request.
- No web process starts a settlement timer anymore: `createOpenReceiveStack`
  lost the `reconciler` option, the demos lost their reconciler
  loops/Procfile entries, and the quickstarts no longer tell hosts to schedule
  `OpenReceive::ReconcileJob`. The one optional worker does both listen and
  reconcile: JS `startOpenReceiveNotificationWorker({ service, host })`
  (wired from a host script; there is deliberately no host-aware CLI), Rails
  `bin/rails openreceive:notifications` (now with a built-in periodic pass).
  `startOpenReceiveReconciler`, `ReconcileJob`, and `openreceive:reconcile`
  remain exported one-shot/loop primitives.

### Headless browser surface (`@openreceive/browser/headless`)

- New public, semver-guaranteed subpath for integrations that bring their own
  UI: the checkout lifecycle (state machine, status model, poll fetcher),
  payment-method/wizard models, swap display models, formatters, labels, and
  the styling tokens that are the contract with the shipped stylesheet —
  curated symbol-by-symbol (never `export *`), seeded from what the flagship
  custom-UI rails example actually needs. `CheckoutState` (type) is promoted
  to the main entry; element plumbing (`createOpenReceiveThemeToggleElement`,
  checkout/theme-toggle tag, attribute, and event constants) moved to
  `@openreceive/elements`.
- No file under `examples/` imports any `@openreceive/*/internal` subpath
  anymore; `npm run check:example-imports` (wired into `test:ci:release`)
  fails CI if one comes back. `/internal` remains wrapper-only plumbing with
  no stability guarantee, and the new
  [headless checkout guide](docs/guides/headless-checkout.md) documents the
  two supported integration styles.

### Ruby engine parity

- The Ruby core gem gains the built-in price feed (`OpenReceive::Rates`): a
  static provider and the cached live feed with primary/fallback failover,
  60-second caching, fail-closed windows, and the shared 46-currency list,
  drift-checked against `spec/data/rates/price-sources.json`. The Rails engine
  and Ruby Service default to it when the host injects no provider, matching
  `createOpenReceive`.
- The Ruby server gem gains the production FixedFloat swap provider (signed
  API client, quote/create/status/refund, rates-index math, limits caching,
  weight budgets, primary/backup failover) plus swap-address validation in the
  core gem. Providers auto-build from `LSC_URI_PRIMARY`/`LSC_URI_BACKUP`
  exactly like the Node engine, and `payment_methods` are amount-aware in both
  engines.
- Security: Ruby `payments/check` now whitelists the same public transaction
  fields as the Node engine; the preimage and full invoice never reach the
  payer. A new http-golden vector pins the settled check body in both engines.
- Wire parity: known-path/wrong-method returns 405, unrecognized persistence
  failures return 503 `INTERNAL` retryable, a host-resolved order without an
  amount returns 500, payer input is validated before host hooks run, and the
  rate limiter buckets IPv6 clients by /64 (with IPv4-mapped unwrap) in both
  engines. The OpenAPI document now declares 405/500 on every route.

### Packaging and release

- npm: every public package now carries `publishConfig.access: "public"`, a
  `prepack` build, and full registry metadata (description, keywords, author,
  bugs, engines, sideEffects). The umbrella package no longer exports
  `openreceive/testkit` (the testkit is internal), and the package graph
  validator now rejects public packages with private peer dependencies.
- RubyGems: the gems build again (the core gemspec no longer loads the full
  library), release in lockstep with the workspace version (synced by
  `release:prepare`, enforced by `check:release`), and ship LICENSE and
  per-gem CHANGELOGs. Each gem dir gains a Gemfile and Rakefile; new
  `release:gem:plan/build/publish` scripts and a CI `gem build` on Ruby
  3.2/3.4 cover the RubyGems track, and `release:stamp` dates changelog
  headings at release time.

### Rate limiting

- Opt-in per-IP invoice rate limiting (`rateLimiting` in JS,
  `config.rate_limiting` in Rails): caps invoice creation per client IP per
  rolling hour, counted from the `openreceive_payments` rows the host already
  stores. Counting is repository-backed only (no in-memory fallback) and the
  limit applies only when a new attempt would be minted — re-fetching an
  already-committed attempt is never throttled.
- Schema change: `openreceive_payments` gains a nullable `client_ip` column
  with a `(client_ip, updated_at)` index (Rails: `(client_ip, created_at)` —
  its `created_at` is locally clocked). Over-limit requests return
  `429 RATE_LIMITED` with `retryable: true` and a `Retry-After` header, in
  both engines.

### Library-owned payment attempts

- OpenReceive now owns the `openreceive_payments` logic inside the host's
  existing database. The host passes a database handle (pg Pool/Client,
  `node:sqlite`, better-sqlite3, or a custom `{dialect, query, transaction}`
  adapter); the library owns the schema, per-order commit locking, write-once
  settlement, and the reconciliation state machine. It still never owns orders,
  users, prices, or fulfillment, and never requires a separate database or
  Redis.
- Simplified host contract: `authorize` plus
  `createOpenReceiveHost({ db, loadOrder, amountForOrder, onPaid })`. `onPaid`
  runs inside the settlement transaction, only for the order's first settled
  attempt, with a transactional `query` for the order update or an outbox row.
- Rails mirrors this: an engine-owned `OpenReceivePayment` model,
  `openreceive:install` emitting migration + simplified initializer
  (`authorize`, `load_order`, `amount_for_order`, `on_paid`) + route mount, and
  a shipped `OpenReceive::ReconcileJob` / `openreceive:reconcile` rake task.
- A custom `OpenReceivePaymentRepository` remains as a documented advanced
  escape hatch, not the quickstart.
- `npx openreceive scaffold payments` now emits only a migration/schema file
  for the chosen ORM plus a wiring guide — no more generated repositories,
  mark-paid logic, or host stubs. `openReceivePaymentsSchemaSql(dialect)`
  returns the canonical DDL.

### Attempt state machine and settlement

- Every attempt carries `status`
  (`pending | settled | expired | failed | attention`) plus `status_reason`.
- Only `pending` attempts are reconciled, keeping the batched
  `list_transactions` scan window bounded to roughly the active invoice window;
  expired rows are no longer reconciled forever, and per-invoice lookups are
  still never used.
- Closing an unpaid attempt requires a successful wallet scan at or after
  expiry plus the 900-second grace
  (`OPENRECEIVE_ATTEMPT_EXPIRY_GRACE_SECONDS`); a local clock alone never
  closes a row. Vectors: `spec/test-vectors/attempt-reconciliation.json`.
- `attention` now requires the wallet's explicit in-flight claim (transaction
  `state`/`transaction_state` of `pending` or `accepted`) after expiry plus
  grace; a post-grace transaction with no finality signal closes as `expired`
  (`no_finality_after_expiry`) instead of flagging every abandoned checkout on
  wallets that never set NIP-47 state fields.
- Settled rows are never overwritten; a duplicate sibling settlement is
  recorded with `status_reason = 'duplicate_settlement'` and never fulfills
  twice. An order has one live payment session with at most one live attempt
  per rail/asset; the host only ever sees unpaid or paid.
- Preimages alone are not settlement authority; every settlement path applies
  the same finality rule (`settled_at` or a settled transaction state).
- Checkout creation now fails closed when the wallet does not honor the
  requested invoice expiry (beyond a small tolerance), so an attempt's
  reconciliation window always matches its real payable window.
- Opt-in NWC-02 notification listeners: Node
  `startOpenReceiveNotificationListener({ service, host })` (over the new
  `service.subscribeWalletNotifications`) and the Rails
  `openreceive:notifications` rake task. NWC notifications are authenticated
  wallet data: a settled `payment_received` payload settles the matching
  pending attempt directly over that channel — under the same finality rule as
  scans (`settled_at` or a settled transaction state; never a preimage alone)
  — with no redundant wallet scan for that invoice. A payload without a
  finality signal or with an unknown payment hash only wakes a bounded
  reconciliation scan, and the poll loop remains the safety net for
  notifications missed while offline. Direct settlement assumes the NWC client
  binds notification decryption to the connection's wallet pubkey (the bundled
  SDK does).
- Removed: `listUnsettledAttempts`, `OpenReceiveHostRepository`, and the
  generated payments-repository/mark-paid/host-stub files.

### Wallet preflight

- NWC preflight now fails closed when the wallet advertises spend methods such
  as `pay_invoice`. Booting anyway requires the explicit
  `allowSpendCapableWallet: true` / `config.allow_spend_capable_wallet` /
  `OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC=true` override.

### HTTP and security

- Mounted routes implement `spec/openapi/openreceive-http.v1.yaml`.
- The host authorizes each request and resolves prices from host-owned order
  data; payer-supplied amounts are rejected.
- OpenReceive mints no authentication, recovery, or refund tokens.
- Receive-only NWC and swap-provider credentials remain server-only and are
  excluded from public APIs and logs.

### Developer experience

- The Node quickstart has one service, one host integration, and one framework
  adapter — and no reconciliation startup call: settlement rides the mounted
  routes through the durable gate.
- Removed superseded API aliases, historical response-shape normalization, and
  repository scratch documents.

### Release posture

- Hosted demo deployment templates and public demo deployment docs remain
  outside this public repository.
- The deterministic internal testkit remains private and non-payable.
- Release gates retain package, cross-language, secret, and bundle checks plus
  workflow safety validation.
