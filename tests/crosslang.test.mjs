import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  classifyTransactionSettlement,
  NwcUriParseError,
  parseNwcUri,
  quoteFiatToMsatsWithPrice,
  reconcilePaymentAttempts,
} from "@openreceive/core";
import { isValidAddressForSwapNetwork } from "@openreceive/core/swap-address";
import { normalizeNwcWalletError } from "../packages/js/node/src/index.ts";
import {
  normalizeListTransactionsResult,
  normalizeMakeInvoiceResult,
  summarizeWalletCapabilities,
  toNip47ListTransactionsParams,
  toNip47MakeInvoiceParams,
} from "../packages/js/node/src/nwc/normalize.ts";

// The JS twin of tools/conformance/ruby-crosslang.rb. Every shared vector
// family is fed into the REAL production functions here, not a re-implementation
// in the validator, so drift between the two engines fails on both sides.
const vector = (name) => JSON.parse(readFileSync(`spec/test-vectors/${name}.json`, "utf8"));

// The vectors carry wire-shaped msats; the JS request builder takes bigint.
const connectionFixture = parseNwcUri(
  `nostr+walletconnect://${"a".repeat(64)}?relay=wss%3A%2F%2Frelay.example.com&secret=${"b".repeat(64)}`,
);

// The JS client carries msats as bigint internally; the vectors are wire-shaped
// (JSON numbers, all inside the 2^53-1 contract bound). Compare by value.
function wireValue(value) {
  return typeof value === "bigint" ? Number(value) : value;
}

function toMakeInvoiceRequest(request) {
  return {
    ...request,
    ...(request.amount_msats === undefined ? {} : { amount_msats: BigInt(request.amount_msats) }),
  };
}

test("fiat-to-msats vectors price through the production quote", () => {
  const family = vector("fiat-to-msats.usd");
  for (const item of family.cases) {
    const quote = quoteFiatToMsatsWithPrice({
      fiat: { currency: item.fiat.currency, value: item.fiat.value },
      btcFiatPrice: family.btc_fiat_price,
      source: family.source,
      asOf: 0,
    });
    assert.equal(quote.amountSats, item.expected.amount_sats, item.name);
    assert.equal(quote.amountMsats, item.expected.amount_msats, item.name);
  }
  // Quotes both engines must refuse: zero, negative, and overflow-via-fiat.
  for (const item of family.invalid_cases ?? []) {
    assert.throws(
      () =>
        quoteFiatToMsatsWithPrice({
          fiat: { currency: item.fiat.currency, value: item.fiat.value },
          btcFiatPrice: family.btc_fiat_price,
          source: family.source,
          asOf: 0,
        }),
      item.name,
    );
  }
});

test("settlement-detection vectors classify through the production rule", () => {
  for (const item of vector("settlement-detection").cases) {
    const detection = classifyTransactionSettlement(item.transaction);
    assert.equal(detection.status === "settled", item.expected.settled, item.name);
    if (item.expected.status !== undefined) {
      assert.equal(detection.status, item.expected.status, item.name);
    }
  }
});

test("nwc-uri-parse vectors parse through the production parser", () => {
  for (const item of vector("nwc-uri-parse").cases) {
    if (item.expected_error !== undefined) {
      assert.throws(
        () => parseNwcUri(item.uri),
        (error) => {
          assert.ok(error instanceof NwcUriParseError, item.name);
          assert.equal(error.code, item.expected_error, item.name);
          return true;
        },
        item.name,
      );
      continue;
    }
    const parsed = parseNwcUri(item.uri);
    const expected = item.expected;
    assert.equal(parsed.walletPubkey, expected.wallet_pubkey, `${item.name}: wallet_pubkey`);
    assert.deepEqual([...parsed.relays], expected.relays, `${item.name}: relays`);
    assert.equal(
      parsed.clientSecret !== undefined && parsed.clientSecret.length > 0,
      expected.secret_present,
      `${item.name}: secret_present`,
    );
    if (expected.lud16 !== undefined) {
      assert.equal(parsed.lud16 ?? null, expected.lud16, `${item.name}: lud16`);
    }
    if (expected.redacted !== undefined) {
      assert.equal(parsed.redacted, expected.redacted, `${item.name}: redacted`);
    }
  }
});

test("nwc-request-response vectors map through the production request builders", () => {
  for (const item of vector("nwc-request-response").cases) {
    if (item.method === "make_invoice") {
      const request = toNip47MakeInvoiceParams(toMakeInvoiceRequest(item.openreceive_request));
      assert.deepEqual(
        Object.fromEntries(Object.entries(request).map(([key, value]) => [key, wireValue(value)])),
        item.expected_nip47_request,
        `${item.name}: request`,
      );
      if (item.expected_openreceive_response !== undefined) {
        const normalized = normalizeMakeInvoiceResult(item.raw_response);
        for (const [key, value] of Object.entries(item.expected_openreceive_response)) {
          assert.deepEqual(wireValue(normalized[key]), value, `${item.name}: ${key}`);
        }
      }
      continue;
    }
    const request = toNip47ListTransactionsParams(item.openreceive_request);
    assert.deepEqual(request, item.expected_nip47_request, `${item.name}: request`);
    if (item.expected_openreceive_response !== undefined) {
      const normalized = normalizeListTransactionsResult(item.raw_response);
      const expected = item.expected_openreceive_response.transactions;
      assert.equal(normalized.transactions.length, expected.length, `${item.name}: row count`);
      expected.forEach((row, index) => {
        for (const [key, value] of Object.entries(row)) {
          assert.deepEqual(
            wireValue(normalized.transactions[index][key]),
            value,
            `${item.name}: row ${index} ${key}`,
          );
        }
      });
    }
  }
});

test("nwc-info vectors summarize through the production preflight summary", () => {
  for (const item of vector("nwc-info").cases) {
    // The production summary reads the connection for its relay list; the
    // vector only exercises the info payload, so a fixed connection is used.
    const summary = summarizeWalletCapabilities(connectionFixture, item.raw_info);
    const expected = item.expected;
    assert.deepEqual(summary.methods, expected.methods, `${item.name}: methods`);
    assert.equal(summary.encryption, expected.encryption, `${item.name}: encryption`);
    assert.equal(
      summary.spendCapabilityAdvertised,
      expected.spend_capability_advertised,
      `${item.name}: spend`,
    );
    assert.equal(
      summary.receiveCheckoutReady,
      expected.receive_checkout_ready,
      `${item.name}: receive`,
    );
    // Same extraction the Ruby harness uses: the warned method is quoted.
    const warned = summary.warnings.flatMap((warning) => {
      const match = /'([^']+)'/.exec(warning);
      return match === null ? [] : [match[1]];
    });
    assert.deepEqual(warned, expected.warning_methods, `${item.name}: warnings`);
  }
});

test("error-normalization vectors normalize through the production wallet mapper", () => {
  for (const item of vector("error-normalization").cases) {
    const normalized = normalizeNwcWalletError(item.raw_error);
    const expected = item.expected;
    assert.equal(normalized.code, expected.code, `${item.name}: code`);
    assert.equal(normalized.retryable, expected.retryable, `${item.name}: retryable`);
    if (expected.message !== undefined) {
      assert.equal(normalized.message, expected.message, `${item.name}: message`);
    }
  }
});

test("swap-address vectors validate through the production checksum rules", () => {
  for (const item of vector("swap-address").cases) {
    assert.equal(
      isValidAddressForSwapNetwork(item.network, item.address),
      item.expected.valid,
      item.name,
    );
  }
});

test("wallet-scan-truncation vectors reconcile through the production walk", async () => {
  // A walk cut short (page cap or an offset-ignoring wallet) must OMIT
  // unmatched hashes instead of reporting not_found — closing a paid attempt
  // a truncated scan never saw loses money. Mirrored by the same-named check
  // in tools/conformance/ruby-crosslang.rb; both engines expand filler rows
  // identically.
  const family = vector("wallet-scan-truncation");
  const pageLimit = family.page_limit;
  const fillerRow = (page, index) => ({
    type: "incoming",
    payment_hash: "f".repeat(56) + String(page * 10_000 + index).padStart(8, "0"),
    amount_msats: 1000,
    transaction_state: "settled",
    created_at: 1000,
    settled_at: 1100,
  });
  const buildPages = (specs) =>
    (specs ?? []).map((spec, page) => [
      ...(spec.rows ?? []),
      ...Array.from({ length: spec.filler_rows ?? 0 }, (_, index) => fillerRow(page, index)),
    ]);
  for (const item of family.cases) {
    const pages = buildPages(item.wallet.pages);
    const unpaidPages =
      item.wallet.unpaid_pages === undefined ? pages : buildPages(item.wallet.unpaid_pages);
    const client = {
      listTransactions: async (request) => {
        const source = request.unpaid === true ? unpaidPages : pages;
        const index =
          item.wallet.ignores_offset === true ? 0 : Math.floor((request.offset ?? 0) / pageLimit);
        return { transactions: source[index] ?? [] };
      },
    };
    const results = await reconcilePaymentAttempts({
      client,
      attempts: item.attempts.map((attempt) => ({
        paymentHash: attempt.payment_hash,
        createdAt: attempt.created_at,
      })),
      clock: () => item.clock,
      ...(item.max_pages === undefined ? {} : { maxPages: item.max_pages }),
    });
    const byHash = new Map(results.map((check) => [check.paymentHash, check.status]));
    for (const row of item.expected.results) {
      assert.equal(byHash.get(row.payment_hash), row.status, `${item.name}: ${row.payment_hash}`);
    }
    for (const hash of item.expected.omitted) {
      assert.ok(!byHash.has(hash), `${item.name}: ${hash} must be omitted`);
    }
    assert.equal(results.length, item.expected.results.length, `${item.name}: result count`);
  }
});

test("rate-limit-window pins the column both engines count on", () => {
  const family = vector("rate-limit-window");
  assert.equal(family.column, "inserted_at");
  const repository = readFileSync("packages/js/http/src/sql-payments.ts", "utf8");
  assert.match(
    repository,
    new RegExp(`WHERE client_ip = \\? AND ${family.column} >= \\?`),
    "the SQL repository must window the budget on the decided column",
  );
  for (const item of family.cases) {
    const counted = item.attempt[family.column] >= item.now - item.window_seconds;
    assert.equal(counted, item.expected.counted, item.name);
  }
});

test("a public swap body conforms to swap-order.schema.json", async () => {
  const Ajv2020 = (await import("ajv/dist/2020.js")).default;
  const { createOpenReceive } = await import("../packages/js/node/src/index.ts");
  const { createTestkitReceiveClient, createTestkitSwapProvider } = await import(
    "../packages/js/testkit/src/index.ts"
  );

  const openreceive = await createOpenReceive({
    client: createTestkitReceiveClient({ now: () => 1000 }),
    swap: { providers: [createTestkitSwapProvider({ now: () => 1000 })] },
    clock: () => 1000,
  });
  const swap = await openreceive.createSwap({
    orderId: "swap-schema",
    amount: { sats: 20_000 },
    payInAsset: "USDT_TRON",
  });
  await openreceive.close();

  // The wire body is the snake_case projection minus the server-only fields.
  const { checkout: _checkout, swapData: _swapData, ...publicSwap } = swap;
  const body = Object.fromEntries(
    Object.entries(publicSwap).map(([key, value]) => [
      key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      value,
    ]),
  );

  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(
    JSON.parse(readFileSync("spec/schemas/swap-order.schema.json", "utf8")),
  );
  assert.ok(
    validate(body),
    `public swap violates its schema: ${(validate.errors ?? [])
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ")}`,
  );
  // The provider credential must never be in a payer-facing body.
  assert.equal(body.provider_token, undefined);
});

test("provider-reported fee and refund detail reach the payer-facing swap body", async () => {
  const { createOpenReceive } = await import("../packages/js/node/src/index.ts");
  const { createTestkitReceiveClient } = await import("../packages/js/testkit/src/index.ts");

  // A provider that reports everything the deposit panel and the refund
  // messaging are built to render. Before these fields were emitted, that UI
  // could never fire against a spec-conformant server.
  const order = {
    provider: "stub",
    provider_order_id: "stub-order-1",
    provider_token: "server-only",
    pay_in_asset: "USDT_TRON",
    deposit_address: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf",
    deposit_amount: "12.5",
    expires_at: 1_500,
    state: "refund_required",
    attention: true,
    attention_reason: "provider_status_unrecognized",
    deposit_received_amount: "11.9",
    refund_reason: "less",
    refund_amount: "11.8",
    emergency_repeat: true,
    fee: { currency: "USD", pay_in_fiat: "12.60", payout_fiat: "12.40" },
  };
  const provider = {
    name: "stub",
    supportedPayInAssets: async () => new Set(["USDT_TRON"]),
    invoiceExpirySeconds: () => 600,
    quote: async () => ({ provider: "stub", pay_asset: "USDT_TRON", available: true }),
    createSwap: async () => order,
    getStatus: async () => order,
    requestRefund: async () => undefined,
  };

  const openreceive = await createOpenReceive({
    client: createTestkitReceiveClient({ now: () => 1000 }),
    swap: { providers: [provider] },
    clock: () => 1000,
  });
  const swap = await openreceive.createSwap({
    orderId: "swap-fee",
    amount: { sats: 20_000 },
    payInAsset: "USDT_TRON",
  });
  await openreceive.close();

  assert.deepEqual(swap.fee, order.fee);
  assert.equal(swap.providerOrderId, "stub-order-1");
  assert.equal(swap.attentionReason, "provider_status_unrecognized");
  assert.equal(swap.depositReceivedAmount, "11.9");
  assert.equal(swap.emergencyRepeat, true);
  // The credential stays in the server-only recovery blob, never on the body.
  assert.equal(swap.providerToken, undefined);
  assert.equal(swap.swapData.providerOrder.provider_token, "server-only");
});
