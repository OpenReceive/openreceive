# API reference

This page documents each function of the wallet client, the host, the
framework adapters, persistence, the CLI, the Rails engine, the Python
engine (FastAPI and the `openreceive` console script) and the PHP engine.

- `amount` is exactly `{ sats }` or `{ currency, value }`.
- Public results use `amount_msats` and exact integer or decimal math, never binary floats.
- The spec file
  [`spec/openapi/openreceive-http.v1.yaml`](../../spec/openapi/openreceive-http.v1.yaml)
  is the authority for the mounted HTTP routes.

Node and TypeScript APIs return **camelCase** fields (`reference`, `paymentHash`,
`amountMsats`). Mounted HTTP JSON uses the same values in **snake_case**
(`reference`, `payment_hash`, `amount_msats`). Timestamps are integer Unix
seconds. Money fields are integers or decimal strings, never binary floats.

Each function lists **Input** (what you pass) and **Returns** (what you get
back) as separate labeled tables. A nested object, such as a quote, a swap
snapshot or a callback argument, gets its own **Fields of** table. It is not a
second input list.

## Wallet client

The object `createOpenReceive()` returns. Examples below call it `service`.

### createOpenReceive

```ts
const service = await createOpenReceive(); // reads NWC_URI (and LSC_URI_*) from process.env
// every option below is optional: createOpenReceive({ nwc, allowSpendCapableWallet, swap, … })
```

Builds the wallet client.

**Where it fits:** Call this once, when your server starts, and keep the result
for the life of the process, the same way you keep a database pool. Every other
call in this section is a method on the object it returns. If you use a
framework adapter in its all-in-one form, you never call this yourself. Hand the
adapter `{ nwc }` and it builds the client for you.

A preflight check runs before the promise resolves. It **fails closed**, meaning
it refuses to start rather than run on a bad setup. It throws `ConfigError`
(`MISSING_NWC`, `INVALID_NWC`, `WALLET_PREFLIGHT_FAILED`) when:

- the NWC URI is missing or invalid,
- the wallet lacks `make_invoice` or `list_transactions`,
- the encryption is unsupported, or
- the wallet advertises a spend method and you did not set the override.

The connection string never appears in logs or errors.

**Parameters**

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `nwc` | `string` | no | A receive-only NWC URI passed directly. Most applications read `NWC_URI` instead. |
| `env` | `Record<string, string \| undefined>` | no | Where to read `NWC_URI`, `LSC_URI_PRIMARY` and `LSC_URI_BACKUP`. Default `process.env`. |
| `allowSpendCapableWallet` | `boolean` | no | Lets your application start on a wallet that advertises spend methods. Default `false`. You can also set `OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC=true`. |
| `priceFetch` | `SimplePriceFetch` | no | Replaces the fiat price fetch for `{ currency, value }` amounts. Default: global `fetch` against the live feeds. With no recent enough rate, fiat-priced creation refuses with a retryable 503. There is no mock fallback. |
| `clock` | `() => number` | no | Unix-seconds clock override, for tests. |
| `swap` | `{ provider?, failoverProviders? }` | no | A primary swap provider plus failovers in order. A failover is used only when the primary throws, never to fill in assets the primary omits. If omitted, read from `LSC_URI_PRIMARY` / `LSC_URI_BACKUP`. |
| `client`, `priceProviders`, `priceCurrencies`, `logging`, `logger`, `onEvent` | — | no | Advanced overrides. See the type. |

**Returns** `OpenReceive` — the wallet client. Methods:

| Name | Type | Meaning |
| --- | --- | --- |
| `priceCurrencies` | `string[]` | Fiat currencies this wallet client will quote. Default `["USD"]`. |
| `prepareCheckout` | `function` | Resolve `{ amount }` to millisatoshis without minting an invoice. |
| `createCheckout` | `function` | Mint a Lightning invoice for an order you own. |
| `reconcilePayments` | `function` | Batch-check pending invoices in one wallet scan. |
| `subscribeWalletNotifications` | `function?` | Opt-in subscription to NWC-02 `payment_received` notifications. Absent when the client cannot send notifications. |
| `quoteSwap` | `function` | Quote one pay-in asset for an amount without creating a provider order. See [Automated swaps](automated-swaps.md). |
| `listSwapOptions` | `function` | List configured swap pay-in methods for an invoice amount. See [Automated swaps](automated-swaps.md). |
| `createSwap` / `getSwap` / `refundSwap` | `function` | Create, refresh, or refund a swap attempt. See [Automated swaps](automated-swaps.md). |
| `listRates` | `function` | Read BTC/fiat rates. See [Price feeds](price-feeds.md). |
| `close` | `function` | Close the wallet client. |

### service.prepareCheckout

```ts
const prepared = await service.prepareCheckout({
  amount: { currency: "USD", value: "12.00" }, // or { sats: 21000 }
});
```

Works out the Lightning amount to charge. It does not mint an invoice or save
an attempt.

**Where it fits:** Use this when the payer lands on your checkout page and you
want to show the total in sats, or the coins they could pay with, before they
commit to anything. Nothing is minted and nothing is written, so it is safe to
call on every page load. Most applications never call it directly. The mounted
`POST …/checkouts/prepare` route wraps it, and the shipped checkout UI calls
that route.

The HTTP prepare route uses it so the UI can show the sats total and swap
options before create.

**Parameters**

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `amount` | `{ sats } \| { currency, value }` | yes | Your own price. Never payer input. |

**Returns** `PrepareCheckoutResult`

| Name | Type | Meaning |
| --- | --- | --- |
| `amountMsats` | `number` | Integer millisatoshis that will be charged. This is `sats × 1000`, or the fiat quote rounded up to a whole sat, then × 1000. Minimum `1000` (1 sat). |
| `fiatQuote` | `RateQuote \| null` | The locked BTC/fiat quote when `amount` was `{ currency, value }`. `null` when `amount` was already `{ sats }` or in a Bitcoin unit. See [RateQuote](#ratequote). |

### service.createCheckout

```ts
const checkout = await service.createCheckout({
  reference: order.id,
  amount: { currency: "USD", value: "12.00" },
  // optional: memo, descriptionHash, metadata, expirySeconds
});
```

Mints an invoice that is safe to show the payer.

**Where it fits:** This is the call for the moment your user clicks "Pay with
Lightning" on an order you have already priced. Call it from server-side code
only, with the price from your own database. Store the returned `paymentHash`
against the order. That hash is how you check, refund, or resume the attempt
later. If you mount an adapter, `POST …/checkouts` does this for you and also
saves the attempt. Call it yourself only when you are building your own route.

On the wire, the same object is the generated snake_case `WireCheckout`. The
browser polls a `CheckoutSnapshot`, which is its own copy of that wire shape.

The wallet must honor the requested expiry. If the minted invoice's real
payable window differs from `expirySeconds` by more than 60 seconds, creation
fails with a `502` service error. This avoids tracking a row whose
reconciliation window is wrong.

This call only talks to the wallet. Saving the attempt happens in the order
bridge ([createHost](#createhost)).

**Parameters**

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `reference` | `string` | yes | Your order id. Use one per thing you fulfill and never reuse it. OpenReceive never looks inside it. The host fulfills once per reference and refuses a new checkout under a settled reference with 409. See [onPaid](#onpaid). |
| `amount` | `{ sats } \| { currency, value }` | yes | Your own price. Never payer input. |
| `memo` | `string` | no | Invoice description. Cannot be used with `descriptionHash`. |
| `descriptionHash` | `string` | no | 64-hex description hash. |
| `metadata` | `Record<string, unknown>` | no | NIP-47 metadata, ≤ 3900 serialized bytes. |
| `expirySeconds` | `number` | no | Requested invoice expiry. Default 600. |

**Returns** `Checkout`

| Name | Type | Meaning |
| --- | --- | --- |
| `reference` | `string` | The reference this invoice was minted for. |
| `paymentHash` | `string` | 64-character lowercase hex payment hash. Globally unique per attempt. You pass it to later check, swap, and refund calls. |
| `bolt11` | `string` | The Lightning invoice string the payer scans or pastes into a wallet. |
| `amountMsats` | `number` | Integer millisatoshis encoded on the invoice. The wallet must receive this amount to settle. |
| `createdAt` | `number` | Integer Unix seconds when the wallet minted the invoice. Comes from `make_invoice`'s `created_at`, else the wallet client's clock. Pass this exact value back in `reconcilePayments` attempts. |
| `expiresAt` | `number` | Integer Unix seconds after which the invoice is no longer payable. Comes from the wallet and must match the requested expiry within 60 seconds. |
| `fiatQuote` | `RateQuote \| null` | The BTC/fiat quote locked at mint time when you priced in fiat. `null` for `{ sats }` amounts. See [RateQuote](#ratequote). |

### RateQuote

The object in `fiatQuote` on `prepareCheckout` and `createCheckout` when you
priced in a quoted fiat currency. It is `null` for `{ sats }` and for Bitcoin
units `{ currency: "BTC" | "SAT" | "SATS", value }`. The quote is locked onto
the invoice, so later price-feed moves do not change `amountMsats`. HTTP
sends the same object as `fiat_quote`.

| Name | Type | Meaning |
| --- | --- | --- |
| `fiat` | `{ currency, value }` | The fiat amount that was quoted. |
| `fiat.currency` | `string` | Uppercase currency code from your amount, e.g. `"USD"`. Must be in `priceCurrencies`. |
| `fiat.value` | `string` | Decimal string of that fiat amount, e.g. `"12.50"`. Never a binary float. |
| `btcFiatPrice` | `string` | Decimal string: units of fiat per 1 BTC at quote time, e.g. `"65000.12"`. |
| `amountSats` | `number` | Integer satoshis after rounding the fiat amount up to a whole sat. Minimum `1`. |
| `amountMsats` | `number` | Integer millisatoshis (`amountSats × 1000`). Same value as `Checkout.amountMsats`. |
| `source` | `"static_mock" \| "primary" \| "fallback"` | Which price feed produced the rate. `static_mock` appears only when you opt in with `priceProviders: [new StaticPriceProvider()]`, for tests or offline development. |
| `asOf` | `number` | Integer Unix seconds when the rate was observed. |
| `expiresAt` | `number` | Integer Unix seconds when this quote stops being fresh. The quote TTL defaults to 600. |

### service.reconcilePayments

```ts
const checks = await service.reconcilePayments({
  attempts: [{ paymentHash, createdAt }], // one invoice or every pending attempt
  // optional: until, overlapSeconds
});
```

Looks up known invoices in wallet history.

**Where it fits:** Use this when you run your own settlement loop, or write an
admin tool that asks "has this invoice been paid yet?" for one or many hashes at
once. Pass it every pending attempt you have on file and act on what comes back.
If you use the host, you don't need it.
[reconcileHostPayments](#reconcilehostpayments) calls it for you, writes the
outcome back, and fires `onPaid`.

It reads the wallet in one batch and saves nothing. To check a single invoice,
pass a one-element `attempts` array.

- `settled` requires `settled_at` or a wallet transaction state of `settled`.
  A preimage alone never proves the payment is final.
- If the scan stops early (is truncated), the hash is **left out** of the
  results instead of being reported as `not_found`. That way a caller cannot
  close a paid attempt based on an incomplete scan.

**Parameters**

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `attempts` | `{ paymentHash, createdAt }[]` | yes | Every pending attempt to check. |
| `until` | `number` | no | Scan upper bound. Default now. |
| `overlapSeconds` | `number` | no | Scan-window overlap. Default 60. |

**Returns** `PaymentCheck[]`: one [PaymentCheck](#paymentcheck) per decided
attempt, in the same order as `attempts` after hash normalization. The whole
batch uses at most two paged `list_transactions` walks. It never looks up
invoices one by one. Hashes the walk could not prove present or absent are left
out. Saving results and delivering settlement are the job of
[reconcileHostPayments](#reconcilehostpayments).

#### PaymentCheck

| Name | Type | Meaning |
| --- | --- | --- |
| `paymentHash` | `string` | 64-character lowercase hex hash that was checked. |
| `status` | `"pending" \| "settled" \| "expired" \| "failed" \| "not_found"` | Wallet outcome for this invoice. See [PaymentCheck status](#paymentcheck-status). |
| `paidAt` | `number?` | Integer Unix seconds of settlement. Present only when `status` is `settled`. Comes from the wallet's `settled_at`, or from the observation time if the wallet left it out. |
| `details` | `PaymentDetails?` | Corroborating wallet row from the scan. See [PaymentDetails](#paymentdetails). |

#### PaymentCheck status

| Value | Meaning |
| --- | --- |
| `pending` | The wallet still lists the invoice as unpaid and not terminal. |
| `settled` | The wallet reports the payment is final (`settled_at`, or `transaction_state`/`state` of `"settled"`). This is the only status that fulfills an order. |
| `expired` | The wallet reports the invoice expired without settlement. |
| `failed` | The wallet reports the invoice failed without settlement. |
| `not_found` | No matching incoming transaction in the scanned window. This is not the same as expired. Reconciliation keeps the row pending until a later scan at or after expiry plus grace. |

#### PaymentDetails

**Fields of** `PaymentDetails`

| Name | Type | Meaning |
| --- | --- | --- |
| `transaction` | `NwcTransaction` | The wallet's [NWC-05 `list_transactions`](https://github.com/nostr-wallet-connect/nwc/blob/main/05.md#list_transactions) row. Contains no connection strings or provider secrets. |
| `observed_at` | `number` | Integer Unix seconds when this scan observed the row. |
| `paid_at_source` | `"settled_at" \| "observed_at"` | Present only when settled. `"settled_at"` means `paidAt` came from the wallet. `"observed_at"` means the wallet left out `settled_at`, so the wallet client's clock was used. |

OpenReceive differs from the spec in a few names:

- It names the millisatoshi fields `amount_msats` and `fees_paid_msats`. The spec says `amount` and `fees_paid`.
- It accepts `transaction_state` as another name for `state`.

Settlement uses only `incoming` rows. A positive `settled_at`, or a `state`/`transaction_state` of `"settled"`, means the payment is final. A `preimage` only supports that evidence and never proves it alone.

### service.subscribeWalletNotifications

```ts
const unsubscribe = await service.subscribeWalletNotifications((notification) => {
  // called for each payment_received notification
});
```

**Where it fits:** This is the low-level way to be told when a payment arrives,
instead of polling for it. Use it in a long-running process, not in a web
request, and only if you are writing your own listener. Most applications use
[startNotificationWorker](#startnotificationworker) instead. It subscribes for
you, marks matching attempts settled, and falls back to a scan when a
notification is unclear.

**Parameters**

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `handler` | `(notification) => void` | yes | Called for each `payment_received` notification. |

The `notification` argument (not a return value):

**Fields of** the notification payload

| Name | Type | Meaning |
| --- | --- | --- |
| `type` | `string` | Notification type. The bundled subscription only delivers `payment_received`. |
| `payment_hash` | `string?` | 64-hex hash when the payload includes one. Unknown or missing hashes only wake a scan. |
| `transaction` | `NwcTransaction?` | Payload normalized like a [NWC-05 `list_transactions`](https://github.com/nostr-wallet-connect/nwc/blob/main/05.md#list_transactions) row. If the row meets the settlement rule, it may settle its matching pending attempt directly. |

**Returns** `() => Promise<void> | void`. Call it to unsubscribe. The promise
rejects with `OpenReceiveError` code `UNSUPPORTED_METHOD` when the wallet
client cannot send notifications. Notifications are authenticated wallet data.
Only the type and payment hash are ever logged. How a notification settles an
attempt directly is described in
[startNotificationListener](#startnotificationlistener).

### service.listSwapOptions

```ts
const { enabled, options } = await service.listSwapOptions({
  amountMsats: checkout.amountMsats,
});
```

Lists whether swaps are configured and the pay-in methods for that amount.

**Where it fits:** Call this when you are drawing the "how would you like to
pay?" screen and need to know whether to show stablecoin buttons at all, and
which of them are within the provider's limits for this amount. It only reads,
so call it whenever the amount is known. Over HTTP the same list arrives as
`payment_methods` on the prepare, create, and check responses, so a browser
client never needs a separate call.

[Automated swaps](automated-swaps.md) describes the behavior.

**Parameters**

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `amountMsats` | `number` | yes | Your own invoice amount in millisatoshis. |

**Returns** `ListSwapOptionsResult`

| Name | Type | Meaning |
| --- | --- | --- |
| `enabled` | `boolean` | `true` when at least one LSC provider is configured. |
| `options` | `SwapPaymentMethod[]` | One entry per supported pay-in asset. Empty when swaps are off. |

Each `options[]` entry:

**Fields of** `SwapPaymentMethod`

| Name | Type | Meaning |
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
const quote = await service.quoteSwap({
  amount: { currency: "USD", value: "12.00" }, // or { sats: 21000 }
  payInAsset: "USDT_TRON",
});
```

Quotes one pay-in asset for an amount you set. It does not mint an invoice or
create a provider order. `POST …/swaps/quote` calls it.

**Where it fits:** Use it when the payer has tapped one specific coin and you
want to show "send 12.40 USDT" before they commit. Nothing is created at the
provider, so it is fine to call as they browse between options. The shipped
payment wizard calls the quote route as the payer picks. You only call this
yourself when building your own picker.

The result is camelCase. The HTTP handler converts it to the snake_case wire
shape.

**Parameters**

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `amount` | `{ sats } \| { currency, value }` | yes | Your own price. Never payer input. |
| `payInAsset` | `string` | yes | Pay-in asset id, e.g. `"USDT_TRON"`. |

**Returns** `SwapQuoteResult`

| Name | Type | Meaning |
| --- | --- | --- |
| `provider` | `string` | Provider that quoted this pair. |
| `payAsset` | `SwapPayInAsset` | The pay-in asset id that was quoted. |
| `available` | `boolean` | `true` when the amount is inside the provider's limits right now. |
| `payAmount` | `string?` | Decimal string of crypto the payer would send, when available. |
| `minimumPayAmount` / `maximumPayAmount` | `string?` | Provider deposit limits. |
| `minimumInvoiceAmountMsats` / `maximumInvoiceAmountMsats` | `number?` | Limits on the Lightning invoice side, in msats, when reported. |
| `unavailableReason` / `unavailableMessage` | `string?` | Machine reason and payer-facing explanation when `available` is `false`. |

### service.createSwap

```ts
const swap = await service.createSwap({
  reference: order.id,
  amount: { currency: "USD", value: "12.00" },
  payInAsset: "USDT_TRON",
  // optional: the createCheckout extras (memo, metadata, expirySeconds, …)
});
```

Creates a swap attempt: a shadow Lightning invoice plus on-chain deposit
instructions. The shadow invoice is the Lightning invoice the swap provider
pays on the payer's behalf.

**Where it fits:** This is the swap version of `createCheckout`. Call it at the
moment the payer confirms "pay with USDT on Tron" on a priced order. Call it
server-side and store the whole result on the attempt row. Send only the
`PublicSwap` fields and the `checkout` to the browser. The adapters' `POST
…/swaps` route does exactly that when you mount one.

`swapData` must stay server-only.

**Parameters**

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| *(createCheckout fields)* | — | — | Same as [createCheckout](#servicecreatecheckout). |
| `payInAsset` | `string` | yes | Pay-in asset id. |

**Returns** `SwapCheckout`

| Name | Type | Meaning |
| --- | --- | --- |
| *(PublicSwap fields)* | — | Deposit instructions and provider snapshot. See [PublicSwap](#publicswap). |
| `checkout` | `Checkout` | The shadow Lightning invoice this swap pays. Same shape as [createCheckout](#servicecreatecheckout). |
| `swapData` | `SwapData` | Server-only state for recovering the provider order. Save it on the attempt row. **Never** put it in a browser response or a log. |

`swapData` is `{ version: 1, providerOrder: SwapOrder }`. `version` is the
integer schema version (`1`). `providerOrder` holds provider credentials and
must stay on the server.

### service.getSwap / service.refundSwap

```ts
const status = await service.getSwap({ reference, paymentHash, swapData });
const refunded = await service.refundSwap({ reference, paymentHash, swapData, refundAddress });
```

Both refresh provider state using the `swapData` you loaded.

**Where it fits:** Call `getSwap` when you need the current state of a swap: on
a status endpoint the browser polls, or on an admin page. Call `refundSwap` when
a payer asks for their money back after an underpaid or late deposit and you
have their refund address. Both need the `swapData` you saved when the swap was
created, so call them from your server. The mounted `…/swaps/status` and
`…/swaps/refunds` routes do this for you.

`refundSwap` refuses any provider state other than `refund_required`.

**Parameters**

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `reference` | `string` | yes | The reference the swap attempt belongs to. |
| `paymentHash` | `string` | yes | 64-hex hash of the shadow Lightning invoice. |
| `swapData` | `SwapData` | yes | The server-only recovery state you saved from create. |
| `refundAddress` | `string` | `refundSwap` only | On-chain address to return funds to. |

**Returns** `PublicSwap` — see [PublicSwap](#publicswap) below.

#### PublicSwap

A swap snapshot that is safe to show the payer. It has no provider tokens or credentials.

**Fields of** `PublicSwap` (return value of `getSwap` / `refundSwap`)

| Name | Type | Meaning |
| --- | --- | --- |
| `paymentHash` | `string` | 64-character lowercase hex hash of the shadow Lightning invoice. |
| `reference` | `string` | The reference this swap attempt belongs to. |
| `provider` | `string` | Provider that issued the deposit address. |
| `payInAsset` | `string` | Pay-in asset id, e.g. `"USDC_SOL"`. |
| `depositAddress` | `string` | On-chain address the payer sends to. |
| `depositMemo` | `string?` | Destination tag or memo the payer must include, when the network requires one. |
| `depositAmount` | `string` | Decimal string of crypto the payer must send. Never a binary float. |
| `providerState` | `string` | Provider lifecycle: `creating_provider_order`, `awaiting_deposit`, `confirming`, `exchanging`, `paying_invoice`, `completed`, `expired`, `refund_required`, `refund_pending`, `refunded`, `attention`, or `failed`. Provider `completed` does not mean the wallet has settled. |
| `providerExpiresAt` | `number` | Integer Unix seconds when the provider order expires. |
| `depositTxId` | `string?` | Provider-reported deposit transaction id, when known. |
| `payoutTxId` | `string?` | Provider-reported payout (Lightning pay) transaction id, when known. |
| `refundTxId` | `string?` | Provider-reported refund transaction id, when a refund was sent. |
| `refundReason` | `string?` | Why a refund is needed: `"underpaid"`, `"overpaid"`, `"late_deposit"`, `"underpaid_and_late"`, or `"overpaid_and_late"`. |
| `refundAmount` | `string?` | Decimal string the provider will return, excluding its network fee. |
| `attention` | `boolean?` | `true` when this attempt needs operator review. |
| `attentionReason` | `string?` | Why the attempt needs an operator, when `attention` is set. |
| `depositReceivedAmount` | `string?` | Amount actually received on the deposit transaction, when the provider reports it. The payer UI compares it with `depositAmount` to explain an underpayment. |
| `emergencyRepeat` | `boolean?` | A second deposit hit the same provider order. Extra funds may sit at the provider even though the attempt looks like an ordinary refund. |
| `providerOrderId` | `string?` | The provider's order reference, shown to the payer for support. |
| `fee` | `SwapFee?` | Fiat values that explain why the payer sends more than the cart total. Never use it as the price. The invoice amount is the price. See [SwapFee](#swapfee). |

#### SwapFee

Fiat values attached to a swap for display. The field names follow the
provider's wire shape.

**Fields of** `SwapFee`

| Name | Type | Meaning |
| --- | --- | --- |
| `currency` | `string` | Fiat currency the equivalents are expressed in, e.g. `"USD"`. |
| `pay_in_fiat` | `string` | Fiat value of the crypto the payer sends. It explains the spread. It is never an amount to send. |
| `payout_fiat` | `string` | Fiat value delivered to the merchant, which is the cart total. |

`depositAmount`, in the pay-in token, is the only amount a payer is ever told
to send. The fee figures are values that explain why it is more than the cart
total.

Some stablecoins are pegged to `currency` (`pegged_to` in the shared asset
table). USDT and USDC are pegged to USD. For these, the packaged checkout shows
the breakdown in the token, for example "You send 50.05 USDC" and "Swap +
network fees 1.05 USDC (2.1%)". It never shows `pay_in_fiat`. A "$50.03" one
line under "50.05 USDC" would read as the same number with a typo. Floating
assets (SOL, ETH) keep the fiat breakdown.

`createSwapFeeBreakdown(fee, swap)` applies this rule. Pass it the swap, not
just the fee.

### service.listRates

```ts
const { bitcoin } = await service.listRates(); // or ({ currencies: ["USD", "EUR"] })
```

**Where it fits:** You'll use this for display, not for pricing: a "1 BTC =
$65,000" footer, a currency switcher, a rough sats preview before an order
exists. When it is time to charge, price the order with `prepareCheckout` or
`createCheckout` instead. They lock the quote onto the invoice. A rate you read
here can move before the payer pays.

**Parameters**

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `currencies` | `string[]` | no | Fiat codes to fetch. Default `priceCurrencies`. |

**Returns** `{ bitcoin }`

| Name | Type | Meaning |
| --- | --- | --- |
| `bitcoin` | `Record<string, string>` | Maps each uppercase currency code to the price of 1 BTC in that currency, as a decimal string, e.g. `{ USD: "65000.12" }`. |

The wallet client also has `quoteRates`. It is the internal helper that builds
the `fiatQuote` that `prepareCheckout` / `createCheckout` attach. It exists only
in JS, with no HTTP route and no Ruby counterpart. Use `prepareCheckout` to
quote an amount.

### service.close

```ts
await service.close();
```

**Returns** `Promise<void>`. Closes the underlying wallet client and its relay
connection. If you run the notifications worker, stop it first.

**Where it fits:** At the end of a script, a one-off job, or a test, after the
last wallet call. A long-running server can usually skip it, as explained below.

The wallet client is only created on the first wallet call. So `close()` does
nothing for a wallet client that never minted or scanned.

Call it in **scripts, one-shot jobs, and tests**. An open relay connection keeps
the Node event loop alive. A process that skips `close()` finishes its work
and then hangs instead of exiting.

A long-running server does not need it. No payment state lives in memory. The
wallet plus the payments table hold the truth about settlement, and there is no
queue to drain. So a process that is terminated loses nothing by skipping it.
The Express middleware and the Next handler still expose `close()` if you want a
predictable shutdown on `SIGTERM`. The Fastify plugin registers an `onClose`
hook and closes with the app.

## Host (@openreceive/http)

The object `createHost()` returns. It connects OpenReceive to your
application: your price, your fulfillment, and your database. By convention
it is held in a variable named `host`.

### createHost

```ts
const host = createHost(options: CreateHostOptions): Host
```

**Where it fits:** Write this once, next to where you build the wallet client.
It is where your own code plugs in: `amountFor` looks up the price, `onPaid`
marks the order paid, and `db` is the database connection you already have. Pass
the result to an adapter or to the reconcile functions. With an adapter in
all-in-one form, you give the adapter the same three things and it calls
`createHost` for you.

In the default `db` mode, OpenReceive owns the `openreceive_payments` rows inside
your application's existing database.

**Parameters**

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `db` | `SqlDatabase` | yes | pg Pool/Client, `node:sqlite` DatabaseSync, better-sqlite3, or a custom [SqlAdapter](#sqladapter). |
| `amountFor` | `(reference, context) => amount \| null` | yes | The trusted price for a reference, from your data. Return `null` for a 404. Called only where a price is minted or quoted. You may return an optional `description` beside the price. It is one display string. It is echoed on the prepare and create responses, shown above the amount by both drop-ins, and used as the invoice memo so the payer's wallet shows it too. See [Frontend checkout → Show the payer what they are buying](frontend-checkout.md#show-the-payer-what-they-are-buying). |
| `onPaid` | `PaymentSettlementHook` | yes | Fulfillment. See [onPaid](#onpaid). |
| `tableName` | `string` | no | Default `openreceive_payments`. |
| `clock` | `() => number` | no | Unix-seconds clock override. Used by the reconcile gate and the payment-methods cache TTL. |

#### onPaid

In db mode, `onPaid` receives a `PaymentSettlement`. This is the callback's argument, not a return value.

**Fields of** `PaymentSettlement`

| Name | Type | Meaning |
| --- | --- | --- |
| `reference` | `string` | The reference that just settled. It is the string you passed when the checkout was created. This hook fulfills once per reference, so use one reference per order and never reuse it. |
| `paymentHash` | `string` | 64-character lowercase hex hash of the settled attempt. |
| `paidAt` | `number` | Integer Unix seconds of settlement. Comes from `settled_at`, else the observation time. |
| `details` | `PaymentDetails?` | Wallet row that proved settlement. See [PaymentDetails](#paymentdetails). |
| `query` | `(sql, params?) => Promise<rows>` | Runs SQL inside the settlement transaction. Write it for your own dialect (`?` on sqlite, `$1`-style on postgres). It reaches the driver unchanged. Use it for writes that must commit together with settlement, such as an outbox row. |

`onPaid` runs inside the settlement transaction, and only for the order's first
settled attempt. It is write-once: a second settled attempt for the same order
records `duplicate_settlement` and never fulfills again. Delivery is
at-least-once. If `onPaid` throws, the transaction rolls back and the next
reconciliation pass retries.

Write through the supplied `query`. It is the only handle inside the settlement
transaction. An ORM call made here uses that ORM's own connection, so it commits
separately. It can survive a rolled-back settlement, or be lost when settlement
commits and it does not.

**On Rails this handle does not exist, and that is on purpose.**
The Rails engine wraps the `on_paid` block in an ActiveRecord transaction. Plain
ActiveRecord inside the block is already part of that transaction, so there is
nothing to pass through. `PaymentSettlement` there carries `reference`,
`payment_hash`, `paid_at` and `details`, and no `query`. If you port between the
engines, you only need to know which side supplies the transaction. JS hands you
a handle. Rails wraps your block.

Keep `onPaid` to database writes. Anything that reaches outside the
transaction, such as an email, a webhook, or a shipping call, survives a
rollback and runs again on the retry. Flag the order here, or insert the outbox
row shown below, and let your own worker process it after commit. There is no
after-commit hook, by design.

```ts
onPaid: async ({ reference, query }) => {
  await query("UPDATE orders SET state = 'paid' WHERE id = ?", [reference]);
  // Same transaction: enqueue follow-up work here rather than doing it inline.
  await query("INSERT INTO outbox (kind, reference) VALUES (?, ?)", ["order_paid", reference]);
},
```

If your ORM can run statements on a connection you pass it, wrap `query`.
[Node ORM recipes](node-orms.md) has a recipe for each ORM.

As an advanced escape hatch, you can replace `db` with a full repository
implementation.

**Parameters**

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `payments` | `PaymentRepository` | yes | Your repository. It provides commit locking, write-once settlement, and reconciliation transitions. |
| `onPaid` | `SettlementEventHook<Transaction>` | yes | Receives `reference`, `paymentHash`, `paidAt`, `details?`, and the repository's typed `transaction`. `recordSettlementWithFulfillment` awaits it inside the settlement transaction. A failure rolls back both writes. |

**Returns** `Host`, for the framework adapters and reconcile passes. The
attempt row commits before the payer sees any payment instructions.

- If the repository refuses the commit (an already-paid order, or a competing
  live attempt), the response is `409`.
- If the commit fails because of infrastructure, the response is a retryable `503`.

Either way the invoice is withheld.

| Name | Type | Meaning |
| --- | --- | --- |
| `resolveCheckout` | `function` | Looks up the trusted price, and any live attempt, for the create, check, and swap routes. |
| `onCheckoutCreated` | `function` | Commits the `openreceive_payments` row before the invoice or swap instructions are returned. Receives [CheckoutCreatedInput](#checkoutcreatedinput). |
| `onPaid` | `function` | Delivers settlement. In `db` mode this is the write-once wrapper around your `onPaid` hook. |
| `payments` | `PaymentRepository` | The record of attempts (the ledger). It lists, commits, settles, and records reconciliation transitions. |

#### CheckoutCreatedInput

Passed to `onCheckoutCreated` after the wallet mints and before the HTTP
response is written. If it refuses by throwing a `409`-shaped error, the
response is `409`. Any other throw becomes a retryable `503`. In both cases the
payer gets no payment instructions.

**Fields of** `CheckoutCreatedInput` (argument to `onCheckoutCreated`)

| Name | Type | Meaning |
| --- | --- | --- |
| `reference` | `string` | Your order this attempt belongs to. |
| `paymentHash` | `string` | 64-character lowercase hex hash of the new attempt. |
| `checkout` | `Checkout` | Invoice snapshot, safe for the payer, to save and reuse later. Same shape as [createCheckout](#servicecreatecheckout). |
| `swapData` | `SwapData?` | Server-only state for recovering the provider order. Save it on the row. Never send it to a browser. |
| `clientIp` | `string?` | The client IP the adapter assigned to this request, when one was available. Used by opt-in per-IP rate limiting. |

### The authorize context

Every route that acts on an order calls `authorize(context)` before any wallet
or database work. Returning `false` produces `403 FORBIDDEN`. The optional
`rateLimitHook` uses the same shape. It returns `false` for a `429`.

**Where it fits:** You write `authorize` where you would write a controller's
"is this their order?" check: look up `resource.reference` in your data, compare
it with whoever is logged in on `request` or `native`, and return a boolean.
Every payment route runs it first, so this one function is your whole access
policy for OpenReceive.

There are two deliberate exceptions:

- `GET …/rates` has no order, so it is never authorized.
- The opportunistic reconcile pass runs before authorization. This is the
  settlement check that runs on ordinary requests, limited by a durable gate in
  the database. It reads only OpenReceive's own attempt rows and the wallet,
  and the gate limits how often it runs.

There is one callback type: `(context: AuthorizeContext) => boolean | Promise<boolean>`.
Some snippets destructure `{ native, resource }` or
`{ action, request, resource }`. These are not other signatures. They just name
the fields they read. Sync and async returns both fit this type.

**Fields of** `AuthorizeContext` (argument to `authorize`, not a return value)

| Name | Type | Meaning |
| --- | --- | --- |
| `action` | `AuthorizeAction` | One of `checkout.prepare`, `checkout.create`, `payment.check`, `swap.quote`, `swap.create`, `swap.read`, `swap.refund`. |
| `request` | `Request` | The Web-standard request OpenReceive built (headers, URL, cookies). |
| `resource` | `{ reference?, paymentHash? }` | Copied from the payer's JSON **before** any host lookup. `reference` is on every route that acts on an order. `paymentHash` is also set on `payment.check`, `swap.read`, and `swap.refund`. They identify a row. They do not prove this caller owns it. After `authorize` returns true, the library still checks that a requested hash belongs to that reference. See [Authorization and the host](authorization.md#resource-is-a-claim-not-proof). |
| `native` | `unknown?` | The original framework request (Express `req`, Fastify request, `NextRequest`), when an adapter provides one. Use it for state your middleware attached, such as `req.session`. |

An Express session example. It is the same callback, reading `native` instead of `request`:

```ts
authorize: ({ action, request, resource, native }) => {
  const userId = (native as { session?: { userId?: string } }).session?.userId;
  return userId !== undefined && orders.belongsTo(resource.reference, userId);
},
```

### startReconciler

```ts
const reconciler = await startReconciler({
  service,
  host,
  // optional: pollIntervalMs, overlapSeconds, signal, clock, onError
});
```

**Where it fits:** Use this only when you want a background loop that scans the
wallet on a timer and nothing else, for example on a wallet that cannot send
notifications. Most applications skip it: the request-path pass settles orders
as payers poll, and the notifications worker already includes this loop.

It is a basic polling loop.
[startNotificationWorker](#startnotificationworker) uses it internally, and you
can call it directly, but no adapter or stack starts it. Most applications rely
on the default opportunistic reconcile that runs on requests
([maybeReconcilePayments](#maybereconcilepayments)) and never call this.

**Parameters**

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `service` | `OpenReceive` | yes | The wallet client. |
| `host` | `Host` | yes | From [createHost](#createhost). |
| `pollIntervalMs` | `number` | no | Default 5000. Throws `RangeError` below 250. |
| `overlapSeconds` | `number` | no | Scan overlap. Default 60. |
| `signal` | `AbortSignal` | no | A signal to stop it from outside. |
| `clock` | `() => number` | no | Unix-seconds clock override. Used by the reconcile gate and the payment-methods cache TTL. |
| `onError` | `(error) => void` | no | Called when a pass fails. Default: `console.warn`, without repeats. |

**Returns** `Reconciler`. Every pass goes through the durable reconcile gate
([maybeReconcilePayments](#maybereconcilepayments)). So any number of reconciler
instances, plus the opportunistic reconcile on requests, share one real wallet
scan per gate interval. Construction throws unless the repository implements
`claimReconcileGate` and `checkpointReconcileGate`.

A failed pass is reported and retried from the ledger, so delivery is
at-least-once. Only `pending` attempts are scanned. Settled and closed rows
leave the scan set. This keeps the scan window small without a saved cursor.

| Name | Type | Meaning |
| --- | --- | --- |
| `stop` | `() => void` | Stops scheduling further passes. In-flight work is not cancelled. |
| `done` | `Promise<void>` | Resolves after `stop()` once the current pass (if any) finishes. |

### reconcileHostPayments

```ts
const checks = await reconcileHostPayments({
  service,
  host,
  // optional: overlapSeconds, maxPages, clock
});
```

**Where it fits:** This is the one-shot call: check everything pending and
fulfill what settled. Use it from a cron job, a script, or an admin button when
you want a pass now and want the results back. The gated pass and the worker
call it for you, so it rarely belongs in a normal request.

It runs one pass with a fixed limit. Each pass:

1. Lists the oldest pending attempts, up to `OPENRECEIVE_RECONCILE_BATCH_SIZE`
   (200). A backlog drains over several passes.
2. Scans the wallet once for the whole batch. `maxPages` caps the paged walks.
3. Delivers settlements through `host.onPaid`. Delivery is at-least-once, and
   the repository makes it write-once.
4. Saves final state changes.
5. Returns the [PaymentCheck](#paymentcheck) result for each hash in the pass.

Like every `OPENRECEIVE_*` name in this section, `OPENRECEIVE_RECONCILE_BATCH_SIZE`
is a constant exported by `@openreceive/http`, not an environment variable.

To close an unpaid attempt, a wallet scan must succeed at or after expiry plus
the 900-second grace (`OPENRECEIVE_ATTEMPT_EXPIRY_GRACE_SECONDS`). The local
clock alone never closes a row. A settled result without `paidAt` is retried on
the next pass. On a wallet or repository failure it throws and leaves every row
pending for the next pass.

### maybeReconcilePayments

```ts
const result = await maybeReconcilePayments({
  service,
  host,
  // optional: minIntervalSeconds, scanTimeoutMs, maxPages, overlapSeconds, clock, onError
});
```

**Where it fits:** Call this from routes of your own that a waiting payer hits,
such as a custom order-status endpoint, so settlement gets a chance to run there
without a separate worker. It is cheap to call often: it does nothing when
nothing is pending, and the durable gate makes many web instances share one
wallet scan. The mounted routes already call it, so you only add it where you
have built your own.

**Parameters**

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `service` | `OpenReceive` | yes | The wallet client. |
| `host` | `Host` | yes | From [createHost](#createhost). |
| `minIntervalSeconds` | `number` | no | The shortest gate interval. Default and minimum: `OPENRECEIVE_MIN_RECONCILE_INTERVAL_SECONDS` (2). The interval grows with the age of pending invoices: 2 s while any pending invoice is under 2 minutes old, 6 s under 5 minutes, else 12 s. |
| `scanTimeoutMs` | `number` | no | Time limit on the awaited pass. Default `OPENRECEIVE_RECONCILE_SCAN_TIMEOUT_MS` (9000). |
| `maxPages` | `number` | no | Page cap per wallet walk. Default `OPENRECEIVE_RECONCILE_SCAN_MAX_PAGES` (50). |
| `overlapSeconds` | `number` | no | Scan overlap. Default 60. |
| `clock` | `() => number` | no | Unix-seconds clock override. Used by the reconcile gate and the payment-methods cache TTL. |
| `onError` | `(error) => void` | no | Called when a scan fails. Default: `console.warn`. |

This is the gated pass behind the handler's default opportunistic reconcile on
requests. It is exported so you can drive settlement from your own routes or
middleware. Your own routes never run it automatically. It works like this:

1. If nothing is pending, it skips without calling the wallet.
2. It claims the durable `openreceive_meta` gate. The claim is an optimistic
   compare-and-swap (CAS) shared by every instance on your database.
   `gate_busy` means another worker just scanned.
3. Otherwise it awaits one bounded
   [reconcileHostPayments](#reconcilehostpayments) pass.

It never throws. A failed or timed-out scan reports to `onError` and returns
`scan_failed`. The gate's claim stays in place, so a broken wallet cannot
trigger a flood of retries.

**Returns** `{ reason: "ran", checks }` (the per-hash
[PaymentCheck](#paymentcheck) results) or
`{ reason: "no_pending" | "gate_busy" | "scan_failed" }`.

### startNotificationListener

```ts
const listener = await startNotificationListener({
  service,
  host,
  // optional: overlapSeconds, onError
});
```

**Where it fits:** Use it when you already run your own periodic reconcile and
only want the notification part: one long-running process that settles an order
the moment the wallet announces the payment. If you don't have that loop, use
[startNotificationWorker](#startnotificationworker), which does both.

**Parameters**

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `service` | `OpenReceive` | yes | Must implement `subscribeWalletNotifications`. Otherwise it rejects with `UNSUPPORTED_METHOD`. |
| `host` | `Host` | yes | Where settlement goes and where pending attempts come from. |
| `overlapSeconds` | `number` | no | Overlap for fallback scans. |
| `onError` | `(error) => void` | no | Receives failures. Default: a `console.warn` with secrets removed, so a listener that keeps failing is never silent. |

**Returns** `NotificationListener`

| Name | Type | Meaning |
| --- | --- | --- |
| `stop` | `() => Promise<void> \| void` | Unsubscribes from wallet notifications and waits for any in-flight reconcile pass. |

Most applications use
[startNotificationWorker](#startnotificationworker)
instead. It wraps this listener plus the periodic pass.

This is an opt-in NWC-02 listener that can settle attempts directly.
Notifications are authenticated wallet data. So a `payment_received` payload
settles its attempt directly through `host.onPaid`, with no wallet scan for
that invoice, when both of these hold:

- it meets the settlement rule: `settled_at` or a settled transaction state,
  never a preimage alone, and
- it matches a pending attempt.

Settling removes the attempt from the pending set, so no later pass scans it
again.

Anything less wakes one gated pass
([maybeReconcilePayments](#maybereconcilepayments)). That covers no payload, no
sign that the payment is final, or a hash that is unknown or not pending. A
burst of notifications queues at most one follow-up pass. A pass that another
worker just ran is not repeated.

If direct settlement fails, it reports to `onError` **and** falls back to a
scan. A periodic pass, either the worker's or the opportunistic reconcile on
requests, remains the safety net for notifications missed while offline.

Direct settlement assumes the NWC client ties notification decryption to the
connection's wallet pubkey. The bundled SDK does this. Do not allow direct
settlement for a custom client that skips author verification.

### startNotificationWorker

```ts
const worker = await startNotificationWorker({
  service,
  host,
  // optional: pollIntervalMs, overlapSeconds, onError
});
```

**Where it fits:** Run this when you want orders marked paid within a second of
the payment arriving, instead of on the payer's next poll. Put it in a small
script of its own and run it as a separate process next to your web server, for
example a `worker` line in your Procfile. Stop it before you call
`service.close()`. It is optional. A web deployment with no worker still settles
every order through the pass that runs on requests.

**Parameters**

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `service` | `OpenReceive` | yes | The wallet client. |
| `host` | `Host` | yes | From [createHost](#createhost). |
| `pollIntervalMs` | `number` | no | Interval of the periodic safety-net pass. Default 15000. |
| `overlapSeconds` | `number` | no | Scan overlap. Default 60. |
| `onError` | `(error) => void` | no | Receives failures. Default: a `console.warn` with secrets removed, so a listener that keeps failing is never silent. |

The worker is optional. It is one separate long-lived process that runs two
things:

- the [notification listener](#startnotificationlistener), which settles
  directly when a payment is final and otherwise runs one pass, and
- the periodic reconcile pass, the safety net for notifications missed while
  the worker was down.

Every scan it takes goes through the same durable reconcile gate as the pass on
requests. So the worker plus any number of web instances still share one wallet
scan per interval. If the wallet does not support notifications, the worker
falls back to the periodic pass alone and reports this through `onError`.

There is deliberately no `npx openreceive notifications` CLI, because the CLI
cannot see your `onPaid` or database. Start the worker from a small script of
your own.

**Returns** `NotificationWorker`

| Name | Type | Meaning |
| --- | --- | --- |
| `stop` | `() => Promise<void>` | Unsubscribes, stops the periodic pass, and waits for in-flight work. Call it before `service.close()`. |
| `done` | `Promise<void>` | Resolves after `stop()` once the periodic loop has drained. |

### Settlement entry points

Settlement arrives in two ways:

- **The opportunistic reconcile pass on requests.** This is the default. Any
  mounted payment route runs it, gated by the durable `openreceive_meta` row.
  The unauthenticated `GET …/rates` never triggers it, so crawlers and health
  checks cannot use up the wallet-scan budget.
- **The optional [notifications worker](#startnotificationworker).**

`POST /payments/check` never walks the wallet for its own invoice. It uses the
result of the request's pass.

- If this request won the gate, it serves `status`/`paid_at`/`details` straight
  from the pass. Settlement was already delivered inside the pass.
- On `gate_busy`, or with opportunistic reconcile disabled, it serves the stored
  row without `details`. A row in `attention` shows as `pending` on the wire.

Both paths are safe to replay, because they share the same write-once path.
`onPaid` still runs inside the web request when that request wins the pass. So
fulfillment work must be safe to run inside a web request. Keep it
transactional, or enqueue an outbox job.

## Framework adapters

All three adapters serve the route set in the OpenAPI spec and accept two
forms of options.

Each adapter re-exports only a chosen part of `@openreceive/http`: the handler
and stack factories, their options, context and hook types, the error classes,
the notification worker, and the generated `Wire*` body types. The order-bridge
internals (`createSqlPayments`, the reconcile gate, `createHost`, rate-limit
internals) live only in `@openreceive/http`. Import them from there when you
compose your own integration. `npm run check:public-api` locks these surfaces.

**All-in-one form** (the usual path): order hooks plus `wallet` and `storage`.
The adapter builds the wallet client and host itself. Startup waits until the
first request, which awaits the wallet preflight. The Express middleware and
the Next handler expose `ready` (a promise) and `close()` (closes the wallet
client they own). The Fastify plugin exposes neither. It registers an `onClose`
hook that shuts the stack down with the app.

**Parameters**

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `wallet` | `{ nwc }` \| `{ service }` | yes | The wallet. Either a receive-only NWC connection string, where the adapter builds and owns the client, or a prebuilt `OpenReceive` / `Promise<OpenReceive>`, where you own its lifecycle. |
| `storage` | `{ db, onPaid, tableName? }` \| `{ payments, onPaid }` | yes | Where attempts live. This decides what `onPaid` receives. With the database handle [createHost](#createhost) takes, `onPaid` gets the per-reference `PaymentSettlement`. With a custom `PaymentRepository` (see [Storage: the escape hatch](storage.md#escape-hatch)), it gets `SettlementEvent<Transaction>` and its transaction handle. |
| `amountFor` | | yes | Same hook as [createHost](#createhost). |
| `authorize` | `Authorize` | yes | Your policy. See [the authorize context](#the-authorize-context). |
| `opportunisticReconcile` | `false \| { minIntervalSeconds }` | no | The settlement pass that runs on every mounted payment route. `GET …/rates` never triggers it. On by default, through the durable `openreceive_meta` gate. `false` turns it off. `{ minIntervalSeconds }` tunes it. |
| `clock` | `() => number` | no | Unix-seconds clock override. Used by the reconcile gate and the payment-methods cache TTL. |
| `onBootFailure` | `(message: string) => void` | no | Where the single boot-failure line goes. Default `console.error`. Boot happens before any service exists, so this is the only place to send it. It receives only the message, never the raw cause. Requests during a failed boot answer `503 WALLET_UNAVAILABLE` either way. See [Deploying](deploying.md#where-boot-failures-go). |
| `rateLimiting` / `rateLimitHook` / `prefix` | | no | As below. |
| `trustProxyIpHeader` | `boolean \| string` | no | Extra option on all three adapters. It tells `rateLimiting` how to find the client IP behind a reverse proxy. `true` reads the first hop of `x-forwarded-for`. A string names another trusted header, e.g. `"cf-connecting-ip"`. Only safe when your own proxy sets the header. |

**Composed form** (`CreateHttpHandlerOptions`), for shared wallet clients,
custom repositories, and tests:

**Parameters**

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `service` | `OpenReceive` | yes | From [createOpenReceive](#createopenreceive). |
| `authorize` | `Authorize` | yes | Your policy. See [the authorize context](#the-authorize-context). |
| `host` | `Host` | yes | From [createHost](#createhost). |
| `opportunisticReconcile` | `false \| { minIntervalSeconds }` | no | As above. With a custom repository, leaving it on (the default) requires `payments.claimReconcileGate` and `payments.checkpointReconcileGate`. Otherwise construction throws, the same way `rateLimiting` does. |
| `rateLimitHook` | `RateLimit` | no | Same context shape as `authorize`. Return `false` for a `429`. |
| `rateLimiting` | `boolean \| IpRateLimitConfig` | no | Opt-in per-IP invoice cap. Off by default. `true` = 60/hour. Cannot be used with `rateLimitHook`. See [Rate limiting](rate-limiting.md). |
| `prefix` | `string` | no | Mount prefix. Default `/openreceive`. |

The same all-in-one form is available without a framework as
`createStack(options)` in `@openreceive/http`. It returns
`{ handler, ready, close }`.

Create routes reject amounts sent by the payer and take the price from
`amountFor`. Payment and swap reads take `reference` plus `payment_hash`. After
your authorization passes, the library checks that this exact attempt belongs
to the order and supplies the server-only `swap_data`.

HTTP JSON is snake_case. The values are the same as the Node objects above.
The table below is generated from the
[OpenAPI contract](../../spec/openapi/openreceive-http.v1.yaml), which is the
authority. `…` is the mount prefix (default `/openreceive`).

<!-- generated:routes -->
<!-- Generated by tools/docs/generate-spec-tables.mjs from spec/. Edit the spec, then rerun the generator; never edit this block by hand. -->

| Route | Status | Response body |
| --- | --- | --- |
| `POST …/checkouts/prepare` | 200 | `PrepareCheckoutResponse` `{ reference, amount_msats, description?, fiat_quote?, payment_methods }` |
| `POST …/checkouts` | 201 | `CreateCheckoutResponse` `{ checkout: Checkout, description?, payment_methods }` |
| `POST …/payments/check` | 200 | `PaymentCheck` `{ payment_hash, status: PaymentStatus, paid_at?, details?: PaymentDetails, payment_methods }` |
| `POST …/swaps/quote` | 200 | `SwapQuote` `{ provider, pay_asset: SwapPayInAsset, available, pay_amount?, minimum_pay_amount?, maximum_pay_amount?, minimum_invoice_amount_msats?, maximum_invoice_amount_msats?, unavailable_reason?, unavailable_message? }` |
| `POST …/swaps` | 201 | `CreateSwapResponse` `{ swap: SwapCheckout }` |
| `POST …/swaps/status` | 200 | `Swap` `{ payment_hash, reference, provider, pay_in_asset: SwapPayInAsset, deposit_address, deposit_memo?, deposit_amount, provider_state: SwapProviderState, provider_expires_at, deposit_tx_id?, payout_tx_id?, refund_tx_id?, refund_reason?, refund_amount?, attention?, attention_reason?, deposit_received_amount?, emergency_repeat?, provider_order_id?, fee?: SwapFee }` |
| `POST …/swaps/refunds` | 200 | `Swap` `{ payment_hash, reference, provider, pay_in_asset: SwapPayInAsset, deposit_address, deposit_memo?, deposit_amount, provider_state: SwapProviderState, provider_expires_at, deposit_tx_id?, payout_tx_id?, refund_tx_id?, refund_reason?, refund_amount?, attention?, attention_reason?, deposit_received_amount?, emergency_repeat?, provider_order_id?, fee?: SwapFee }` |
| `GET …/rates` | 200 | `RatesResponse` `{ bitcoin }` |
<!-- /generated:routes -->

How the bodies map to the Node objects above:

- `POST …/checkouts` returns [Checkout](#servicecreatecheckout) in snake_case
  (the generated `WireCheckout`).
- `POST …/checkouts/prepare` returns the prepare result plus
  [swap options](#servicelistswapoptions).
- `POST …/payments/check` returns [PaymentCheck](#paymentcheck) plus
  `payment_methods`. This is the same swap-option list. It is empty when
  Lightning is the only payment rail. It comes from a 60-second cache inside
  the handler, so status polls every ~3s do not walk the provider catalog on
  every request.
- `POST …/swaps/quote` returns the snake_case quote (`provider`, `pay_asset`,
  `available`, `pay_amount?`, limits).
- `POST …/swaps` returns [PublicSwap](#publicswap) plus a nested `checkout`,
  with `swap_data` removed.
- `…/swaps/status` and `…/swaps/refunds` return the bare snake_case
  [PublicSwap](#publicswap) object, with no `{ swap }` wrapper. Only
  `POST …/swaps` wraps it.
- `GET …/rates` returns `{ bitcoin: { <currency>: "<price>" } }`.

### Repeating a create: mint, or re-serve

`POST …/checkouts` and `POST …/swaps` do not always mint. **A request mints
only when the order has no saved attempt it can serve again. Otherwise it
answers with the attempt the order already has.** That means no wallet call, no
provider order, no second row, and no rate-limit charge. This makes a reload, a
back button, or a payer picking the same coin again safe. They get their own
deposit instructions back, not a second address to send to.

Serving the old attempt again has conditions. Know them before you build resume
on top of it. The attempt must be:

- unpaid and live,
- on the same payment rail (and, for a swap, the same `pay_in_asset`), and
- more than 60 seconds before its own expiry.

Past that point, the same call **mints a replacement**: a fresh BOLT11, or a
fresh deposit address. A swap's expiry is the expiry of its shadow Lightning
invoice. The provider sizes that invoice to outlast its deposit window, roughly
half an hour with FixedFloat's defaults. So a payer returning the next day gets
a new attempt rather than their old one. Two live attempts on the same rail for
one reference is a `409 CONFLICT`.

**`POST …/swaps/status` has no such window.** It takes
`{ reference, payment_hash }` and addresses that one attempt directly. So it
still answers for an attempt that stopped being payable hours ago. That makes
the payment hash, not the chosen asset, the lasting handle for bringing a payer
back to a deposit or refund screen. See
[Swap refunds → The way back](swap-refunds.md#the-way-back).

### Errors

The error body and the per-route error statuses are generated from the spec.
`429` responses also carry a `Retry-After` header. Both engines answer two
statuses before `authorize` runs:

- `415` for a body that is not `application/json`, and
- `403` for a request the browser labels `Sec-Fetch-Site: cross-site`. See
  [Cross-site requests](authorization.md#cross-site-requests).

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
| `POST …/checkouts/prepare` | `400`, `403`, `404`, `405`, `413`, `415`, `429`, `500`, `503` |
| `POST …/checkouts` | `400`, `403`, `404`, `405`, `409`, `413`, `415`, `429`, `500`, `502`, `503` |
| `POST …/payments/check` | `400`, `403`, `404`, `405`, `409`, `413`, `415`, `429`, `500`, `502`, `503` |
| `POST …/swaps/quote` | `400`, `403`, `404`, `405`, `413`, `415`, `429`, `500`, `503` |
| `POST …/swaps` | `400`, `403`, `404`, `405`, `409`, `413`, `415`, `429`, `500`, `502`, `503` |
| `POST …/swaps/status` | `400`, `403`, `404`, `405`, `413`, `415`, `429`, `500`, `502`, `503` |
| `POST …/swaps/refunds` | `400`, `403`, `404`, `405`, `409`, `413`, `415`, `429`, `500`, `502`, `503` |
| `GET …/rates` | `400`, `405`, `500`, `501`, `503` |
<!-- /generated:route-errors -->

#### Error codes: who retries, and whose bug

The body includes `retryable` when it differs from the code's own default. Use
the "Whose bug" column to decide where an error goes. A `yours` row belongs in
your error tracker. A `payer` row does not.

| Code | Typical status | Retryable | Whose bug | Means |
| --- | --- | --- | --- | --- |
| `INVALID_REQUEST` | 400, 413, 415 | no | payer / integrator | Malformed body, unknown field, payer-supplied amount, oversized body, wrong content type. |
| `UNAUTHORIZED` | 401 | no | payer | Your `authorize` refused an unauthenticated caller. |
| `FORBIDDEN` | 403 | no | payer | Your `authorize` refused, or the browser labelled the request `Sec-Fetch-Site: cross-site`. |
| `NOT_FOUND` | 404 | no | payer | Unknown reference (your `amountFor` returned `null`), unknown attempt, or no route. |
| `CONFLICT` | 409 | no | payer | Already paid, a live attempt on the same rail, a non-reusable attempt, or `onCheckoutCreated` refused. |
| `RATE_LIMITED` | 429 | **yes** (`Retry-After`) | payer | Per-IP invoice cap. Never applied to status polls or quotes. |
| `INTERNAL` | 500, 502, 503 | **yes** at 503 | **yours** (500) / provider (502, 503) | 500 is a bug in your integration or the library. Log it. 502/503 come from the wallet or swap provider. Retry. |
| `WALLET_UNAVAILABLE` | 503 | **yes** | wallet / infra | The wallet client cannot answer, including a failed adapter boot. |
| `UNSUPPORTED_METHOD` | 502 | no | wallet | The wallet does not honor part of the receive contract (e.g. it ignores the requested invoice expiry). |
| `TIMEOUT` | 503 | **yes** | wallet / provider | An outbound call ran out of time. |
| `INVOICE_EXPIRED` | 409 | no | payer | The addressed invoice is past its expiry. |
| `NOT_IMPLEMENTED` | 501 | no | integrator | The route needs configuration you did not supply (e.g. `GET /rates` with no price provider). |
| `QUOTA_EXCEEDED`, `RESTRICTED`, `UNSUPPORTED_ENCRYPTION`, `OTHER` | 502, 503 | varies | wallet | Passed through from the wallet's own NIP-47 error codes. |

#### Status vocabularies: who sees which

Six different "status" vocabularies appear across the stack. They are NOT
the same set of values, and each has exactly one audience.

| Vocabulary | Values | Who reads it | Where it lives |
| --- | --- | --- | --- |
| **Attempt status** | `pending`, `settled`, `expired`, `failed`, `attention` | **Operator** (and your database) | The `openreceive_payments.status` column. `attention` is the one that needs a human. It reads as `pending` on the wire. See [Storage](storage.md#attempt-state-machine). |
| **Payment check status** | `pending`, `settled`, `expired`, `failed`, `not_found` | **Host** polling `payments/check` | The wire answer for one hash. `not_found` means the scanned window did not contain it. It never means "unpaid". |
| **NWC transaction state** | `pending`, `settled`, `expired`, `failed`, `accepted` | **Library**, internally | The wallet's own word for a row, normalized when it enters the client. Hosts do not branch on it. |
| **Checkout snapshot status** | `open`, `paid`, `expired` | **Payer UI** | The rough state a browser snapshot carries for the whole checkout. |
| **Checkout phase** | `invoice_created`, `verifying`, `settled`, `expired`, `failed`, `cancelled` | **Payer UI** | What the panel is showing right now, for one attempt. Display only. Nothing on the server reads it. |
| **Swap provider state** | `creating_provider_order`, `awaiting_deposit`, `confirming`, `exchanging`, `paying_invoice`, `completed`, `expired`, `refund_required`, `refund_pending`, `refunded`, `attention`, `failed` | **Payer UI** (swap panel) | The provider's progress. It never decides settlement. `completed` does not fulfill an order. Only the wallet sweep does. See [Automated swaps](automated-swaps.md#provider-state-after-settlement). |

`deriveStatus(invoice)` gives the browser's one-word verdict for an attempt:
`pending`, `settled`, `expired` or `failed`. These are the payment check's
words minus `not_found`, because a snapshot always has an attempt. It comes
from the server's `transaction_state`. The browser never works out "settled"
from `settled_at` itself.

### openReceiveExpress

```ts
app.use(openReceiveExpress(options)): ExpressMiddleware
```

Express middleware. It handles requests under its prefix and calls `next()` for
everything else. The original Express `req` is passed as `native`.

**Where it fits:** This is the one line that puts OpenReceive in an Express app.
`app.use(...)` it once at startup, before your 404 handler, and every checkout,
status, swap, and rates route exists under `/openreceive`. Put your session
middleware ahead of it so `authorize` can read `native.session`.

### openReceiveFastify

```ts
await fastify.register(openReceiveFastify, options)
```

Fastify plugin. It registers a catch-all route under `prefix`. The original
Fastify request is passed as `native`. Options are the shared all-in-one or
composed set above, plus `trustProxyIpHeader`.

- Pass `prefix` **at `register()`** so Fastify scopes the route to it. A
  `prefix` that disagrees with the register scope fails registration.
- Fastify parses JSON itself, so there is no body parser to add.
- Behind a reverse proxy, `Fastify({ trustProxy: true })` makes `request.ip`
  the payer's IP. This is the same rule as Express's `trust proxy`.

**Where it fits:** Register it once during app setup, after whatever plugin
gives you sessions or auth decorations, because `authorize` sees the same
request object. Shutdown is handled for you. The plugin closes the wallet client
with the app. Full walkthrough: [Fastify quickstart](quickstart-fastify.md).

### openReceiveNextHandlers

```ts
export const { GET, POST } = openReceiveNextHandlers(options)
```

Next.js App Router handlers. Mount them as a catch-all route
(`app/openreceive/[...openreceive]/route.ts`) that exports
`runtime = "nodejs"` and `dynamic = "force-dynamic"`. The incoming `NextRequest`
is passed as `native`. Options are the shared all-in-one or composed set above,
plus `trustProxyIpHeader`. Here `trustProxyIpHeader` is required when you use
`rateLimiting`, because a web `Request` has no socket IP
([Rate limiting](rate-limiting.md)). Full walkthrough:
[Next.js quickstart](quickstart-next.md).

**Where it fits:** Create one catch-all route file, export what this returns,
and the whole route set is live. Keep it on the Node runtime, not the Edge
runtime, because it needs your database driver and a relay connection. Read
cookies or headers from `request` inside `authorize` the way you would in any
route handler.

**Returns** the App Router handler object

| Name | Type | Meaning |
| --- | --- | --- |
| `GET` | `(request) => Promise<Response>` | App Router GET export. Every shipped route is POST except `GET …/rates`. Exporting both lets the catch-all module serve all of them. |
| `POST` | `(request) => Promise<Response>` | App Router POST export. Routes requests to the OpenReceive route set. |
| `handler` | `(request) => Promise<Response>` | The same request router, for tests or a custom method map. |
| `ready` | `Promise<void>` | All-in-one form only: resolves when the wallet client is up. |
| `close` | `() => Promise<void>` | All-in-one form only: closes the owned wallet client. |

## Persistence

### createSqlPayments

```ts
const payments = createSqlPayments(db, options?): SqlPaymentRepository
```

**Where it fits:** You'll only call this directly in the composed form, when you
want to hold the repository yourself: to look at attempts with
`listForReference` in an admin tool, or to share one repository between a host
and a test. `createHost({ db })` builds it for you otherwise.

**Parameters**

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `db` | `SqlDatabase` | yes | pg Pool/Client, SQLite handle, or an [SqlAdapter](#sqladapter). |
| `tableName` | `string` | no | Default `openreceive_payments`. |
| `metaTableName` | `string` | no | Key/value table that holds the durable reconcile gate. Default `openreceive_meta`. |
| `clock` | `() => number` | no | Unix-seconds clock override. Used by the reconcile gate and the payment-methods cache TTL. |

This is the repository the library owns behind `createHost({ db })`, exposed for
advanced integrations. It is responsible for:

- locking commits per reference (SQLite `BEGIN IMMEDIATE`, postgres advisory lock),
- deciding whether a new attempt replaces a live one or conflicts with it,
- the `pending → settled | expired | failed | attention` state machine, and
- `markPaidOnce`, the settlement transaction that is safe to replay. It
  fulfills only the order's first settled attempt and never overwrites a
  settled row.

**Returns** `SqlPaymentRepository`

| Name | Type | Meaning |
| --- | --- | --- |
| `listForReference` | `(reference) => Promise<PaymentRecord[]>` | Every attempt row for that order, newest first. Includes settled and closed history. |
| `listReconcilableAttempts` | `(after?) => Promise<ReconcilableAttempt[]>` | Up to 200 pending rows after a `(created_at, payment_hash)` position (a keyset, used for paging). `expiresAt` is the saved wallet deadline. When it is unknown where the creation time came from, it searches a wider window. |
| `commitAttempt` | `(input) => void \| Promise<void>` | Inserts one new attempt under a lock. Throws on a settled order, or when a reusable live attempt exists on the same rail. |
| `recordReconciliation` | `(transition) => void \| Promise<void>` | Applies a final non-settled transition, but only while the row is still `pending`. Never overwrites a settled row. |
| `recordSettlementWithFulfillment` | `(settlement, fulfill) => boolean \| Promise<boolean>` | Required. In one atomic step it locks the reference, settles the pending row, awaits the host callback, and commits. Returns whether this call won the first-settlement claim for the reference. Rolls back on failure. Older repositories that return only a boolean are rejected. |
| `findByPaymentHash` | `(hash) => Promise<PaymentRecord \| undefined>` | Required, as the durable acknowledgment. A wallet success is served only after its row is settled. |
| `countAttemptsFromIp` | `(clientIp, sinceUnixSeconds) => number \| Promise<number>` | Attempt rows for this IP at or after that time. Used by opt-in `rateLimiting`. |
| `claimReconcileGate` | `({ now, intervalSeconds, leaseSeconds? }) => ReconcileGateClaim \| null` | A durable compare-and-swap (CAS) claim holding a token and scheduler state, or `null` when busy. Async implementations return a Promise. |
| `checkpointReconcileGate` | `({ claim, scheduler, now, release?, intervalSeconds? }) => boolean \| Promise<boolean>` | Saves limited keyset and scan progress, but only while the token still holds its unexpired lease. |
| `listRepairCandidates` | `({ after?, limit? }?)` | SQL repository only. A limited, read-only report of attempts in `attention` and of swap attempts that were clearly closed too early. It contains no credentials. |
| `requeueAttempt` | `({ paymentHash, expectedStatus, expectedUpdatedAt, reason })` | SQL repository only. Puts an attempt you have reviewed back in the queue, under the reference lock. Keeps the repair audit trail. Never changes a settled row. |
| `markPaidOnce` | `(input, fulfill) => Promise<boolean>` | Write-once settlement. Sets `paid_at` / `settled` once and runs `fulfill` only for the first settled attempt for a reference. **Resolves `true` only for the call that won that first-settlement claim.** Later calls, such as a redelivered notification or a sibling attempt, record the settlement, skip `fulfill`, and resolve `false`. A direct caller uses that boolean to avoid doing its own work twice. |

A custom `PaymentRepository` must also implement `claimReconcileGate` and
`checkpointReconcileGate`, unless you pass `opportunisticReconcile: false`.
Both must be durable CAS operations. Never use an in-process cooldown, because
memory cannot coordinate separate workers. Handler construction throws if they
are missing.

### paymentsSchemaSql

```ts
paymentsSchemaSql(dialect: "postgres" | "sqlite", tableName?, metaTableName?): string
```

**Where it fits:** Use this when writing the migration that creates
OpenReceive's two tables in your own migration tool. Call it and execute the
string it returns. If you use one of the supported ORMs, `npx openreceive
scaffold payments` writes the same DDL in that ORM's migration format instead.

**Parameters**

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `dialect` | `"postgres" \| "sqlite"` | yes | Which SQL dialect to emit. |
| `tableName` | `string` | no | Payments table name. Default `openreceive_payments`. |
| `metaTableName` | `string` | no | Reconcile-gate table name. Default `openreceive_meta`. |

**Returns** `string`: the DDL for two tables in that dialect.

- `openreceive_payments` holds the attempts, with its indexes.
- `openreceive_meta` holds the reconcile gate
  (`key TEXT PRIMARY KEY, value TEXT NOT NULL, rev`). It starts with a
  `schema_version` row.

`tableName` and `metaTableName` rename them. The statements themselves live in
`@openreceive/core` (`paymentsDdlStatements` in `payments-ddl.ts`). This helper
and the scaffold CLI's ORM migrations are both built from that one source. Run
it through your own migration workflow. The scaffold CLI wraps it per ORM.
Keep every column and constraint. `payment_hash` is globally unique.
`reference` is indexed, not unique.

### SqlAdapter

The database interface to implement yourself when the built-in pg/SQLite
bindings do not fit.

```ts
interface SqlAdapter {
  dialect: "postgres" | "sqlite";
  query(sql: string, params?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
  transaction<T>(run: (tx: { query }) => Promise<T>): Promise<T>;
}
```

**Where it fits:** You implement this when your database access goes through
something the library does not know: a driver it has no binding for, a
connection wrapper of your own, or an ORM without a named factory below. It has
two methods, and the rules are simple: pass the SQL through unchanged, and make
`transaction` a real transaction. Check the ORM factories first. Most people
never write one.

`query` receives each statement already written for the adapter's declared
dialect (`?` on sqlite, `$1`-style on postgres). It must pass the statement to
the driver EXACTLY as given. Nothing rewrites placeholders, in either direction.
It returns SELECT rows (`Record<string, unknown>[]`), or `[]` for a non-SELECT.
`transaction` must be truly atomic. Write-once settlement and fulfillment both
run inside it.

### knexDb / prismaDb / typeOrmDb / sequelizeDb

```ts
createHost({ db: knexDb(knex, "postgres") });        // or prismaDb(prisma, …),
createHost({ db: typeOrmDb(dataSource, "sqlite") }); // sequelizeDb(sequelize, …)
```

Ready-made `SqlAdapter` factories for the ORM handles that `createSqlPayments`
cannot accept directly.

**Where it fits:** Pick the one that matches your ORM. Pass its result as `db`
wherever you would have passed a pg pool, right where you build the host, using
the ORM handle your application already shares. That is all the persistence
wiring you need.

The parameter types (`KnexLike`, `PrismaLike`, `TypeOrmLike`,
`SequelizeLike`) only describe the shape they need, so no ORM dependency is
added. `dialect` (`SqlDialect`) is required, because nothing on the handles
states it reliably. Each factory handles its ORM's raw-query quirks:

- `knexDb` normalizes the result shape, which differs per driver.
- `prismaDb` sends each statement to either `$queryRawUnsafe` or
  `$executeRawUnsafe`. A statement with `RETURNING` counts as one that returns rows.
- `typeOrmDb` queries through the transaction's own `EntityManager`.
- `sequelizeDb` binds parameters through `bind` and passes the managed
  transaction into every statement inside it.

See [Node ORM recipes](node-orms.md) for the wiring guide.

### PaymentRecord

One `openreceive_payments` row as returned by `payments.listForReference`.

**Fields of** `PaymentRecord`

| Name | Type | Meaning |
| --- | --- | --- |
| `reference` | `string` | Your order this attempt belongs to. |
| `paymentHash` | `string` | 64-character lowercase hex hash. Unique across all orders. |
| `status` | `"pending" \| "settled" \| "expired" \| "failed" \| "attention"` | Where the attempt is in its lifecycle. Only `pending` is scanned. `attention` means the wallet still reports an in-progress state long after expiry. |
| `statusReason` | `string \| null` | Detail for the operator about the current status, e.g. `"superseded"` or `"duplicate_settlement"`. Absent or `null` when there is nothing extra to say. |
| `paidAt` | `number \| null` | Integer Unix seconds of settlement, or `null` if this attempt never settled. |
| `expiresAt` | `number` | Integer Unix seconds after which these payer instructions must not be reused. |
| `createdAt` | `number` | Integer Unix seconds, used to sort past attempts in a stable order. |
| `checkout` | `Checkout` | Payer snapshot that is safe to show and to serve again. Same shape as [createCheckout](#servicecreatecheckout). |
| `swapData` | `SwapData \| null` | Server-only state for recovering the provider order. `null` or omitted for Lightning-only attempts. Never put it in a browser response. |

## Browser & React

These are the browser and React pieces you wire up. The Vue, Svelte and Angular
wrappers hand off to the same custom element and accept the same attributes.

`prefix` is the only URL input the browser packages take. It is the base path
where the shipped router is mounted. Every route they call is built from it:
`/checkouts`, `/checkouts/prepare`, `/payments/check`, `/swaps`, `/swaps/quote`,
`/swaps/status`, `/swaps/refunds`. There is no per-route override, so a checkout
cannot be created against one mount and settled against another.

Failed status polls wait longer after each failure (exponential backoff) and
honor the server's `Retry-After`. Network and HTTP failures are thrown as
`BrowserRequestError`, carrying `status`/`code`/`retryable`/`retryAfterSeconds`.

### prepareCheckout

From `@openreceive/browser`: `prepareCheckout({ reference, prefix, fetch?, headers? })`.
Calls POST `/checkouts/prepare`. It locks the amount and returns payment methods
without minting.

### requestCheckout

From `@openreceive/browser`:
`requestCheckout({ reference, prefix, fetch?, headers?, memo?, metadata?, previous? })`.
Calls POST `/checkouts`. It mints (or reuses) a bolt11 and returns the snapshot.

The response echoes `payment_methods` alongside `checkout` (contract 0.4.1). So
the list of pay-in methods survives a mint on its own, for any client, not just
this package.

Pass `previous` when you drive the prepare-then-mint flow yourself and want the
snapshot to **carry over**. `previous` is the snapshot already on screen,
normally what `prepareCheckout` returned. It carries sibling attempts, such as a
live swap next to the new bolt11, that the mint response knows nothing about.
It also still carries the method list forward against a server older than
0.4.1. The shipped renderers do this for you.

### `<Checkout>`

From `@openreceive/react`. A complete checkout in one component. It has two modes:

- **Create mode:** pass `reference` + `prefix`.
- **Snapshot mode:** pass `checkout`, plus `prefix` for polling. `prefix`
  defaults to `/openreceive`, so a bare snapshot still polls.

`polling={false}` renders without status polling and keeps the swap flow
working.

Common props:

- the seven handlers: `onCopy`, `onOpenWallet`, `onState`, `onSettled`,
  `onProviderCopy`, `onStartOver`, `onError`
- `polling`, `pollIntervalMs`, `paymentWizard`
- `theme`: a lock set by your app. It wins over the stored preference and hides
  the toggle.
- `themeToggle`: default `true`. `false` hides the control, but the checkout
  still sets `data-theme`.
- `defaultTheme`, `storageKey`, `decodeLinkUrl`, `csrfHeader`, `components`,
  `classNames`, `syncUrl`, `resumePathPrefix`, `routeReference`, `resumable`,
  `resumePaymentHash`, `metadata`, `createFetch`

There is no image prop. Everything the checkout draws ships inside the
JavaScript ([Provider registry](provider-registry.md#assets)).

`csrfHeader` (default `X-CSRF-Token`) is the header name used to send the page's
`<meta name="csrf-token">` value on every request. Rails and Laravel read the
default. Django reads `X-CSRFToken`. WordPress REST reads `X-WP-Nonce`. The meta
tag name is fixed.

`resumePaymentHash` (create mode) names a swap attempt this order already has in
progress. The checkout reopens it after prepare instead of showing the method
grid. A hash that cannot be served is ignored.

`resumable` says whether a payer who closes this tab has a URL that brings them
back. It is inferred from `syncUrl` / `routeReference`. Set it explicitly when
your own router owns a per-order route. It picks which return warning the swap
refund screen shows (`SwapDisplayModel.refundReturnLabel`). See
[Checkout UX → The refund screens](checkout-ux.md#the-refund-screens).

Some props are shared with the Vue, Svelte and Angular wrappers, with the same
names and defaults. These are everything in the list above up to and including
`csrfHeader`, except `theme`, plus `checkout` and `reference`.

- `theme` is a React-only prop. The custom element carries the same lock as its
  `theme` attribute.
- `components`, `classNames`, `children` and `createFetch` are React-only, with
  no wrapper equivalent.
- `polling` / `pollIntervalMs` reach the wrappers only through their `options`
  escape hatch.

[docs/internal/wrapper-parity.md](../internal/wrapper-parity.md) has the full table.

`children` is React-only. It is a node, or a render prop that receives the live
`useCheckout` model. Use it for order context, such as a line-item summary, a
thumbnail, or a "you are buying" strip. The checkout shows the amount but never
the order, so without it that context is missing. Children appear above the
shipped payment UI, where the custom element's `order` slot sits, and never
replace it.
See [Frontend checkout → Show the payer what they are buying](frontend-checkout.md#show-the-payer-what-they-are-buying).

### useCheckout

From `@openreceive/react`: `useCheckout(options)`. The hook behind `<Checkout>`,
for custom layouts. It drives a concrete `checkout` snapshot. Create mode belongs
to `<Checkout>`. Unlike the component, it does **not** default `prefix`. Pass
`prefix` to poll `/payments/check`. Omit it, or pass `polling: false`, to render
the snapshot without polling. It returns the live snapshot, `status`, countdown
labels, `statusTitle`/`statusDetail`, and
`copyInvoice`/`openWallet`/`reloadState`/`retry`/`cancel`.

`openWallet` is for **touch devices**. By default it calls `location.assign` on
the current window. On desktop, a wallet button either does nothing or takes the
payer away from a checkout that is still polling. That is why `<Checkout>`
renders no wallet button and offers `components.OpenWalletButton` as an opt-in
slot. See
[Headless checkout](headless-checkout.md#the-openreceivebrowserheadless-surface).

### PaymentWizard

From `@openreceive/react`. The method picker and swap deposit flow shown inside
`<Checkout>`. You can use it on its own with `checkout`, `prefix`, and
`onSwapStarted`. If you omit `prefix`, it renders only the method grid, because
it has no swap backend to call.

### `<openreceive-checkout>`

From `@openreceive/elements`. The custom element behind the non-React wrappers.

- Create mode: `reference` + `prefix` attributes.
- Snapshot mode: `invoice`/`invoice-id`/`payment-hash`/... attributes.
- Polling: `polling="false"` renders without status polling.
  `poll-interval-ms` sets the interval.
- `csrf-header` names the header used to send the `csrf-token` meta value.
  Default `X-CSRF-Token`. Django uses `X-CSRFToken`, WordPress REST uses `X-WP-Nonce`.

There is no asset attribute. Everything the element draws ships inside its
JavaScript. It fires seven events: `openreceive-copy`,
`openreceive-open-wallet`, `openreceive-state`, `openreceive-settled`,
`openreceive-provider-copy`, `openreceive-start-over`, `openreceive-error`.

## CLI

### openreceive scaffold payments

```sh
npx openreceive scaffold payments [options]
```

Writes one schema or migration file for your ORM, plus an
`OPENRECEIVE_PAYMENTS.md` wiring guide. The file creates two tables:
`openreceive_payments` (the payment attempts) and `openreceive_meta` (the
reconcile gate). It does nothing else. It never opens a database connection or
runs migrations.

**Where it fits:** Run it once, at the start of the integration, from the
directory that holds your ORM's migrations. Then apply the migration the way you
apply your own. Commit the generated file. You will not run this again unless
you change table names.

Every generated file includes the note about fulfilling each order exactly once.

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
npx openreceive doctor --db db/production.sqlite3 --url http://localhost:3000
```

Checks the server configuration and says what to fix.

**Where it fits:** Run it first, before writing any code, on the machine the app
will run on, and again whenever a deploy misbehaves. Run it when the payment
page says the wallet is unavailable and you don't know why. Once the app is up,
add `--db` and `--url` to check the tables and the routes too.

It always checks:

- the Node version and working directory,
- whether `NWC_URI` is set and can be parsed (printed with secrets hidden), and
- the `LSC_URI_*` connections.

When `NWC_URI` parses, it also probes the wallet over the relay, the same
preflight that runs at boot. It reports whether the code is receive-only.
`--offline` skips the probe. No database is touched by default.

The exit code is `1` when any check fails. Every failing line states its own
fix. `openreceive debug-report` prints the same lines as a support report with
secrets hidden, and always exits `0`.

| Option | Meaning |
| --- | --- |
| `--db <target>` | Also checks that the payment tables exist. Takes a SQLite file path, or a `postgres://` / `mysql://` URL. The matching driver (`pg` / `mysql2`) is loaded from your project. |
| `--url <base-url>` | Also checks that the OpenReceive routes answer on a running app. An unknown path under the prefix must return the router's own JSON 404. |
| `--prefix <path>` | Route prefix for `--url` (default `/openreceive`). |
| `--table-name <name>`, `--meta-table-name <name>` | Table names for `--db`, when the scaffold was run with overrides. |
| `--offline` | Skip the wallet relay probe. |

## Rails

### openreceive:install

```sh
bin/rails generate openreceive:install
```

Creates three things:

- one migration, `db/migrate/*_create_openreceive_tables.rb`, which creates both
  `openreceive_payments` and the `openreceive_meta` reconcile gate,
- a simplified `config/initializers/openreceive.rb`, and
- the engine route mount at `/openreceive`.

**Where it fits:** Run it once right after adding the gem, then `bin/rails
db:migrate`. The rest of the integration goes in the files it creates. The three
hooks below go in the initializer, and the browser packages point their `prefix`
at the mount.

The migration adapts to the app's configured database adapter. PostgreSQL,
SQLite, and MySQL (`mysql2`/`trilogy`) are supported. The engine owns the
`OpenReceivePayment` model, so no model file is generated.

The generated initializer ships two placeholders:

- `config.on_paid = OpenReceive::LOGGING_ON_PAID` only logs and fulfills nothing.
- `config.authorize = OpenReceive::ALLOW_ALL_AUTHORIZE` allows every request.
  Anyone who has the reference is treated as authorized, which is safe only
  while references cannot be guessed.

The engine warns every time your application boots while either is still
configured. Replace both before anything real.

| Flag | Meaning |
| --- | --- |
| `--skip-migration` | Skip the migration (both tables). |
| `--skip-initializer` / `--skip-route` | Skip those files. |

### OpenReceive.configure

```ruby
OpenReceive.configure do |config| ... end
```

**Where it fits:** This lives in `config/initializers/openreceive.rb` and runs
at boot. It is the only place your application and OpenReceive meet. `authorize`
is your "is this their order?" check, `amount_for` is your price lookup, and
`on_paid` is where you mark the order paid. Everything else in the engine is
generic. These three hooks are the integration.

Three hooks are required: authorization, the trusted price, and fulfillment.
There are also a few optional settings.

```ruby
OpenReceive.configure do |config|
  # `Order` in these examples is YOUR model — any name works. OpenReceive
  # never sees it; these hooks are the only bridge into your data.

  # REQUIRED. Your policy, called before every checkout/payment/swap route.
  # `context` is a Hash with three symbol keys:
  #   context[:action]   — which route, as a String: "checkout.prepare",
  #                        "checkout.create", "payment.check", "swap.quote",
  #                        "swap.create", "swap.read", or "swap.refund"
  #   context[:request]  — the ActionDispatch::Request; read your session,
  #                        cookies, or headers from it, as in a controller
  #   context[:resource] — { reference: } on every action, plus
  #                        { payment_hash: } on payment.check, swap.read, and
  #                        swap.refund. Copied from the payer's JSON body
  #                        before any lookup: it names an order, it does NOT
  #                        prove this caller may touch it. reference is always
  #                        a validated non-empty String (≤200 chars);
  #                        payment_hash is nil on the other four actions.
  # Return true to allow, false for a 403. Look the order up in YOUR data and
  # decide whether THIS caller may perform THIS action on it.
  config.authorize = lambda do |context|
    order = Order.find_by(id: context[:resource][:reference])
    order && order.user_id == context[:request].session[:user_id]
  end

  # REQUIRED. The trusted price for a reference (your order id). Return
  # { currency: "USD", value: "12.00" } or { sats: 1200 } (string keys work
  # too), or nil when there is nothing to pay for (a 404). Called only where a
  # price is minted or quoted; payer input never carries an amount.
  #
  # An optional "description" beside the price is what the payer is buying, in
  # your own words: one display string, echoed on the prepare and create
  # responses, rendered above the amount by both drop-ins, and used as the
  # invoice memo so the payer's wallet shows it too. The checkout shows a total
  # and never an order, so without it the payer sees a QR and a number.
  config.amount_for = lambda do |reference|
    order = Order.find_by(id: reference)
    order && { currency: "USD", value: order.total.to_s,
               description: "#{order.line_items.size} items" }
  end

  # REQUIRED. Fulfillment. Runs inside the settlement transaction, only for
  # the first settled attempt for a reference. `settlement` responds to:
  #   settlement.reference    — your order id that just settled (String)
  #   settlement.payment_hash — 64-char lowercase hex hash of the attempt
  #   settlement.paid_at      — Unix seconds of settlement (Integer)
  #   settlement.details      — wallet-observed details Hash (transaction
  #                             snapshot, observed_at, paid_at_source — the
  #                             same shape JS delivers to onPaid), or nil
  # There is deliberately no `query` handle here: the engine wraps this block
  # in an ActiveRecord transaction, so plain ActiveRecord IS the transactional
  # write. (The JS engine hands `onPaid` a `query` because nothing wraps it
  # there.) Same rule as JS otherwise: database writes only — anything
  # reaching outside the transaction survives a rollback and runs again.
  # The WHERE clause is the lock: a second fulfillment path of yours (admin
  # action, replayed job) claims zero rows and does nothing.
  config.on_paid = lambda do |settlement|
    claimed = Order
                .where(id: settlement.reference, state: "awaiting_payment")
                .update_all(state: "paid", paid_at: Time.at(settlement.paid_at).utc)
    next if claimed.zero? # someone else already fulfilled it
  end

  # Per-IP invoice cap for public web shops. Off by default — never throttle
  # a shared-IP POS terminal by accident. `true` caps invoice creation at 60
  # per client IP per rolling hour, counted from the engine-owned
  # openreceive_payments rows. See Rate limiting.
  # config.rate_limiting = true
  # config.rate_limiting = { limit_per_hour: 60, limit_per_day: 300 }

  # OR a custom rate-limit hook — receives the same `context` Hash as
  # config.authorize; return false (or raise the engine's rate-limited error)
  # for a 429. Mutually exclusive with config.rate_limiting.
  # config.rate_limit = ->(context) { MyLimiter.allow?(context[:request].ip) }

  # Client-IP extractor for rate limiting and attempt-row stamping. Default:
  # ActionDispatch::Request#ip, which honors Rails' trusted-proxy
  # configuration.
  # config.client_ip = ->(request) { request.headers["CF-Connecting-IP"] }

  # Request-path settlement pass on every engine PAYMENT route (unauthenticated
  # GET /rates never triggers it), ON by default through the durable
  # openreceive_meta gate shared by all Puma workers. Set false when a
  # dedicated worker owns scanning (required with a custom repository).
  # config.opportunistic_reconcile = false
  # config.opportunistic_reconcile = { min_interval_seconds: 10 }

  # Your application otherwise refuses to start on a spend-capable NWC code
  # (also OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC=true).
  # config.allow_spend_capable_wallet = true

  # Eager production boot preflight, ON by default: the wallet is built and
  # checked at boot so a bad NWC_URI stops the deploy, not the first customer.
  # `rails assets:precompile` is detected and skipped automatically (see
  # Deploying); set false for any other boot that must come up with no wallet
  # secrets. It disables the BOOT check only — the wallet is still checked on
  # the first request.
  # config.eager_preflight = false
end
```

`on_paid` runs inside the settlement transaction through the engine's
write-once `mark_paid_once!`. It runs only for the first settled attempt for a
reference. Delivery is at-least-once, so a raise rolls back and the next pass
retries. Applications with a custom repository can use the advanced hooks
`resolve_checkout` and `on_checkout_created`.

### OpenReceive::ReconcileJob

```ruby
OpenReceive::ReconcileJob.perform_later
```

One reconciliation pass, wrapped for your ActiveJob backend. It runs once.

**Where it fits:** Enqueue it from your own code when you want a scan soon but
not inside the request. For example, after a support agent presses "re-check
payment", or from a scheduler if you run one. It is a convenience around
`OpenReceive.reconcile!`, not something the engine requires.

You do not need to schedule it. By default, settlement is driven by the
opportunistic reconcile that runs on requests.

### rake openreceive:doctor

```sh
bin/rails openreceive:doctor
```

Step 0 of the agent directions, as one command.

**Where it fits:** Run it first, before touching the initializer, and again
after every deploy or credential change. It tells you which of the three hooks
are still placeholders and whether the wallet answers. It never prints a
secret, so its output is safe to paste into an issue.

It reports whether each credential (`NWC_URI`, `LSC_URI_*`) is PRESENT. Every
line is `set` or `unset`. No secret value is ever printed, echoed, or partly
shown. That is what makes it safe to run in a shared terminal or paste into an
issue. It also reports:

- whether `OpenReceive.configure` ran,
- which of the three hooks are missing or still the generated placeholders
  (`LOGGING_ON_PAID`, `ALLOW_ALL_AUTHORIZE`),
- where the engine is mounted, and
- a best-effort wallet preflight. This is the same eager check a production
  boot runs, but it reports the result with secrets removed instead of raising.

Outside Rails, the Node CLI's `npx openreceive doctor` does the same job.

### rake openreceive:reconcile

```sh
bin/rails openreceive:reconcile
```

The same single pass as a rake task. It runs once and prints the number of
attempts scanned.

**Where it fits:** Use it from a cron entry, a console, or a runbook when you
want to force a scan now. For example, after a wallet outage, or while finding
out why an order is still unpaid. Day to day, the pass that runs on requests
does this for you.

### rake openreceive:notifications

```sh
bin/rails openreceive:notifications
```

The one documented worker. It is a long-running, opt-in NWC-02 listener built on
[OpenReceive.listen_for_notifications!](#openreceivelisten_for_notifications),
and it retries with backoff. It also reconciles on a timer
(`OPENRECEIVE_NOTIFICATIONS_RECONCILE_INTERVAL_SECONDS`, default 15). That timer
is its own safety net for notifications missed while it was down.

**Where it fits:** Run it as its own long-running process, for example a
`worker` line in your Procfile, when you want orders marked paid the moment the
wallet sees the payment. Without it, the app still settles every order, just on
the payer's next status poll.

### OpenReceive.reconcile!

```ruby
OpenReceive.reconcile!(overlap_seconds: 60, now: nil, max_pages: nil, deadline: nil) # => Array<Hash>
```

**Where it fits:** Call it from your own job, script, or console when you want
one pass now and want the results back in Ruby, for example to show them in an
admin view. The rake task and the job above are thin wrappers around it.

**Parameters**

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `overlap_seconds` | Integer | no | Scan-window overlap. Default 60. |
| `now` | Integer | no | Unix-seconds clock override. |
| `max_pages` | Integer | no | Cap on wallet-history pages walked. |
| `deadline` | Time | no | Wall-clock bound checked between page fetches. |

**Returns** the check result for each hash in the pass: an array of
`{ "payment_hash", "status", "paid_at"?, "details"? }` hashes. It returns `[]`
when the ledger has no `pending` attempts.

It runs one bounded pass over the ledger the engine owns:

1. Scans the wallet for the oldest `OpenReceive::Server::RECONCILE_BATCH_SIZE`
   (200) `pending` attempts.
2. Delivers settlements through the write-once settlement hook.
3. Saves final state changes.

`max_pages:` caps the wallet-history pages walked. `deadline:` is a wall-clock
limit the scan checks between page fetches. A pass that runs out of time simply
stops walking. A hash the scan never reached stays untouched. Closing an attempt
requires a successful scan at or after expiry plus the 900-second grace. The
local clock alone never closes it. A wallet failure raises and leaves every row
pending.

### OpenReceive.maybe_reconcile!

```ruby
OpenReceive.maybe_reconcile!(now: nil) # => Hash
```

The gated pass behind the engine's opportunistic reconcile on requests. The
engine runs it as an `around_action` on its controllers, with exactly one gate
claim per request. It is exported for your own routes and middleware, which
never run it automatically. Rack applications call it themselves.

**Where it fits:** Add it to a controller action of your own that a waiting
payer polls, such as an order-status endpoint, so settlement gets a chance to
run there too. It is safe to call on every request. It returns at once when
nothing is pending or another worker just scanned.

It never raises. A failed or timed-out scan warns and returns `scan_failed`. The
gate stays claimed, so a broken wallet cannot trigger a flood of retries. It
returns `{ "reason" => "ran", "checks" => [...] }` (the check hash for each
payment hash) or
`{ "reason" => "disabled" | "no_pending" | "gate_busy" | "scan_failed" }`.

### OpenReceive.listen_for_notifications!

```ruby
OpenReceive.listen_for_notifications!(overlap_seconds: 60)
```

Subscribes to the configured NWC client's `payment_received` notifications.

**Where it fits:** You'll only call this yourself when writing your own worker
instead of `rake openreceive:notifications`, for instance to run it under your
own supervisor with your own logging. It blocks, so it belongs in a dedicated
process, never in a request or a job with a timeout.

It settles directly the same way the Node listener does. If a payload meets the
shared settlement rule and matches a pending attempt, it settles directly
through the engine's `mark_paid_once!`/`on_paid` path, with no wallet scan for
that invoice. Anything less falls back to one `OpenReceive.reconcile!` pass.
That covers no sign that the payment is final, an unknown hash, or a failed
direct settlement. The worker's periodic pass is the safety net for
notifications missed while offline. It raises `OpenReceive::ConfigurationError`
when the client cannot send notifications. Blocking clients do not return until
the subscription ends.

The built-in `nwc-ruby` client is already wired up. `openreceive-rails` declares
it as a runtime dependency, so it is installed with the engine.
`OpenReceive::NwcRubyReceiveClient` forwards `subscribe_notifications` to that
gem's `subscribe_to_notifications`. It turns the notification object the gem
yields back into the NWC-02 wire payload. So the settlement rule reads
`state`/`settled_at` exactly as it does on a `list_transactions` row.

A custom `config.nwc_client` opts in by supplying
`subscribe_notifications(&block)`, which yields those wire payloads
(`notification_type` plus the transaction-shaped `notification`). The engine
filters for `payment_received` itself, so the client should forward every type
the wallet publishes.

## Python

The Python engine (`pip install openreceive`) is the same contract in
snake_case:

- the host is a `Host` dataclass,
- the entry point that knows about storage is an `OpenReceiveApp`, and
- the FastAPI binding is two functions on top of it.

Django apps use `openreceive.django`, which has its own quickstart. Flask apps
use the [recipe](../recipes/flask.md). Python APIs and the wire use the same
spelling (`payment_hash`, `amount_msats`). Money is `int` msats or decimal
strings.

### Host (Python)

```python
from openreceive.server import Host
host = Host(amount_for=..., authorize=..., on_paid=..., after_paid=None)
```

**Fields**

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `amount_for` | `(reference: str) -> dict \| None` | yes | Returns `{"currency": "USD", "value": "12.00", "description"?: str}` or `{"sats": 1200}` from YOUR data. `None` gives `404 Unknown reference.`. Called only where a price is minted or quoted (prepare, quote, create), never on status polls. |
| `authorize` | `(context: HookContext) -> bool` | yes | Receives `context.action` (`checkout.prepare`, `checkout.create`, `payment.check`, `swap.quote`, `swap.create`, `swap.read`, `swap.refund`) and `context.request`, the FRAMEWORK request: the Starlette `Request` on FastAPI, or the `HttpRequest` without a framework. Also `context.resource` (`{"reference", "payment_hash"?}`), which is a claim the payer sent. Return `False` for a `403`. |
| `on_paid` | `(settlement: PaymentSettlement) -> None` | yes | Runs INSIDE the settlement transaction, only for the reference's first settled attempt. Gets `settlement.reference`, `.payment_hash`, `.paid_at`, `.details`, and `.connection`. `.connection` is the SQLAlchemy `Connection` of that transaction. It is `None` under the Django ORM, where the transaction is already active around your code. Database writes only. |
| `after_paid` | `(settlement) -> None` | no | Runs after COMMIT. Use it for emails, jobs, and pushes. |

`LOGGING_ON_PAID` and `ALLOW_ALL_AUTHORIZE` are the two named placeholders.
The engine warns at boot while either is in use, and `openreceive doctor`
names them.

### openreceive_router

```python
from openreceive.fastapi import openreceive_router
app.include_router(openreceive_router(host, engine=engine, rate_limiting=True), prefix="/openreceive")
```

An `APIRouter` that serves every route in the OpenAPI contract through the
framework-free engine. The endpoint is a sync `def` run in Starlette's
threadpool. The engine's own checks are unchanged: 404/405, the JSON-only rule,
the `Sec-Fetch-Site: cross-site` refusal, the declared-fields check, and the
64 KB body cap. The mount prefix is whatever `include_router` was given.

**Parameters**

| Name | Type | Required | Meaning |
| --- | --- | --- | --- |
| `host` | `Host` | yes | The three hooks. |
| `engine` | `sqlalchemy.Engine` | one of | OpenReceive's own sync Engine for its two tables, on the same database as your app. On SQLite, use a dedicated Engine. The repository configures it so writes happen one at a time. |
| `repository` | `PaymentRepository` | one of | A custom repository instead of `engine` ([Storage: the escape hatch](storage.md#escape-hatch)). Without `claim_reconcile_gate`, you must set `opportunistic_reconcile=False`. |
| `rate_limiting` | `bool \| {"limit_per_hour", "limit_per_day"}` | no | The built-in per-IP invoice cap. Off by default. `True` = 60/hour. It counts by `request.client.host`, so behind a proxy, run uvicorn with `--proxy-headers`. Cannot be used with `rate_limit`. |
| `rate_limit` | `(HookContext) -> bool` | no | Your own limiter. Return `False` for a `429`. |
| `client_ip` | `(Request) -> str \| None` | no | A different way to find the client IP than `request.client.host`. |
| `opportunistic_reconcile` | `bool \| {"min_interval_seconds"}` | no | The settlement pass that runs on requests, through the durable `openreceive_meta` gate. On by default. |
| `nwc_client`, `price_provider`, `swap_providers`, `price_currencies`, `env`, `allow_spend_capable_wallet` | | no | The parts of `Service` you can replace. By default the wallet client comes from `NWC_URI`, the providers from `LSC_URI_*`, and the price feed is the cached live feed. Tests pass the `openreceive.testing` fakes here ([Host testing](host-testing.md)). |
| `table_name`, `meta_table_name` | `str` | no | Table names, when the scaffold ran with overrides. |
| `report_unexpected_error` | `(error, request_id) -> None` | no | Where to send an exception that became an opaque 500, such as Sentry or `logger.exception`. |

The returned router carries `.openreceive`, the binding behind it. The CLI's
`--app` accepts the router, the FastAPI app, or an `OpenReceiveApp`.

### openreceive_lifespan

```python
app = FastAPI(lifespan=openreceive_lifespan(host, engine=engine, lazy=False))
```

Runs the receive-only wallet preflight when the server starts. Passing the same
`host` + `engine=` as the router gives the same binding. You can also pass the
router itself. On failure it raises `ConfigurationError` so uvicorn exits. A
missing `NWC_URI`, an unreachable relay, or a spend-capable code stops the
deploy. `lazy=True` delays the check to the first request, which answers
`503 WALLET_UNAVAILABLE` until the check passes. Startup also sets
`app.state.openreceive`. Shutdown closes the wallet client the binding built.

### OpenReceiveApp (Python)

```python
from openreceive.server import OpenReceiveApp, Service
app = OpenReceiveApp(service=service, host=host, repository=repository, prefix="/openreceive", rate_limiting=False, opportunistic_reconcile=True)
status, body, headers = app.handle(HttpRequest(method=..., path=..., headers=..., body=...))
checks = app.reconcile(overlap_seconds=60)      # one bounded pass; the `openreceive reconcile` verb
app.maybe_reconcile()                           # the gated request-path pass: {"reason": "ran" | "disabled" | "no_pending" | "gate_busy" | "scan_failed"}
```

The framework-free engine, with storage, that the FastAPI router, the Django
views and the Flask recipe mount.

- `Service(nwc_client, price_provider=…, swap_providers=…, price_currencies=…, env=…)`
  is the wallet, rates and swaps half. Its constructor IS the preflight, and it
  refuses to start on a bad setup.
- `repository` is `openreceive.storage.sql.SqlPaymentRepository(engine)` or the
  Django ORM repository.
- `app.reconciler` (`settle`, `handle_notification`, `attempt_status`) is what
  the notifications worker drives.

### payments_schema_sql (Python)

```python
from openreceive.storage.sql import payments_schema_sql, payments_ddl_statements
payments_schema_sql("postgres" | "sqlite" | "mysql", table_name="openreceive_payments", meta_table_name="openreceive_meta") -> str
```

The official DDL for both tables plus the `schema_version` seed row, as one
script. `payments_ddl_statements` returns the statements separately, which is
what the Alembic revision executes. The FastAPI demo runs it at boot if the
table does not exist yet. Production apps apply it once through their own
migration workflow.

### openreceive scaffold payments (Python)

```sh
openreceive scaffold payments --sql --dialect postgres|sqlite|mysql [--table-name …] [--meta-table-name …]
openreceive scaffold payments --alembic --dialect postgres [--out-dir alembic/versions] [--revision <12 hex>] [--down-revision <id>] [--force]
```

`--sql` prints the DDL to stdout, with the exactly-once fulfillment note as
comments.

`--alembic` writes `<revision>_openreceive_payments.py`. The DDL is fixed in
`op.execute` calls, and a `downgrade()` drops both tables. Set
`--down-revision` to your current head (`alembic heads`), or edit it in
afterwards. A revision with `down_revision = None` becomes a second base.

It never opens a database connection.

### openreceive doctor (Python)

```sh
openreceive doctor [--app module:attr] [--offline] [--db <sqlalchemy-url>] [--url http://localhost:8000] [--prefix /openreceive]
openreceive debug-report [...]     # the same lines, always exit 0
```

It checks:

- the Python version,
- whether `NWC_URI` is set and can be parsed (never printing the value),
- the `LSC_URI_*` connections,
- the receive-only relay probe (`--offline` skips it), and
- whether both tables exist (`assert_supported_schema`) and which hooks are
  still placeholders.

For the last check it needs your app. Pass `--app` with the FastAPI app, the
router from `openreceive_router`, an `OpenReceiveApp`, or a zero-argument
callable that returns one. Without `--app`, `DJANGO_SETTINGS_MODULE` selects the
Django app.

`--db` checks the tables at any SQLAlchemy URL instead. `--url` proves the
routes answer under the prefix, by getting the engine's own JSON 404 on an
unknown path. The exit code is 1 if any line fails. Every failing line states
its fix.

### openreceive reconcile / openreceive notifications

```sh
openreceive reconcile --app main:app [--overlap-seconds 60]
openreceive notifications --app main:app [--interval-seconds 15]
```

`reconcile` runs one bounded pass over the pending attempts and prints how many
ended in each status. It matches `rake openreceive:reconcile`. Use it in a
runbook or from cron. The pass that runs on requests covers day-to-day
settlement.

`notifications` is the one documented worker. It is a long-lived NWC-02
`payment_received` listener that retries with backoff. It also runs the periodic
pass (`OPENRECEIVE_NOTIFICATIONS_RECONCILE_INTERVAL_SECONDS`, default 15) as the
safety net for notifications missed while it was down. Run one, as its own
process. Without it, every order still settles on the payer's next poll.

In Django, the commands are `manage.py openreceive_reconcile` /
`openreceive_notifications`.

## PHP

The Composer package `openreceive/openreceive` (namespace `OpenReceive\`) is for
a plain-PHP app. The Laravel adapter (`openreceive/laravel`) wraps the same
classes. It requires PHP ≥ 8.2, 64-bit, and `ext-gmp`. Public arrays use the
wire's snake_case keys. Methods are camelCase. Money is integer msats or decimal
strings, never a float. The package's own static analysis forbids floats in the
money path.

### OpenReceive\Host

```php
interface Host {
    public function authorize(AuthorizeContext $context): bool;
    public function amountFor(string $reference): ?array;   // ['currency' => 'USD', 'value' => '12.00', 'description' => ?] or ['sats' => 1200]; null = 404
    public function onPaid(PaymentSettlement $settlement): void;
}
```

The host contract: one object with three methods. It is the only bridge between
the engine and your data. **Where it fits:** it is the first thing `Engine`
takes, and it is the whole quickstart.

- `authorize` runs on every mounted route.
- `amountFor` runs only where a price is minted or quoted. Payer input never
  carries an amount.
- `onPaid` runs inside the settlement transaction, for the first settled attempt
  of a reference.

Also implement `OpenReceive\Hosts\AfterPaid` when something must run after
COMMIT, such as an email or a webhook. It is best-effort and never retried.

Two placeholder traits exist for scaffolding: `Hosts\AllowAllAuthorize`
(allows everything) and `Hosts\LoggingOnPaid` (logs and fulfills nothing).
`Engine` warns through its logger at construction while a host uses either,
and `Doctor` names them. Replace both before anything real.

**Fields of** `PaymentSettlement` (readonly):

- `reference`
- `paymentHash`
- `paidAt` (Unix seconds)
- `details`: the transaction snapshot the wallet observed, `observed_at`, and
  `paid_at_source`, or null
- `connection`: the `DatabaseConnection` of the settlement transaction
  (`execute()` / `query()` with positional `?` placeholders). It is null in
  `afterPaid`.

### The authorize context (PHP)

`OpenReceive\Server\AuthorizeContext` is readonly. It has:

- `action`: `checkout.prepare`, `checkout.create`, `payment.check`,
  `swap.quote`, `swap.create`, `swap.read`, or `swap.refund`.
- `request`: the PSR-7 `ServerRequestInterface` on the plain mount. Laravel
  passes its own request object.
- `resource`: `['reference' => …, 'payment_hash' => ?]`, copied from the payer's
  JSON body before any lookup. It is a claim, not proof.
- helpers `reference()` and `paymentHash()`. `paymentHash()` is null except on
  `payment.check`, `swap.read`, and `swap.refund`.

A custom `rateLimit` hook receives the same object.

### OpenReceive\Server\Service

```php
$service = Service::fromEnvironment();   // NWC_URI, LSC_URI_PRIMARY/BACKUP, OPENRECEIVE_* from getenv() + $_ENV
$service = new Service($nwcClient, $priceProvider, $swapProviders, ['USD'], $clock, $allowSpendCapableWallet, $env, $logger, $http);
```

The checkout service, which works with any storage. It covers prepare and
create, the bounded wallet reconcile pass, swap quote/create/get/refund, rates,
and the receive-only preflight at boot.

The preflight runs in the constructor. It **fails closed**, refusing to start,
when:

- `NWC_URI` is missing or invalid,
- the wallet lacks `make_invoice` or `list_transactions`,
- there is no shared encryption mode, or
- the wallet advertises a spend method.
  `OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC=true` or `$allowSpendCapableWallet`
  relaxes only this last check.

`fromEnvironment(?array $env, array $priceCurrencies,
PriceProvider|false|null $priceProvider, ?array $swapProviders, bool
$allowSpendCapableWallet, ?LoggerInterface $logger, ?HttpTransport $http)`:

- Pass `$env` explicitly when the framework caches configuration.
- Pass `false` for no rates.
- Pass `[]` for no swaps.

The direct API is `prepareCheckout()`, `createCheckout()`, `reconcilePayments()`,
`quoteSwap()`, `createSwap()`, `getSwap()`, `refundSwap()`, `listRates()`,
`listSwapOptions()` and `subscribeNotifications()`. It takes and returns
snake_case arrays. Errors are `OpenReceive\Server\Errors\*`, extending
`HttpError` (`status`, `errorCode`, `retryable`, `details`, `retryAfterSeconds`).

### OpenReceive\Server\Engine

```php
$engine = new Engine(
    $host, $repository, $service,
    opportunisticReconcile: true,          // false when a worker owns scanning; ['min_interval_seconds' => n]
    rateLimiting: false,                   // true = 60/hour per IP; ['limit_per_hour' => , 'limit_per_day' => ]
    rateLimit: null,                       // custom fn (AuthorizeContext): bool — exclusive with rateLimiting
    clientIp: null,                        // fn (mixed $request): ?string; default REMOTE_ADDR of the PSR-7 request
    logger: null,                          // any PSR-3 logger
    prefix: '/openreceive',
    responseFactory: null,                 // a PSR-17 ResponseFactoryInterface; nyholm/psr7 is auto-discovered
);
```

The quickstart's way of putting the parts together. It matches Rails'
`Configuration`. It takes a `Host`, a `PaymentRepository` and a `Service`, and
from them gives you:

- the request handler,
- the PSR-15 mount, with opportunistic reconcile on requests,
- the settlement hook,
- the reconciler,
- the notifications worker, and
- the doctor.

In plain PHP, build one per request, since each request is its own process.
Under a framework, bind one in the container.

| Method | Returns |
| --- | --- |
| `psr15Handler()` | `Psr\Http\Server\RequestHandlerInterface`: the mount. Every payment route first runs the gated reconcile pass. `payments/check` is served from that pass or from the stored row. |
| `requestHandler()` | The framework-free `RequestHandler` (request → `[status, headers, body]` triples), for an app that cannot use PSR-15. |
| `reconcile()` | One bounded reconciliation pass. Returns a `list` of results, one per attempt. This is the `openreceive:reconcile` one-shot. |
| `maybeReconcile()` | The gated pass, for your own routes: `['reason' => 'ran'\|…, 'checks' => ?]` |
| `notificationsWorker(?array $env)` | `Notifications`. `->run(?callable $shouldContinue)` blocks. It runs the NWC-02 listener plus the periodic pass (`OPENRECEIVE_NOTIFICATIONS_RECONCILE_INTERVAL_SECONDS`, default 15). |
| `doctor(?array $env, ?callable $walletCheck, ?string $mountedAt)` | The Step 0 report lines (below). |
| `settle(array $event)` | The settlement hook: write-once, then `onPaid` inside the transaction, then `afterPaid` after commit. Returns `true` when this call fulfilled the order. |

Behind a reverse proxy, pass `clientIp: fn ($request) => $request->getHeaderLine('x-forwarded-for')`
(or your framework's trusted-proxy answer). That way the per-IP cap counts the payer.

### Engine notificationsWorker

```php
$engine->notificationsWorker()->run();   // blocks; ->stop() ends it
```

The one documented worker. It is a long-lived NWC-02 `payment_received` listener
that retries with backoff. It also runs a periodic reconcile pass as its own
safety net. PHP has no threads, so the periodic pass runs when the blocking
subscription is idle, once a second. Run it as its own process. Without it,
every order still settles on the payer's next poll.

A `payment_received` payload that meets the settlement rule settles the matching
pending attempt directly. Anything less falls back to one bounded reconcile pass.

### OpenReceive\Storage

```php
$db = new PdoConnection($pdo);                       // dialect from PDO::ATTR_DRIVER_NAME: pgsql | mysql | sqlite
$repository = new SqlPaymentRepository($db);         // (?callable $clock, string $table, string $metaTable)
PaymentsSchema::statements($dialect);                // list<string> DDL: openreceive_payments + openreceive_meta
PaymentsSchema::dropStatements();                    // the down()
PaymentsSchema::migrate($db);                        // both, in one call
```

`PdoConnection` wraps the PDO your app already opens. It sets
`ERRMODE_EXCEPTION`, and sets the SQLite busy timeout through `PDO::ATTR_TIMEOUT`.

An app with no PDO implements `DatabaseConnection` instead, as the WordPress
plugin does. It has `dialect()`, `query()`, `execute()`, `transaction()`,
`lastInsertId()`, and positional `?` placeholders.

`SqlPaymentRepository` is responsible for the per-reference commit lock in each
dialect, write-once settlement, the reconciliation transitions, and the
`openreceive_meta` compare-and-swap (CAS) gate. It never selects `swap_data`
into a public array.

As an escape hatch, you can implement `PaymentRepository` yourself. Then set
`opportunisticReconcile: false`, unless you also implement `claimReconcileGate`
and `checkpointReconcileGate`.

### OpenReceive\Server\Doctor

```php
Doctor::report(array $env, ?Host $host, ?callable $walletCheck, ?string $mountedAt): array   // list<string>
Doctor::placeholderWarnings(Host $host): array
```

Step 0 of the agent directions, as report lines. It reports:

- each credential as set or unset, never its value,
- the host class, and whether `authorize`/`onPaid` are still the placeholder traits,
- where the handler is mounted, and
- the wallet preflight. `$walletCheck` is a closure that builds the `Service`.
  If it throws, the error is reported, never raised.

`$engine->doctor()` does the same for a built engine. The output is safe to
paste into an issue.

### OpenReceive\Testing

`FakeWallet` (a `ReceiveNwcClient`) and `FakeSwapProvider` (a `SwapProvider`),
built on the [testkit contract](../internal/testkit-contract.md), plus
`Rates\StaticPriceProvider`. See [Testing your integration](host-testing.md#inject-a-fake-wallet-client-php).

