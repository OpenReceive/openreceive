import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryInvoiceStore,
  classifyLookupInvoiceSettlement,
  createIdempotencyRequestHash,
  getPollingDelaySeconds,
  parseNwcUri,
  pollInvoiceUntilFinalState,
  quoteFiatToMsats,
  redactNwcUri
} from "../../packages/js/core/src/index.ts";
import {
  copyInvoice,
  createLightningUri,
  createQrSvg,
  openWallet
} from "../../packages/js/browser/src/index.ts";

const PAYMENT_HASH =
  "a".repeat(64);
const NWC_URI =
  "nostr+walletconnect://" +
  "b".repeat(64) +
  "?relay=wss%3A%2F%2Frelay.example.com&secret=" +
  "c".repeat(64) +
  "&lud16=demo%40example.com";

test("quotes static USD fiat to whole-sat msats without floating point drift", () => {
  const quote = quoteFiatToMsats({
    fiat: {
      currency: "USD",
      value: "0.10"
    },
    as_of: 1781740800
  });

  assert.equal(quote.amount_sats, 200);
  assert.equal(quote.amount_msats, 200000);
  assert.equal(quote.btc_fiat_price, "50000.00");
  assert.equal(quote.expires_at, 1781741400);
});

test("parses and redacts NWC URI without leaking the client secret", () => {
  const parsed = parseNwcUri(NWC_URI);

  assert.equal(parsed.walletPubkey, "b".repeat(64));
  assert.deepEqual(parsed.relays, ["wss://relay.example.com"]);
  assert.equal(parsed.clientSecret, "c".repeat(64));
  assert.equal(parsed.lud16, "demo@example.com");
  assert.match(parsed.redacted, /secret=\[REDACTED\]/);
  assert.doesNotMatch(parsed.redacted, /c{64}/);
  assert.equal(redactNwcUri(NWC_URI), parsed.redacted);
});

test("settlement detection ignores preimage without settled state", () => {
  const detection = classifyLookupInvoiceSettlement({
    payment_hash: PAYMENT_HASH,
    preimage: "d".repeat(64),
    state: "pending"
  });

  assert.equal(detection.settled, false);
  assert.equal(detection.status, "pending");
  assert.equal(detection.preimage_present, true);
});

test("poller performs final lookup and grace lookup before expiring", async () => {
  let now = 1000;
  let lookups = 0;
  const sleeps = [];

  const outcome = await pollInvoiceUntilFinalState({
    created_at: 1000,
    expires_at: 1002,
    grace_policy: {
      max_attempts: 1,
      delay_seconds: 5
    },
    clock: {
      now: () => now,
      sleep_until: async (timestamp) => {
        sleeps.push(timestamp);
        now = timestamp;
      }
    },
    lookup_invoice: async () => {
      lookups += 1;
      return {
        payment_hash: PAYMENT_HASH,
        state: "pending"
      };
    }
  });

  assert.deepEqual(sleeps, [1002, 1007]);
  assert.equal(lookups, 2);
  assert.equal(outcome.status, "expired");
  assert.equal(outcome.reason, "grace_exhausted");
});

test("polling delay follows canonical cadence", () => {
  assert.equal(getPollingDelaySeconds({ created_at: 1000, now: 1000 }), 2);
  assert.equal(getPollingDelaySeconds({ created_at: 1000, now: 1015 }), 5);
  assert.equal(getPollingDelaySeconds({ created_at: 1000, now: 1060 }), 10);
  assert.equal(getPollingDelaySeconds({ created_at: 1000, now: 1180 }), 20);
});

test("in-memory storage replays same idempotency request and conflicts on drift", async () => {
  const store = new InMemoryInvoiceStore();
  const firstHash = await createIdempotencyRequestHash({ amount_msats: 200000 });
  const secondHash = await createIdempotencyRequestHash({ amount_msats: 300000 });
  const row = {
    invoice_id: "or_inv_test",
    merchant_scope: "demo:tenant",
    operation: "invoice.create",
    idempotency_key: "order-1",
    idempotency_request_hash: firstHash,
    payment_hash: PAYMENT_HASH,
    invoice: "lnbc-test",
    amount_msats: 200000,
    transaction_state: "pending",
    workflow_state: "invoice_created",
    fulfillment_state: "pending",
    created_at: 1000,
    expires_at: 1600,
    metadata: {}
  };

  assert.equal(store.createInvoice(row).status, "created");
  assert.equal(store.createInvoice(row).status, "replayed");
  assert.throws(
    () =>
      store.checkIdempotency({
        scope: row,
        idempotency_request_hash: secondHash
      }),
    /different request body/
  );
});

test("browser helpers create lightning URI, copy, open, and QR payloads", async () => {
  const writes = [];
  const opens = [];
  const encoder = {
    toString: async (payload, options) => {
      assert.equal(payload, "lightning:lnbc-test");
      assert.equal(options.margin, 4);
      assert.equal(options.color.light, "#FFFFFFFF");
      return "<svg></svg>";
    }
  };

  assert.equal(createLightningUri("lnbc-test"), "lightning:lnbc-test");
  assert.equal(await createQrSvg("lnbc-test", { encoder }), "<svg></svg>");
  await copyInvoice({
    invoice: "lnbc-test",
    clipboard: {
      writeText: async (value) => writes.push(value)
    }
  });
  assert.deepEqual(writes, ["lnbc-test"]);
  assert.equal(
    openWallet({
      invoice: "lnbc-test",
      open: (uri) => opens.push(uri)
    }),
    "lightning:lnbc-test"
  );
  assert.deepEqual(opens, ["lightning:lnbc-test"]);
});
