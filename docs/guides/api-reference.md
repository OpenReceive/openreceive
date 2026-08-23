# API reference

Per-function reference for the wallet client, the order bridge, the
framework adapters, persistence, the CLI, and the Rails engine. `amount` is
exactly `{ sats }` or `{ currency, value }`; public results use `amount_msats`
and exact integer/decimal math — never binary floats. The mounted HTTP routes
are defined normatively in
[`spec/openapi/openreceive-http.v1.yaml`](../../spec/openapi/openreceive-http.v1.yaml).

Node and TypeScript APIs return **camelCase** fields (`orderId`, `paymentHash`,
`amountMsats`). Mounted HTTP JSON uses the same values in **snake_case**
(`order_id`, `payment_hash`, `amount_msats`). Timestamps are integer Unix
seconds. Money fields are integers or decimal strings — never binary floats.

## Wallet client

The object `createOpenReceive()` returns. It is conventionally held in a
variable named `service` — the parameter name every adapter expects — which
is why its methods are written `service.…` below.

### createOpenReceive

```ts
const service = await createOpenReceive(options?: CreateOpenReceiveOptions): Promise<OpenReceive>
```

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `nwc` | `string` | no | Explicit receive-only NWC URI; normal applications read `NWC_URI` instead. |
| `env` | `Record<string, string \| undefined>` | no | Environment source for `NWC_URI`, `LSC_URI_PRIMARY`, `LSC_URI_BACKUP`. Default `process.env`. |
| `allowSpendCapableWallet` | `boolean` | no | Explicit override to boot on a wallet advertising spend methods. Default `false`; also settable via `OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC=true`. |
| `priceFetch` | `SimplePriceFetch` | no | Fiat price fetch override for `{ currency, value }` amounts. Defaults to global `fetch` against the live feeds; when no sufficiently recent rate is available, fiat-priced creation refuses with a retryable 503 (no mock fallback). |
| `clock` | `() => number` | no | Unix-seconds clock override (tests). |
| `swap` | `{ provider?, failoverProviders? }` | no | Explicit primary swap provider plus ordered failovers, consulted only when the primary throws — never to fill assets it omits. Omitted, read from `LSC_URI_PRIMARY` / `LSC_URI_BACKUP`. |
| `client`, `priceProviders`, `priceCurrencies`, `logging`, `logger`, `onEvent` | — | no | Advanced overrides; see the type. |

Returns the `OpenReceive` wallet client. Wallet preflight runs before the promise
resolves and **fails closed**: a missing/invalid NWC URI, a wallet without
`make_invoice` + `list_transactions`, unsupported encryption, or an advertised
spend method (without the override) throws `OpenReceiveConfigError`
(`MISSING_NWC`, `INVALID_NWC`, `WALLET_PREFLIGHT_FAILED`). The connection
string never appears in logs or errors.

| Field | Type | Meaning |
| --- | --- | --- |
| `priceCurrencies` | `string[]` | Fiat currencies this wallet client will quote. Default `["USD"]`. |
| `prepareCheckout` | `function` | Resolve `{ amount }` to millisatoshis without minting an invoice. |
| `createCheckout` | `function` | Mint a Lightning invoice for an order you own. |
| `checkPayment` | `function` | Look up one known invoice in the wallet history. |
| `reconcilePayments` | `function` | Batch-check many pending invoices in one wallet scan. |
| `subscribeWalletNotifications` | `function?` | Opt-in NWC-02 `payment_received` subscription. Absent when the client cannot notify. |
| `quoteSwap` | `function` | Quote one pay-in asset for an amount without creating a provider order. See [Automated swaps](automated-swaps.md). |
| `listSwapOptions` | `function` | List configured swap pay-in methods for an invoice amount. See [Automated swaps](automated-swaps.md). |
| `createSwap` / `getSwap` / `refundSwap` | `function` | Create, refresh, or refund a swap attempt. See [Automated swaps](automated-swaps.md). |
| `listRates` | `function` | Read BTC/fiat rates. See [Price feeds](price-feeds.md). |
| `close` | `function` | Close the wallet client. |

### service.prepareCheckout

```ts
service.prepareCheckout(input: { amount: CreateCheckoutAmount }): Promise<PrepareCheckoutResult>
```

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `amount` | `{ sats } \| { currency, value }` | yes | Your own price. Never payer input. |

Resolves the charged Lightning amount without minting an invoice or committing
an attempt. Used by the HTTP prepare route so the UI can show the sats total
and swap options before create.

| Field | Type | Meaning |
| --- | --- | --- |
| `amountMsats` | `number` | Integer millisatoshis that will be charged (`sats × 1000`, or the fiat quote rounded up to a whole sat then × 1000). Minimum `1000` (1 sat). |
| `fiatQuote` | `OpenReceiveRateQuote \| null` | The locked BTC/fiat quote when `amount` was `{ currency, value }`. `null` when `amount` was already `{ sats }` or Bitcoin-denominated. See [fiatQuote](#fiatquote). |

### service.createCheckout

```ts
service.createCheckout(input: CreateCheckoutRequest): Promise<Checkout>
```

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `orderId` | `string` | yes | Your own order id. |
| `amount` | `{ sats } \| { currency, value }` | yes | Your own price. Never payer input. |
| `memo` | `string` | no | Invoice description (exclusive with `descriptionHash`). |
| `descriptionHash` | `string` | no | 64-hex description hash. |
| `metadata` | `Record<string, unknown>` | no | NIP-47 metadata, ≤ 3900 serialized bytes. |
| `expirySeconds` | `number` | no | Requested invoice expiry. Default 600. |

Returns a `Checkout` — the payer-safe minted-invoice value. On the wire the
same object is the generated snake_case `OpenReceiveWireCheckout`; the
browser's polled `CheckoutSnapshot` is the client-held snapshot of that wire
shape. The wallet must honor
the requested expiry: when the minted invoice's real payable window deviates
from `expirySeconds` by more than 60 seconds, creation fails with a `502`
service error instead of tracking a row whose reconciliation window is wrong.
This is a pure wallet call — attempt persistence happens in the order
bridge ([createOpenReceiveHost](#createopenreceivehost)).

| Field | Type | Meaning |
| --- | --- | --- |
| `orderId` | `string` | Your order this invoice was minted for. OpenReceive does not own the order. |
| `paymentHash` | `string` | 64-character lowercase hex payment hash. Globally unique per attempt; the selector for later check, swap, and refund calls. |
| `bolt11` | `string` | The Lightning invoice string the payer scans or pastes into a wallet. |
| `amountMsats` | `number` | Integer millisatoshis encoded on the invoice. Same value the wallet must receive to settle. |
| `createdAt` | `number` | Integer Unix seconds when the wallet minted the invoice (`make_invoice`'s `created_at`, else the wallet client's clock). Pass this exact value back to `checkPayment`. |
| `expiresAt` | `number` | Integer Unix seconds after which the invoice is no longer payable. Taken from the wallet; must match the requested expiry within 60 seconds. |
| `fiatQuote` | `OpenReceiveRateQuote \| null` | The BTC/fiat quote locked at mint time when you priced in fiat. `null` for `{ sats }` amounts. See [fiatQuote](#fiatquote). |

### fiatQuote

Present on `prepareCheckout` and `createCheckout` when your amount was
`{ currency, value }` in a quoted fiat currency. `null` for `{ sats }` and for
Bitcoin-denominated `{ currency: "BTC" \| "SAT" \| "SATS", value }`. The quote
is locked onto the invoice; later price-feed moves do not change
`amountMsats`. Like every TS surface the quote is camelCase; the HTTP handler
serializes it snake_case as `fiat_quote` in checkout bodies.

| Field | Type | Meaning |
| --- | --- | --- |
| `fiat` | `{ currency, value }` | The fiat amount that was quoted. |
| `fiat.currency` | `string` | Uppercase currency code from your amount, e.g. `"USD"`. Must be in `priceCurrencies`. |
| `fiat.value` | `string` | Decimal string of that fiat amount, e.g. `"12.50"`. Never a binary float. |
| `btcFiatPrice` | `string` | Decimal string: units of fiat per 1 BTC at quote time, e.g. `"65000.12"`. |
| `amountSats` | `number` | Integer satoshis after rounding the fiat amount up to a whole sat. Minimum `1`. |
| `amountMsats` | `number` | Integer millisatoshis (`amountSats × 1000`). Same value as `Checkout.amountMsats`. |
| `source` | `"static_mock" \| "primary" \| "fallback"` | Which price feed produced the rate. `static_mock` appears only with an explicit `priceProviders: [new StaticPriceProvider()]` opt-in (tests/offline dev). |
| `asOf` | `number` | Integer Unix seconds when the rate was observed. |
| `expiresAt` | `number` | Integer Unix seconds when this quote is no longer considered fresh (quote TTL, default 600). |

### service.checkPayment

```ts
service.checkPayment(input: CheckPaymentRequest): Promise<PaymentCheck>
```

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `paymentHash` | `string` | yes | 64-hex payment hash. |
| `createdAt` | `number` | yes | Exact NIP-47 invoice creation time from `make_invoice`. |
| `until` | `number` | no | Scan upper bound. Default now. |
| `overlapSeconds` | `number` | no | Scan-window overlap. Default 60. |

Returns a `PaymentCheck` — one wallet-history result for the requested hash.
A pure batched wallet read — no persistence. `settled` requires `settled_at`
or a wallet transaction state of `settled`; a preimage alone is never
finality.

| Field | Type | Meaning |
| --- | --- | --- |
| `paymentHash` | `string` | 64-character lowercase hex hash that was checked. |
| `status` | `"pending" \| "settled" \| "expired" \| "failed" \| "not_found"` | Wallet outcome for this invoice. See [PaymentCheck status](#paymentcheck-status). |
| `paidAt` | `number?` | Integer Unix seconds of settlement. Present only when `status` is `settled`. Taken from the wallet's `settled_at`, or the observation time if the wallet omitted it. |
| `details` | `PaymentDetails?` | Corroborating wallet row from the scan. See [PaymentDetails](#paymentdetails). |

#### PaymentCheck status

| Value | Meaning |
| --- | --- |
| `pending` | The wallet still lists the invoice as unpaid and not terminal. |
| `settled` | The wallet reports finality (`settled_at` or `transaction_state`/`state` of `"settled"`). This is the only status that fulfills an order. |
| `expired` | The wallet reports the invoice expired without settlement. |
| `failed` | The wallet reports the invoice failed without settlement. |
| `not_found` | No matching incoming transaction in the scanned window. Not the same as expired — reconciliation keeps the row pending until a later scan at or after expiry plus grace. |

#### PaymentDetails

| Field | Type | Meaning |
| --- | --- | --- |
| `transaction` | `NwcTransaction` | Clone of the wallet's `list_transactions` row. Contains no connection strings or provider secrets. |
| `observed_at` | `number` | Integer Unix seconds when this scan observed the row. |
| `paid_at_source` | `"settled_at" \| "observed_at"` | Present only when settled. `"settled_at"` means `paidAt` came from the wallet; `"observed_at"` means the wallet omitted `settled_at` and the wallet client's clock was used. |

`transaction` fields that matter for settlement (all optional on the wire):

| Field | Type | Meaning |
| --- | --- | --- |
| `type` | `"incoming" \| "outgoing"?` | Direction. OpenReceive only settles `incoming`. |
| `invoice` | `string?` | The bolt11 the wallet recorded. |
| `payment_hash` | `string?` | Hash of this wallet row. |
| `amount_msats` | `bigint?` | Amount the wallet recorded, in millisatoshis. |
| `transaction_state` / `state` | `string?` | Wallet transaction state. `"settled"` is a finality signal. |
| `created_at` | `number?` | Integer Unix seconds the wallet minted the invoice. |
| `expires_at` | `number?` | Integer Unix seconds the wallet considers the invoice expired. |
| `settled_at` | `number?` | Integer Unix seconds of wallet settlement. A positive value is a finality signal. |
| `preimage` | `string?` | Payment preimage. Corroborating evidence only — never enough to settle. |
| `fees_paid_msats` | `bigint?` | Routing fees the wallet reported, in millisatoshis. |
| `description` | `string?` | Invoice memo the wallet stored. |
| `description_hash` | `string?` | 64-hex description hash, when the invoice used one. |

### service.reconcilePayments

```ts
service.reconcilePayments(input: ReconcilePaymentsRequest): Promise<readonly PaymentCheck[]>
```

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `attempts` | `{ paymentHash, createdAt }[]` | yes | Every pending attempt to check. |
| `until` | `number` | no | Scan upper bound. Default now. |
| `overlapSeconds` | `number` | no | Scan-window overlap. Default 60. |

Returns `PaymentCheck[]` — one [PaymentCheck](#servicecheckpayment) per
attempt, in the same order as `attempts` after hash normalization, using at
most two paged `list_transactions` walks for the whole batch — never a
per-invoice lookup. Pure wallet read; persistence and settlement delivery
belong to [reconcileOpenReceivePayments](#reconcileopenreceivepayments).

### service.subscribeWalletNotifications

```ts
service.subscribeWalletNotifications?(handler): Promise<() => Promise<void> | void>
```

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `handler` | `(notification) => void` | yes | Called for each `payment_received` notification. |

The `notification` argument:

| Field | Type | Meaning |
| --- | --- | --- |
| `type` | `string` | Notification type. The bundled subscription only delivers `payment_received`. |
| `payment_hash` | `string?` | 64-hex hash when the payload includes one. Unknown or missing hashes only wake a scan. |
| `transaction` | `NwcTransaction?` | Payload normalized like a `list_transactions` row. A row that satisfies the settlement rule may settle its matching pending attempt directly. |

Returns `() => Promise<void> | void` — call it to unsubscribe. The promise
rejects with `OpenReceiveError` code `UNSUPPORTED_METHOD` when the wallet
client cannot notify. Notifications are authenticated wallet data; only the
type and payment hash are ever logged. Direct-settlement semantics live in
[startOpenReceiveNotificationListener](#startopenreceivenotificationlistener).

### service.listSwapOptions

```ts
service.listSwapOptions(input: { amountMsats: number }): Promise<ListSwapOptionsResult>
```

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `amountMsats` | `number` | yes | Your own invoice amount in millisatoshis. |

Returns whether swaps are configured and the pay-in methods for that amount.
Behavior is in [Automated swaps](automated-swaps.md).

| Field | Type | Meaning |
| --- | --- | --- |
| `enabled` | `boolean` | `true` when at least one LSC provider is configured. |
| `options` | `SwapPaymentMethod[]` | One entry per supported pay-in asset. Empty when swaps are off. |

Each `options[]` entry:

| Field | Type | Meaning |
| --- | --- | --- |
| `payInAsset` | `string` | Pay-in asset id, e.g. `"USDT_TRON"`. |
| `label` | `string` | Asset ticker shown to the payer, e.g. `"USDT"`. |
| `networkLabel` | `string` | Network name shown to the payer, e.g. `"Tron"`. |
| `provider` | `string` | Provider that would quote this pair. |
| `available` | `boolean` | `true` when this amount is inside the provider's limits right now. |
| `unavailableReason` | `string?` | Machine reason when `available` is `false`, e.g. `"amount_too_small"`. |
| `unavailableMessage` | `string?` | Payer-facing explanation when unavailable. |
| `payAmount` | `string?` | Decimal string of crypto the payer would send, when a quote is available. |
| `minimumPayAmount` | `string?` | Decimal string minimum deposit the provider accepts. |
| `maximumPayAmount` | `string?` | Decimal string maximum deposit the provider accepts. |
| `minimumInvoiceAmountMsats` | `number?` | Smallest Lightning invoice this pair will quote, in millisatoshis. |
| `maximumInvoiceAmountMsats` | `number?` | Largest Lightning invoice this pair will quote, in millisatoshis. |

### service.quoteSwap

```ts
service.quoteSwap(input: { amount: CreateCheckoutAmount, payInAsset: string }): Promise<SwapQuoteResult>
```

Quotes one pay-in asset for an amount you own without minting an invoice or
creating a provider order — the call behind `POST …/swaps/quote`. The result is
camelCase (the HTTP handler converts to the snake_case wire shape):

| Field | Type | Meaning |
| --- | --- | --- |
| `provider` | `string` | Provider that quoted this pair. |
| `payAsset` | `SwapPayInAsset` | The pay-in asset id that was quoted. |
| `available` | `boolean` | `true` when the amount is inside the provider's limits right now. |
| `payAmount` | `string?` | Decimal string of crypto the payer would send, when available. |
| `minimumPayAmount` / `maximumPayAmount` | `string?` | Provider deposit limits. |
| `minimumInvoiceAmountMsats` / `maximumInvoiceAmountMsats` | `number?` | Invoice-side (Lightning receive) limits in msats, when reported. |
| `unavailableReason` / `unavailableMessage` | `string?` | Machine reason and payer-facing explanation when `available` is `false`. |

### service.createSwap

```ts
service.createSwap(input: CreateSwapRequest): Promise<SwapCheckout>
```

Same parameters as [createCheckout](#servicecreatecheckout), plus `payInAsset`
(`string`, required) — the pay-in asset id. Returns a `SwapCheckout`:

| Field | Type | Meaning |
| --- | --- | --- |
| *(PublicSwap fields)* | — | Deposit instructions and provider snapshot. See [PublicSwap](#publicswap). |
| `checkout` | `Checkout` | The shadow Lightning invoice this swap pays. Same shape as [createCheckout](#servicecreatecheckout). |
| `swapData` | `SwapData` | Server-only provider recovery state. Persist it on the attempt row; **never** serialize it into a browser response or log. |

`swapData` is `{ version: 1, providerOrder: SwapOrder }`. `version` is the
integer schema version (`1`). `providerOrder` holds provider credentials and
must stay server-only.

### service.getSwap / service.refundSwap

```ts
service.getSwap(input: { orderId, paymentHash, swapData }): Promise<PublicSwap>
service.refundSwap(input: { orderId, paymentHash, swapData, refundAddress }): Promise<PublicSwap>
```

Both refresh provider state using the `swapData` you loaded. `refundSwap`
also requires `refundAddress` (`string`) — the on-chain address to return
funds to — and refuses any provider state other than `refund_required`.

#### PublicSwap

Payer-safe swap snapshot. No provider tokens or credentials.

| Field | Type | Meaning |
| --- | --- | --- |
| `paymentHash` | `string` | 64-character lowercase hex hash of the shadow Lightning invoice. |
| `orderId` | `string` | Your order this swap attempt belongs to. |
| `provider` | `string` | Provider that issued the deposit address. |
| `payInAsset` | `string` | Pay-in asset id, e.g. `"USDC_SOL"`. |
| `depositAddress` | `string` | On-chain address the payer sends to. |
| `depositMemo` | `string?` | Destination tag / memo the payer must include, when the network requires one. |
| `depositAmount` | `string` | Decimal string of crypto the payer must send. Never a binary float. |
| `providerState` | `string` | Provider lifecycle: `creating_provider_order`, `awaiting_deposit`, `confirming`, `exchanging`, `paying_invoice`, `completed`, `expired`, `refund_required`, `refund_pending`, `refunded`, `attention`, or `failed`. Provider `completed` is not wallet settlement. |
| `providerExpiresAt` | `number` | Integer Unix seconds when the provider order expires. |
| `depositTxId` | `string?` | Provider-reported deposit transaction id, when known. |
| `payoutTxId` | `string?` | Provider-reported payout (Lightning pay) transaction id, when known. |
| `refundTxId` | `string?` | Provider-reported refund transaction id, when a refund was sent. |
| `refundReason` | `string?` | Why a refund is needed: `"underpaid"`, `"late_deposit"`, or `"underpaid_and_late"`. |
| `refundAmount` | `string?` | Decimal string the provider will return, excluding its network fee. |
| `attention` | `boolean?` | `true` when this attempt needs operator review. |
| `attentionReason` | `string?` | Why the attempt needs an operator, when `attention` is set. |
| `depositReceivedAmount` | `string?` | Amount actually received on the deposit transaction, when the provider reports it. The payer UI compares it with `depositAmount` to explain an underpayment. |
| `emergencyRepeat` | `boolean?` | A second deposit hit the same provider order; extra funds may sit at the provider while the attempt looks like an ordinary refund path. |
| `providerOrderId` | `string?` | Provider-side order reference, shown to the payer for support. |
| `fee` | `SwapFee?` | Fiat equivalents explaining why the payer sends more than the cart total. Never a price authority — the invoice amount is. See [SwapFee](#swapfee). |

#### SwapFee

Fiat equivalents attached to a swap for display. The field names are the
provider wire shape:

| Field | Type | Meaning |
| --- | --- | --- |
| `currency` | `string` | Fiat currency the equivalents are expressed in, e.g. `"USD"`. |
| `pay_in_fiat` | `string` | Fiat value of the crypto the payer must send. |
| `payout_fiat` | `string` | Fiat value delivered to the merchant — the cart total. |

### service.listRates

```ts
service.listRates(input?: { currencies?: string[] }): Promise<{ bitcoin: Record<string, string> }>
```

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `currencies` | `string[]` | no | Fiat codes to fetch. Default `priceCurrencies`. |

| Field | Type | Meaning |
| --- | --- | --- |
| `bitcoin` | `Record<string, string>` | Map of uppercase currency code → decimal string price of 1 BTC in that currency, e.g. `{ USD: "65000.12" }`. |

The wallet client also carries `quoteRates(input)` — the internal helper behind the
`fiatQuote` that `prepareCheckout` / `createCheckout` attach. It is JS-only
plumbing with no HTTP route and no Ruby counterpart; use `prepareCheckout` to
quote an amount.

### service.close

```ts
service.close(): Promise<void>
```

Returns `Promise<void>`. Closes the underlying wallet client, releasing its
relay connection. Stop the notifications worker first (if you run one).

The wallet client is created lazily on the first wallet call, so `close()` is a
no-op for a wallet client that never minted or scanned.

Call it in **scripts, one-shot jobs, and tests**: an open relay connection keeps
the Node event loop alive, so a process that skips `close()` finishes its work
and then hangs instead of exiting.

A long-running server does not need it. No payment state lives in memory —
settlement truth is the wallet plus the payments table, and there is no queue to
drain — so a process being terminated loses nothing by skipping it. The Express
middleware and the Next handler still expose `close()` if you want deterministic
teardown on `SIGTERM`; the Fastify plugin registers an `onClose` hook and closes
with the app.

## Order bridge (@openreceive/http)

The object `createOpenReceiveHost()` returns: the binding between OpenReceive
and your orders and database. Conventionally held in a variable named `host`.

### createOpenReceiveHost

```ts
const host = createOpenReceiveHost(options: CreateOpenReceiveHostOptions<Order>): OpenReceiveHost
```

Default (`db`) mode — OpenReceive owns the `openreceive_payments` rows inside
your application's existing database:

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `db` | `OpenReceiveSqlDatabase` | yes | pg Pool/Client, `node:sqlite` DatabaseSync, better-sqlite3, or a custom [OpenReceiveSqlAdapter](#openreceivesqladapter). |
| `loadOrder` | `(orderId, context) => Order \| null` | yes | Load your order; `null` → 404. |
| `amountForOrder` | `(order, context) => amount` | yes | The trusted price from your data. |
| `onPaid` | `OpenReceiveOrderSettlementHook` | yes | Fulfillment; see below. |
| `tableName` | `string` | no | Default `openreceive_payments`. |
| `clock` | `() => number` | no | Unix-seconds clock override. |

In db mode `onPaid` receives an `OpenReceiveOrderSettlement`:

| Field | Type | Meaning |
| --- | --- | --- |
| `orderId` | `string` | Your order that just settled. |
| `paymentHash` | `string` | 64-character lowercase hex hash of the settled attempt. |
| `paidAt` | `number` | Integer Unix seconds of settlement (`settled_at`, else the observation time). |
| `details` | `PaymentDetails?` | Wallet row that proved settlement. See [PaymentDetails](#paymentdetails). |
| `query` | `(sql, params?) => Promise<rows>` | Runs SQL inside the settlement transaction (`?` placeholders). Use it for writes that must commit atomically with settlement (e.g. an outbox row). |

It runs inside the settlement transaction, only for the order's first settled
attempt (write-once; a duplicate sibling settlement records
`duplicate_settlement` and never fulfills again). Delivery is at-least-once —
if `onPaid` throws, the transaction rolls back and the next reconciliation
pass retries.

Write through the supplied `query`. It is the only handle inside the settlement
transaction: an ORM call made here uses that ORM's own connection, so it commits
separately and can survive a rolled-back settlement (or be lost when settlement
commits and it does not).

Keep `onPaid` to database writes. Anything that reaches outside the
transaction — an email, a webhook, a shipping call — survives a rollback and
runs again on the retry. Flag the order here (or insert the outbox row below)
and let your own worker drain it after commit; there is no after-commit hook,
by design.

```ts
onPaid: async ({ orderId, query }) => {
  await query("UPDATE orders SET state = 'paid' WHERE id = ?", [orderId]);
  // Same transaction: enqueue follow-up work here rather than doing it inline.
  await query("INSERT INTO outbox (kind, order_id) VALUES (?, ?)", ["order_paid", orderId]);
},
```

If your ORM can run statements on a connection you pass it, wrap `query`; a
recipe per ORM is in [Node ORM recipes](node-orms.md).

Advanced escape hatch — replace `db` with a full repository implementation:

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `payments` | `OpenReceivePaymentRepository` | yes | Your repository's commit locking, settlement write-once, and reconciliation transitions. |
| `onPaid` | `OpenReceiveSettlementEventHook` | yes | The settlement hook is `onPaid` in this mode too, but its context differs: it receives the raw `OpenReceiveSettlementEvent` (`paymentHash`, `paidAt`, `details?`) — no `orderId` and no transactional `query`, because the custom repository owns that mapping. Delivered only when `payments.recordSettlement` won the write-once claim, so the library owns replay safety here too. |

Returns an `OpenReceiveHost` for the framework adapters and reconcile passes. The
attempt row commits before payer instructions are exposed. A commit the
repository refuses (an already-paid order, a competing live attempt) returns
`409`; a commit that fails on infrastructure returns a retryable `503`. Either
way the invoice is withheld.

| Field | Type | Meaning |
| --- | --- | --- |
| `resolveCheckout` | `function` | Looks up your order and trusted price (and any live attempt) for create/check/swap routes. |
| `onCheckoutCreated` | `function` | Commits the `openreceive_payments` row before the invoice or swap instructions are returned. Receives [CheckoutCreatedInput](#checkoutcreatedinput). |
| `onPaid` | `function` | Settlement delivery. In `db` mode this is the write-once wrapper around your `onPaid` hook. |
| `payments` | `OpenReceivePaymentRepository` | The attempt ledger: list, commit, settle, and record reconciliation transitions. |

#### CheckoutCreatedInput

Passed to `onCheckoutCreated` after the wallet mints and before the HTTP
response is written. A refusal (throwing a `409`-shaped error) becomes
`409`; any other throw becomes a retryable `503`. Payer instructions are
withheld in both cases.

| Field | Type | Meaning |
| --- | --- | --- |
| `orderId` | `string` | Your order this attempt belongs to. |
| `paymentHash` | `string` | 64-character lowercase hex hash of the new attempt. |
| `checkout` | `Checkout` | Payer-safe invoice snapshot to persist and later reuse. Same shape as [createCheckout](#servicecreatecheckout). |
| `swapData` | `SwapData?` | Server-only provider recovery state. Persist it on the row; never send it to a browser. |
| `clientIp` | `string?` | Client IP the adapter attributed to this request, when one was available. Backs opt-in per-IP rate limiting. |

### The authorize context

Every order-scoped route calls `authorize(context)` before any wallet or
database work; returning `false` produces `403 FORBIDDEN`. The same shape is
used by the optional `rateLimitHook` (`false` → `429`).

Two deliberate exceptions: `GET …/rates` has no order to authorize and is never
authorized, and the durably-gated opportunistic reconcile pass runs before
authorization — it reads only OpenReceive's own attempt rows and the wallet, and
the gate is what bounds it.

| Field | Type | Meaning |
| --- | --- | --- |
| `action` | `OpenReceiveAuthorizeAction` | One of `checkout.prepare`, `checkout.create`, `payment.check`, `swap.quote`, `swap.create`, `swap.read`, `swap.refund`. |
| `request` | `Request` | The Web-standard request (headers, URL). |
| `resource` | `{ orderId?, paymentHash? }` | **Untrusted payer-supplied selectors.** Use them only to look up your own data; the library separately verifies a requested payment hash belongs to the order. |
| `native` | `unknown?` | The untouched framework request (Express `req`, Fastify request, `NextRequest`) for middleware-attached state. |

Express session example:

```ts
authorize: ({ resource, native }) => {
  const userId = (native as { session?: { userId?: string } }).session?.userId;
  return userId !== undefined && orders.belongsTo(resource.orderId, userId);
},
```

### startOpenReceiveReconciler

```ts
const reconciler = await startOpenReceiveReconciler(input): Promise<OpenReceiveReconciler>
```

A polling primitive: used internally by
[startOpenReceiveNotificationWorker](#startopenreceivenotificationworker) and
available directly, but not started by any adapter or stack. Most applications rely on
the default request-path opportunistic reconcile
([maybeReconcileOpenReceivePayments](#maybereconcileopenreceivepayments)) and
never call this.

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `service` | `OpenReceive` | yes | The wallet client. |
| `host` | `OpenReceiveHost` | yes | From [createOpenReceiveHost](#createopenreceivehost). |
| `pollIntervalMs` | `number` | no | Default 5000; `RangeError` below 250. |
| `overlapSeconds` | `number` | no | Scan overlap. Default 60. |
| `signal` | `AbortSignal` | no | External stop signal. |
| `clock` | `() => number` | no | Unix-seconds clock override. |
| `onError` | `(error) => void` | no | Observes per-pass failures. Default: deduplicated `console.warn`. |

Returns an `OpenReceiveReconciler`. Every pass goes through the durable
reconcile gate
([maybeReconcileOpenReceivePayments](#maybereconcileopenreceivepayments)), so
N reconciler instances — and the request-path opportunistic reconcile —
collapse to one real wallet scan per gate interval; construction throws unless
the repository implements `claimReconcileGate`. A
failed pass is reported and retried from the ledger, so delivery is
at-least-once. Only `pending` attempts are scanned — settled and closed rows
leave the scan set, keeping the window bounded with no durable cursor.

| Field | Type | Meaning |
| --- | --- | --- |
| `stop` | `() => void` | Stops scheduling further passes. In-flight work is not cancelled. |
| `done` | `Promise<void>` | Resolves after `stop()` once the current pass (if any) finishes. |

### reconcileOpenReceivePayments

```ts
await reconcileOpenReceivePayments(input: { service, host, overlapSeconds?, maxPages?, clock? }): Promise<readonly PaymentCheck[]>
```

One bounded pass: list the pending attempts (the oldest
`OPENRECEIVE_RECONCILE_BATCH_SIZE` — 200; like every `OPENRECEIVE_*` name in
this section it is a constant exported by `@openreceive/http`, not an
environment variable — per pass, so a backlog drains over
successive passes), scan the wallet once for the
batch (`maxPages` caps the paged walks), deliver settlements through
`host.onPaid` (at least once; write-once in the repository), persist terminal
transitions, and return the per-hash [PaymentCheck](#servicecheckpayment)
results of the pass. Closing an unpaid attempt
requires a successful wallet scan at or after expiry plus the 900-second grace
(`OPENRECEIVE_ATTEMPT_EXPIRY_GRACE_SECONDS`) — a local clock alone never
closes a row. A settled result without `paidAt` is retried next pass. Throws
on wallet/repository failure, leaving every row pending for the next pass.

### maybeReconcileOpenReceivePayments

```ts
const result = await maybeReconcileOpenReceivePayments(input): Promise<OpenReceiveOpportunisticReconcileResult>
```

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `service` | `OpenReceive` | yes | The wallet client. |
| `host` | `OpenReceiveHost` | yes | From [createOpenReceiveHost](#createopenreceivehost). |
| `minIntervalSeconds` | `number` | no | Gate interval floor. Default (and minimum) `OPENRECEIVE_MIN_RECONCILE_INTERVAL_SECONDS` (2); stretched by pending-invoice age — 2 s while any pending invoice is under 2 minutes old, 6 s under 5 minutes, else 12 s. |
| `scanTimeoutMs` | `number` | no | Bound on the awaited pass. Default `OPENRECEIVE_RECONCILE_SCAN_TIMEOUT_MS` (9000). |
| `maxPages` | `number` | no | Page cap per wallet walk. Default `OPENRECEIVE_RECONCILE_SCAN_MAX_PAGES` (50). |
| `overlapSeconds` | `number` | no | Scan overlap. Default 60. |
| `clock` | `() => number` | no | Unix-seconds clock override. |
| `onError` | `(error) => void` | no | Observes failed scans. Default: `console.warn`. |

The gated pass behind the handler's default request-path opportunistic
reconcile, exported so you can drive settlement from your own routes or
middleware (routes of your own never auto-run it). Skips with no wallet call when
nothing is pending; claims the durable `openreceive_meta` gate (optimistic CAS,
shared by every instance on your database — `gate_busy` means another
worker just scanned); otherwise awaits one bounded
[reconcileOpenReceivePayments](#reconcileopenreceivepayments) pass. Never
throws: a failed or timed-out scan reports to `onError` and returns
`scan_failed`, and the gate's claim stays in place so a broken wallet cannot
stampede. Returns `{ reason: "ran", checks }` (the per-hash
[PaymentCheck](#servicecheckpayment) results) or
`{ reason: "no_pending" | "gate_busy" | "scan_failed" }`.

### startOpenReceiveNotificationListener

```ts
const listener = await startOpenReceiveNotificationListener(input): Promise<OpenReceiveNotificationListener>
```

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `service` | `OpenReceive` | yes | Must implement `subscribeWalletNotifications`, else rejects `UNSUPPORTED_METHOD`. |
| `host` | `OpenReceiveHost` | yes | Settlement and pending-attempt source. |
| `overlapSeconds` | `number` | no | Overlap for fallback scans. |
| `onError` | `(error) => void` | no | Failure sink. Default: swallowed. |

Returns an `OpenReceiveNotificationListener`:

| Field | Type | Meaning |
| --- | --- | --- |
| `stop` | `() => Promise<void> \| void` | Unsubscribes from wallet notifications and waits for any in-flight reconcile pass. |

Most applications use
[startOpenReceiveNotificationWorker](#startopenreceivenotificationworker)
instead, which wraps this listener plus the periodic pass.

Opt-in NWC-02 listener with direct settlement:
notifications are authenticated wallet data, so a `payment_received` payload
that satisfies the settlement rule (`settled_at` or a settled transaction
state — never a preimage alone) and matches a pending attempt settles that
attempt directly through `host.onPaid`, with no wallet scan for that invoice;
settling removes it from the pending set, so no later pass scans it
again. Anything less — no payload, no finality signal, an unknown or
not-pending hash — wakes one durably gated pass
([maybeReconcileOpenReceivePayments](#maybereconcileopenreceivepayments);
bursts coalesce to at most one queued follow-up, and a pass another worker
just ran is not repeated). A direct-settlement failure reports
to `onError` **and** falls back to a scan. A periodic pass — the worker's, or
the request-path opportunistic reconcile — remains the safety net for
notifications missed while offline. Direct settlement assumes
the NWC client binds notification decryption to the connection's wallet
pubkey (the bundled SDK does); a custom client that skips author verification
must not be granted it.

### startOpenReceiveNotificationWorker

```ts
const worker = await startOpenReceiveNotificationWorker(input): Promise<OpenReceiveNotificationWorker>
```

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `service` | `OpenReceive` | yes | The wallet client. |
| `host` | `OpenReceiveHost` | yes | From [createOpenReceiveHost](#createopenreceivehost). |
| `pollIntervalMs` | `number` | no | Periodic safety-net pass interval. Default 15000. |
| `overlapSeconds` | `number` | no | Scan overlap. Default 60. |
| `onError` | `(error) => void` | no | Failure sink. Default: swallowed. |

The optional worker: one separate long-lived process that both runs the
[notification listener](#startopenreceivenotificationlistener) (direct
settlement on finality, else one pass) and the periodic reconcile pass — the
safety net for notifications missed while the worker was down. Every scan it
takes goes through the same durable reconcile gate as the request-path pass,
so the worker plus N web instances still collapse to one wallet scan per
interval. A wallet
without notification support degrades to the periodic pass alone (reported via
`onError`). There is deliberately no `npx openreceive notifications` CLI (the
CLI cannot see your `onPaid`/db); wire it from a small script of your own.

| Field | Type | Meaning |
| --- | --- | --- |
| `stop` | `() => Promise<void>` | Unsubscribes, stops the periodic pass, and waits for in-flight work. Call it before `service.close()`. |
| `done` | `Promise<void>` | Resolves after `stop()` once the periodic loop has drained. |

### Settlement entry points

Settlement is delivered through the request-path opportunistic reconcile pass (the default —
any mounted payment route runs it, gated by the durable `openreceive_meta` row; unauthenticated
`GET …/rates` never triggers it, so crawlers and health checks cannot consume the
wallet-scan budget) and the optional
[notifications worker](#startopenreceivenotificationworker). `POST /payments/check` never
runs its own per-invoice wallet walk: it consumes the request's pass result. The pass winner
serves `status`/`paid_at`/`details` straight from the pass (settlement was already delivered
inside it); on `gate_busy`, or with opportunistic reconcile disabled, it serves the stored row
with `details` omitted (row `attention` maps to wire `pending`). Both entry points are
replay-safe through the same write-once path. `onPaid` still runs in request context for a
winning pass, so fulfillment work must be safe to run inside a web request (keep it
transactional or enqueue an outbox job).

## Framework adapters

All three adapters ship the route set in the OpenAPI spec and accept two
option forms. Each adapter re-exports only the curated `@openreceive/http`
surface — the handler/stack factories, their options/context/hook types, the
error classes, the notification worker, and the generated `OpenReceiveWire*`
body types. Order-bridge internals (`createOpenReceiveSqlPayments`, the
reconcile gate, `createOpenReceiveHost`, rate-limit internals) live only on
`@openreceive/http`; import them from there when composing your own integration
(`npm run check:public-api` pins these surfaces).

**All-in-one form** (the happy path): order hooks plus `wallet` and `storage`. The
adapter builds the wallet client and order bridge itself; boot is lazy (the first request
awaits wallet preflight). The Express middleware and the Next handler expose
`ready` (a promise) and `close()` (closes the owned wallet client); the Fastify plugin
exposes neither, because it registers an `onClose` hook that shuts the stack
down with the app:

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `wallet` | `{ nwc }` \| `{ service }` | yes | The wallet: a receive-only NWC connection string (the adapter builds and owns the client) or a prebuilt `OpenReceive` / `Promise<OpenReceive>` (you own its lifecycle). |
| `storage` | `{ db, onPaid, tableName? }` \| `{ payments, onPaid }` | yes | Where attempts live, which decides what `onPaid` receives: the host database handle [createOpenReceiveHost](#createopenreceivehost) takes, with the per-order `OpenReceiveOrderSettlement`; or a custom [OpenReceivePaymentRepository](#openreceivepaymentrepository), with the raw `OpenReceiveSettlementEvent`. |
| `loadOrder` / `amountForOrder` | | yes | Same hooks as [createOpenReceiveHost](#createopenreceivehost). |
| `authorize` | `OpenReceiveAuthorize` | yes | Your policy; see [the authorize context](#the-authorize-context). |
| `opportunisticReconcile` | `false \| { minIntervalSeconds }` | no | Request-path settlement pass on every mounted payment route (`GET …/rates` never triggers it); on by default through the durable `openreceive_meta` gate. `false` disables; `{ minIntervalSeconds }` tunes. |
| `clock` | `() => number` | no | Unix-seconds clock override. |
| `rateLimiting` / `rateLimitHook` / `prefix` | | no | As below. |
| `trustProxyIpHeader` | `boolean \| string` | no | Adapter extra on all three adapters: client-IP attribution for `rateLimiting` behind a reverse proxy. `true` reads the first hop of `x-forwarded-for`; a string names another trusted header (e.g. `"cf-connecting-ip"`). Only safe when your own proxy sets the header. |

**Composed form** (`CreateOpenReceiveHttpHandlerOptions`) for shared wallet clients,
custom repositories, and tests:

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `service` | `OpenReceive` | yes | From [createOpenReceive](#createopenreceive). |
| `authorize` | `OpenReceiveAuthorize` | yes | Your policy; see [the authorize context](#the-authorize-context). |
| `host` | `OpenReceiveHost` | yes | From [createOpenReceiveHost](#createopenreceivehost). |
| `opportunisticReconcile` | `false \| { minIntervalSeconds }` | no | As above. With a custom repository, on-by-default requires `payments.claimReconcileGate` — construction throws otherwise (same fail-at-construction idiom as `rateLimiting`). |
| `rateLimitHook` | `OpenReceiveRateLimit` | no | Same context shape as `authorize`; `false` → `429`. |
| `rateLimiting` | `boolean \| OpenReceiveIpRateLimitConfig` | no | Opt-in per-IP invoice cap (default off; `true` = 60/hour). Mutually exclusive with `rateLimitHook`. See [Rate limiting](rate-limiting.md). |
| `prefix` | `string` | no | Mount prefix. Default `/openreceive`. |

The same all-in-one form is available framework-free as
`createOpenReceiveStack(options)` in `@openreceive/http`, returning
`{ handler, ready, close }`.

Create routes reject payer-supplied amounts and price from
`loadOrder`/`amountForOrder`. Payment and swap reads take `order_id` plus
`payment_hash`; after your authorization the library verifies that exact
attempt belongs to the order and supplies server-only `swap_data`.

HTTP JSON is snake_case. The values are the same as the Node objects above.
The table below is generated from the normative
[OpenAPI contract](../../spec/openapi/openreceive-http.v1.yaml); `…` is the
mount prefix (default `/openreceive`).

<!-- generated:routes -->
<!-- Generated by tools/docs/generate-spec-tables.mjs from spec/. Edit the spec, then rerun the generator; never edit this block by hand. -->

| Route | Status | Response body |
| --- | --- | --- |
| `POST …/checkouts/prepare` | 200 | `PrepareCheckoutResponse` `{ order_id, amount_msats, fiat_quote?, payment_methods }` |
| `POST …/checkouts` | 201 | `CreateCheckoutResponse` `{ checkout: Checkout }` |
| `POST …/payments/check` | 200 | `PaymentCheck` `{ payment_hash, status: PaymentStatus, paid_at?, details?: PaymentDetails, payment_methods }` |
| `POST …/swaps/quote` | 200 | `SwapQuote` `{ provider, pay_asset: SwapPayInAsset, available, pay_amount?, minimum_pay_amount?, maximum_pay_amount?, minimum_invoice_amount_msats?, maximum_invoice_amount_msats?, unavailable_reason?, unavailable_message? }` |
| `POST …/swaps` | 201 | `CreateSwapResponse` `{ swap: SwapCheckout }` |
| `POST …/swaps/status` | 200 | `Swap` `{ payment_hash, order_id, provider, pay_in_asset: SwapPayInAsset, deposit_address, deposit_memo?, deposit_amount, provider_state: SwapProviderState, provider_expires_at, deposit_tx_id?, payout_tx_id?, refund_tx_id?, refund_reason?, refund_amount?, attention?, attention_reason?, deposit_received_amount?, emergency_repeat?, provider_order_id?, fee?: SwapFee }` |
| `POST …/swaps/refunds` | 200 | `Swap` `{ payment_hash, order_id, provider, pay_in_asset: SwapPayInAsset, deposit_address, deposit_memo?, deposit_amount, provider_state: SwapProviderState, provider_expires_at, deposit_tx_id?, payout_tx_id?, refund_tx_id?, refund_reason?, refund_amount?, attention?, attention_reason?, deposit_received_amount?, emergency_repeat?, provider_order_id?, fee?: SwapFee }` |
| `GET …/rates` | 200 | `RatesResponse` `{ bitcoin }` |
<!-- /generated:routes -->

How the bodies map to the Node objects above: `POST …/checkouts` returns
[Checkout](#servicecreatecheckout) in snake_case (the generated
`OpenReceiveWireCheckout`); `POST …/checkouts/prepare`
returns the prepare result plus [swap options](#servicelistswapoptions);
`POST …/payments/check` returns [PaymentCheck](#servicecheckpayment) plus
`payment_methods` (the same swap-option list; empty when Lightning is the only
rail — served from a handler-local 60-second warm cache so ~3s status polls do
not walk the provider catalog on every request); `POST …/swaps/quote` returns
the snake_case quote (`provider`,
`pay_asset`, `available`, `pay_amount?`, limits); `POST …/swaps` returns
[PublicSwap](#publicswap) plus nested `checkout`, with `swap_data` stripped;
`…/swaps/status` and `…/swaps/refunds` return the bare snake_case
[PublicSwap](#publicswap) object — no `{ swap }` wrapper (only `POST …/swaps`
wraps); `GET …/rates` returns `{ bitcoin: { <currency>: "<price>" } }`.

### Errors

The error body and the per-route error statuses are generated from the spec.
`429` responses also carry a `Retry-After` header.

<!-- generated:error-codes -->
<!-- Generated by tools/docs/generate-spec-tables.mjs from spec/. Edit the spec, then rerun the generator; never edit this block by hand. -->

Every error status above returns the OpenReceive error body `{ code, message, retryable?, request_id?, details? }`
(normative: [`spec/schemas/error.schema.json`](../../spec/schemas/error.schema.json)).
`code` is one of:

`NOT_IMPLEMENTED`, `RESTRICTED`, `UNAUTHORIZED`, `FORBIDDEN`, `RATE_LIMITED`, `QUOTA_EXCEEDED`, `INTERNAL`, `UNSUPPORTED_ENCRYPTION`, `OTHER`, `NOT_FOUND`, `TIMEOUT`, `INVALID_REQUEST`, `WALLET_UNAVAILABLE`, `INVOICE_EXPIRED`, `UNSUPPORTED_METHOD`, `CONFLICT`
<!-- /generated:error-codes -->

<!-- generated:route-errors -->
<!-- Generated by tools/docs/generate-spec-tables.mjs from spec/. Edit the spec, then rerun the generator; never edit this block by hand. -->

| Route | Declared error statuses |
| --- | --- |
| `POST …/checkouts/prepare` | `400`, `403`, `404`, `405`, `413`, `429`, `500`, `503` |
| `POST …/checkouts` | `400`, `403`, `404`, `405`, `409`, `413`, `429`, `500`, `502`, `503` |
| `POST …/payments/check` | `400`, `403`, `404`, `405`, `409`, `413`, `429`, `500`, `502`, `503` |
| `POST …/swaps/quote` | `400`, `403`, `404`, `405`, `413`, `429`, `500`, `503` |
| `POST …/swaps` | `400`, `403`, `404`, `405`, `409`, `413`, `429`, `500`, `502`, `503` |
| `POST …/swaps/status` | `400`, `403`, `404`, `405`, `413`, `429`, `500`, `502`, `503` |
| `POST …/swaps/refunds` | `400`, `403`, `404`, `405`, `409`, `413`, `429`, `500`, `502`, `503` |
| `GET …/rates` | `400`, `405`, `500`, `501`, `503` |
<!-- /generated:route-errors -->

### openReceiveExpress

```ts
app.use(openReceiveExpress(options)): OpenReceiveExpressMiddleware
```

Express middleware; handles requests under its prefix and calls `next()` for
everything else. The untouched Express `req` is passed as `native`.

### openReceiveFastify

```ts
await fastify.register(openReceiveFastify, options)
```

Fastify plugin; registers a catch-all under `prefix`. The untouched Fastify
request is passed as `native`.

### openReceiveNextHandlers

```ts
export const { GET, POST } = openReceiveNextHandlers(options)
```

Next.js App Router handlers; mount as a catch-all route
(`app/openreceive/[...openreceive]/route.ts`). The incoming `NextRequest` is
passed as `native`.

| Field | Type | Meaning |
| --- | --- | --- |
| `GET` | `(request) => Promise<Response>` | App Router GET export. Every shipped route is POST except `GET …/rates`; exporting both lets the catch-all module serve all of them. |
| `POST` | `(request) => Promise<Response>` | App Router POST export. Dispatches the OpenReceive route set. |
| `handler` | `(request) => Promise<Response>` | The same dispatcher, for tests or a custom method map. |
| `ready` | `Promise<void>` | All-in-one form only: resolves when the wallet client is up. |
| `close` | `() => Promise<void>` | All-in-one form only: closes the owned wallet client. |

## Persistence

### createOpenReceiveSqlPayments

```ts
const payments = createOpenReceiveSqlPayments(db, options?): OpenReceiveSqlPaymentRepository
```

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `db` | `OpenReceiveSqlDatabase` | yes | pg Pool/Client, SQLite handle, or an [OpenReceiveSqlAdapter](#openreceivesqladapter). |
| `tableName` | `string` | no | Default `openreceive_payments`. |
| `metaTableName` | `string` | no | Durable reconcile-gate key/value table. Default `openreceive_meta`. |
| `clock` | `() => number` | no | Unix-seconds clock override. |

Returns an `OpenReceiveSqlPaymentRepository` — the library-owned repository
behind `createOpenReceiveHost({ db })`, exposed for advanced integrations. Owns
per-order commit locking (SQLite `BEGIN IMMEDIATE`, postgres advisory lock),
live-attempt supersede/conflict decisions, the
`pending → settled | expired | failed | attention` state machine, and
`markPaidOnce` — the replay-safe settlement transaction that fulfills only the
order's first settled attempt and never overwrites a settled row.

| Field | Type | Meaning |
| --- | --- | --- |
| `listForOrder` | `(orderId) => Promise<OpenReceivePaymentRecord[]>` | Every attempt row for that order, newest first. Includes settled and closed history. |
| `listReconcilableAttempts` | `() => Promise<OpenReceiveReconcilableAttempt[]>` | Every `pending` attempt. Terminal rows are omitted so the scan set stays bounded. |
| `commitAttempt` | `(input) => void \| Promise<void>` | Serialize-and-insert one new attempt. Throws on a settled order or a reusable live attempt on the same rail. |
| `recordReconciliation` | `(transition) => void \| Promise<void>` | Apply a terminal non-settled transition only while the row is still `pending`. Never overwrites a settled row. |
| `recordSettlement` | `(settlement) => boolean \| Promise<boolean>` | The write-once settlement claim: record the attempt settled and return whether THIS call won the claim. Repository-mode `onPaid` runs only when it returns `true`, so a redelivered event fulfills exactly once. Required. |
| `countAttemptsFromIp` | `(clientIp, sinceUnixSeconds) => number \| Promise<number>` | Attempt rows for this IP at or after that time. Backs opt-in `rateLimiting`. |
| `claimReconcileGate` | `({ now, intervalSeconds }) => boolean \| Promise<boolean>` | Atomically claim the durable `openreceive_meta` scan gate (optimistic CAS shared by every process on the database). `true` = run a wallet scan now; `false` = another worker scanned within the interval. |
| `markPaidOnce` | `(input, fulfill) => Promise<void>` | Write-once settlement: set `paid_at` / `settled` once and run `fulfill` only for the order's first settled attempt. |

`claimReconcileGate` is part of the custom-repository contract too: a custom
`OpenReceivePaymentRepository` must implement it (as a durable CAS — never an
in-process cooldown, since memory cannot coordinate workers) unless you
pass `opportunisticReconcile: false`; handler construction throws otherwise.

### openReceivePaymentsSchemaSql

```ts
openReceivePaymentsSchemaSql(dialect: "postgres" | "sqlite", tableName?, metaTableName?): string
```

Returns a `string` — the canonical `openreceive_payments` `CREATE TABLE` /
index DDL for that dialect, plus the sibling `openreceive_meta` gate table
(`key TEXT PRIMARY KEY, value TEXT NOT NULL, rev` — the durable reconcile
gate; `metaTableName` renames it) and its `schema_version` seed row. The
statements themselves live in `@openreceive/core`
(`openReceivePaymentsDdlStatements` in `payments-ddl.ts`) — the one source of
truth this helper and the scaffold CLI's ORM migrations both render from. Run
it through your own migration workflow; the scaffold CLI wraps it per ORM.
You may adjust `order_id` typing or add a foreign key but must keep every
column and constraint. `payment_hash` is globally unique; `order_id` is
indexed, not unique.

### OpenReceiveSqlAdapter

The escape-hatch database boundary when the built-in pg/SQLite bindings do not
fit:

```ts
interface OpenReceiveSqlAdapter {
  dialect: "postgres" | "sqlite";
  query(sql: string, params?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
  transaction<T>(run: (tx: { query }) => Promise<T>): Promise<T>;
}
```

`query` takes `?` placeholders and returns SELECT rows (`Record<string, unknown>[]`;
`[]` for non-SELECT). `transaction` must provide real atomicity — settlement
write-once and fulfillment both run inside it.

### OpenReceivePaymentRecord

One `openreceive_payments` row as returned by `payments.listForOrder`.

| Field | Type | Meaning |
| --- | --- | --- |
| `orderId` | `string` | Your order this attempt belongs to. |
| `paymentHash` | `string` | 64-character lowercase hex hash. Unique across all orders. |
| `status` | `"pending" \| "settled" \| "expired" \| "failed" \| "attention"` | Attempt lifecycle. Only `pending` is scanned. `attention` means the wallet still reports an in-flight state long after expiry. |
| `statusReason` | `string \| null` | Operator-facing detail for the current status, e.g. `"superseded"` or `"duplicate_settlement"`. Absent or `null` when there is nothing extra to say. |
| `paidAt` | `number \| null` | Integer Unix seconds of settlement, or `null` if this attempt never settled. |
| `expiresAt` | `number` | Integer Unix seconds after which these payer instructions must not be reused. |
| `createdAt` | `number` | Integer Unix seconds used to order historical attempts deterministically. |
| `checkout` | `Checkout` | Safe, replayable payer snapshot. Same shape as [createCheckout](#servicecreatecheckout). |
| `swapData` | `SwapData \| null` | Server-only provider recovery state. `null` or omitted for Lightning-only attempts. Never serialize into a browser response. |

## Browser & React

The browser/React surface you wire up (the vue/svelte/angular wrappers delegate to the
same custom element and accept the same attributes):

`prefix` — the base path the shipped router is mounted at — is the only URL input the
browser packages take. Every route they call is derived from it: `/checkouts`,
`/checkouts/prepare`, `/payments/check`, `/swaps`, `/swaps/quote`, `/swaps/status`,
`/swaps/refunds`. There is no per-route override, so a checkout cannot be created
against one mount and settled against another.

| Symbol | Package | What it does |
| --- | --- | --- |
| `prepareCheckout({ orderId, prefix, fetch?, headers? })` | `@openreceive/browser` | POST `/checkouts/prepare`: locks the amount + returns payment methods without minting. |
| `requestCheckout({ orderId, prefix, fetch?, headers?, memo?, metadata? })` | `@openreceive/browser` | POST `/checkouts`: mints (or reuses) a bolt11 and returns the snapshot. |
| `<Checkout>` | `@openreceive/react` | Self-contained checkout. Create mode: `orderId` + `prefix`. Snapshot mode: `checkout` (+ `prefix` for polling; `prefix` defaults to `/openreceive`, so a bare snapshot polls). `polling={false}` renders without status polling and leaves the swap flow working. Common props: the seven handlers (`onCopy`, `onOpenWallet`, `onState`, `onSettled`, `onProviderCopy`, `onStartOver`, `onError`), `polling`, `pollIntervalMs`, `paymentWizard`, `themeToggle` (default `true`), `defaultTheme`, `storageKey`, `decodeLinkUrl`, `components`, `classNames`, `syncUrl`, `resumePathPrefix`, `routeOrderId`, `metadata`, `createFetch`. Prop names and defaults are shared with the Vue, Svelte and Angular wrappers. |
| `useCheckout(options)` | `@openreceive/react` | The hook behind `<Checkout>` for custom layouts; it drives a concrete `checkout` snapshot (create mode belongs to `<Checkout>`). Unlike the component it does **not** default `prefix`: pass `prefix` to poll `/payments/check`, or omit it (or pass `polling: false`) to render the snapshot without polling. Returns the live snapshot, `status`, countdown labels, `statusTitle`/`statusDetail`, and `copyInvoice`/`openWallet`/`reloadState`/`retry`/`cancel`. |
| `PaymentWizard` | `@openreceive/react` | The method picker + swap deposit flow rendered inside `<Checkout>`; usable standalone with `checkout`, `prefix`, and `onSwapStarted`; omit `prefix` and it renders the method grid only, since it has no swap backend to call. |
| `<openreceive-checkout>` | `@openreceive/elements` | The custom element behind the non-React wrappers. Create mode: `order-id` + `prefix` attributes. Snapshot mode: `invoice`/`invoice-id`/`payment-hash`/... attributes. Polling knobs: `polling="false"` renders without status polling; `poll-interval-ms` tunes the interval. Events (all seven): `openreceive-copy`, `openreceive-open-wallet`, `openreceive-state`, `openreceive-settled`, `openreceive-provider-copy`, `openreceive-start-over`, `openreceive-error`. |

Failed status polls back off exponentially (honoring the server's `Retry-After`), and
transport failures are thrown as `OpenReceiveBrowserRequestError` carrying
`status`/`code`/`retryable`/`retryAfterSeconds`.

## CLI

### openreceive scaffold payments

```sh
npx openreceive scaffold payments [options]
```

Emits one schema/migration file for your ORM — `openreceive_payments` and the
`openreceive_meta` reconcile gate together — plus an `OPENRECEIVE_PAYMENTS.md`
wiring guide, nothing else. Never opens a database connection or runs
migrations.

Nothing here asks about your order table: `order_id` is always `TEXT` with no
foreign key, so its name and primary-key type are irrelevant. Every generated
file carries the exactly-once fulfillment note. The removed `--order-model`,
`--order-table`, `--order-id-type`, and `--skip-foreign-key` flags are rejected
by name, so a stale scripted invocation says why.

| Flag | Meaning |
| --- | --- |
| `--orm <name>` | `prisma \| drizzle \| typeorm \| sequelize \| knex`. |
| `--dialect <name>` | `postgres \| sqlite` (default `postgres`). |
| `--table-name <name>` | Payment attempts table (default `openreceive_payments`). |
| `--meta-table-name <name>` | Reconcile-gate table (default `openreceive_meta`). |
| `--out-dir <path>` | Output root (default `.`). |
| `--force` | Overwrite generated files. |
| `-i, --interactive` | Prompt for missing options (default on TTY when `--orm` omitted). |

### openreceive doctor

```sh
npx openreceive doctor
```

Checks the storage-free server configuration: prints the Node version and
working directory, and validates `NWC_URI` presence and parseability (printed
redacted) and `LSC_URI_*` connections. Exit code `1` when `NWC_URI` is missing
or invalid, or when a configured `LSC_URI_*` value fails to parse.
`openreceive debug-report` prints the same as a redacted support report
(always exit `0`).

## Rails

### openreceive:install

```sh
bin/rails generate openreceive:install
```

Emits one migration — `db/migrate/*_create_openreceive_tables.rb`, creating
both `openreceive_payments` and the `openreceive_meta` reconcile gate — a
simplified `config/initializers/openreceive.rb`, and the engine route mount at
`/openreceive`. The migration adapts to the app's configured database adapter:
PostgreSQL, SQLite, and MySQL (`mysql2`/`trilogy`) are supported. The
`OpenReceivePayment` model is engine-owned — no model file is generated. The
generated initializer ships `config.on_paid = OpenReceive::LOGGING_ON_PAID`, a
logging placeholder that fulfills nothing; the engine warns at every boot
while it is still configured.

The engine never reads, writes, locks, or references your order table:
`order_id` is stored as a string with no foreign key, and commit/settlement
serialize on an OpenReceive-owned per-order lock, so there is no primary-key
type to match and no foreign key to keep in step with your migrations.

| Flag | Meaning |
| --- | --- |
| `--order-model <Name>` | Model the generated initializer calls (default `Order`). Only names your code — the engine never touches the model or its table. |
| `--skip-migration` | Skip the migration (both tables). |
| `--skip-initializer` / `--skip-route` | Skip those files. |

### OpenReceive.configure

```ruby
OpenReceive.configure do |config| ... end
```

The quickstart order bridge:

| Setting | Type | Required | Meaning |
| --- | --- | --- | --- |
| `config.authorize` | `->(context)` | yes | Your policy for every request; the context carries the action and untrusted selectors. |
| `config.load_order` | `->(order_id)` | yes | Load your order; `nil` → 404. |
| `config.amount_for_order` | `->(order)` | yes | The trusted price, `{ "sats" => }` or `{ "currency" =>, "value" => }`. |
| `config.on_paid` | `->(settlement)` | yes | Fulfillment. Receives [OrderSettlement](#ordersettlement). |
| `config.opportunistic_reconcile` | `false` or `{ min_interval_seconds: }` | no | Request-path settlement pass on every engine route; on by default through the durable `openreceive_meta` gate shared by all Puma workers. `false` disables (required with a custom repository that runs its own settlement worker). |
| `config.rate_limiting` | `true` or `Hash` | no | Opt-in per-IP invoice cap, mirroring the JS `rateLimiting` option: off by default; `true` caps invoice creation at 60 per client IP per rolling hour, counted from the engine-owned `openreceive_payments` rows; or `{ limit_per_hour:, limit_per_day: }`. Mutually exclusive with `config.rate_limit`. See [Rate limiting](rate-limiting.md). |
| `config.rate_limit` | `->(context)` | no | Custom rate-limit hook; same context as `config.authorize`. Return `false` (or raise the engine's rate-limited error) for `429`. |
| `config.client_ip` | `->(request)` | no | Client-IP extractor for rate limiting and row stamping. Default: `ActionDispatch::Request#ip`, which honors the app's trusted-proxy configuration. |
| `config.allow_spend_capable_wallet` | `Boolean` | no | Explicit override for a spend-capable NWC code; boot otherwise fails closed. Also `OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC=true`. |

`on_paid` runs inside the settlement transaction through the engine's
write-once `mark_paid_once!`, only for the order's first settled attempt;
delivery is at-least-once, so a raise rolls back and the next pass retries.
Advanced hooks (`resolve_checkout`, `on_checkout_created`) exist for
custom-repository applications.

#### OrderSettlement

| Field | Type | Meaning |
| --- | --- | --- |
| `order_id` | `String` | Your order that just settled. |
| `payment_hash` | `String` | 64-character lowercase hex hash of the settled attempt. |
| `paid_at` | `Integer` | Unix seconds of settlement (`settled_at`, else the observation time). |
| `details` | `Hash?` | Wallet-observed settlement details (transaction snapshot, `observed_at`, `paid_at_source`) — the same shape JS delivers to `onPaid`. `nil` for settlements recorded without wallet details. |

### OpenReceive::ReconcileJob

```ruby
OpenReceive::ReconcileJob.perform_later
```

One reconciliation pass wrapped for your ActiveJob backend — a one-shot
primitive. Nothing to schedule: request-path opportunistic reconcile is the
default settlement driver.

### rake openreceive:reconcile

```sh
bin/rails openreceive:reconcile
```

Equivalent one-pass rake task — a one-shot primitive; prints the number of
attempts scanned.

### rake openreceive:notifications

```sh
bin/rails openreceive:notifications
```

The one documented worker: long-running opt-in NWC-02 listener with
retry/backoff around
[OpenReceive.listen_for_notifications!](#openreceivelisten_for_notifications),
which also reconciles periodically
(`OPENRECEIVE_NOTIFICATIONS_RECONCILE_INTERVAL_SECONDS`, default 15) — its own
safety net for notifications missed while it was down.

### OpenReceive.reconcile!

```ruby
OpenReceive.reconcile!(overlap_seconds: 60, now: nil, max_pages: nil, deadline: nil) # => Array<Hash>
```

Returns the per-hash check results of the pass — an array of
`{ "payment_hash", "status", "paid_at"?, "details"? }` hashes (`[]` when the
ledger has no `pending` attempts). One bounded pass over the engine-owned
ledger: scan the wallet for the oldest `OpenReceive::Server::RECONCILE_BATCH_SIZE`
(200) `pending` attempts, deliver settlements through the write-once
settlement hook, and persist terminal transitions. `max_pages:` caps the
wallet-history pages walked; `deadline:` is a wall-clock bound the scan checks
between page fetches (a pass that runs out of budget simply stops walking —
a hash the truncated scan never reached stays untouched). Closure requires a
successful scan at or after expiry plus the 900-second grace — never the
local clock alone. A wallet failure raises and leaves every row pending.

### OpenReceive.maybe_reconcile!

```ruby
OpenReceive.maybe_reconcile!(now: nil) # => Hash
```

The gated pass behind the engine's request-path opportunistic reconcile (an
`around_action` on the engine's controllers — exactly one gate claim per
request), exported for routes and middleware of your own: they never auto-run
it, and Rack applications call it themselves. Never raises — a failed
or timed-out scan warns and returns `scan_failed`, leaving the gate claimed so
a broken wallet cannot stampede. Returns
`{ "reason" => "ran", "checks" => [...] }` (the per-hash check hashes) or
`{ "reason" => "disabled" | "no_pending" | "gate_busy" | "scan_failed" }`.

### OpenReceive.listen_for_notifications!

```ruby
OpenReceive.listen_for_notifications!(overlap_seconds: 60)
```

Subscribes to the configured NWC client's `payment_received` notifications.
Same direct-settlement semantics as the Node listener: a payload satisfying
the shared settlement rule that matches a pending attempt settles directly
through the engine's `mark_paid_once!`/`on_paid` path with no wallet scan for
that invoice; anything less (no finality signal, unknown hash, or a
direct-settlement failure) falls back to one `OpenReceive.reconcile!` pass.
The worker's periodic pass is the safety net for notifications missed while
offline. Raises `OpenReceive::ConfigurationError` when the client cannot
notify. Blocking clients do not return until the subscription ends.

The built-in `nwc-ruby` client is wired up already:
`OpenReceive::NwcRubyReceiveClient` forwards `subscribe_notifications` to that
gem's `subscribe_to_notifications` and translates the notification object it
yields back into the NWC-02 wire payload, so the settlement rule reads
`state`/`settled_at` exactly as it does on a `list_transactions` row. A
custom `config.nwc_client` supplies its own `subscribe_notifications`
(or `subscribeNotifications`) to opt in.
