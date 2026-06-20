import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryInvoiceStore,
  OPENRECEIVE_ERROR_CODES,
  OpenReceiveError,
  classifyLookupInvoiceSettlement,
  createIdempotencyRequestHash,
  getPollingDelaySeconds,
  isOpenReceiveErrorCode,
  isRetryableOpenReceiveErrorCode,
  parseNwcUri,
  pollInvoiceUntilFinalState,
  quoteFiatToMsats,
  redactNwcUri
} from "../../packages/js/core/src/index.ts";
import {
  applyOpenReceiveInvoiceEvent,
  copyInvoice,
  createOpenReceiveCheckoutState,
  createLightningUri,
  createQrSvg,
  openWallet,
  parseOpenReceiveInvoiceEvent
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

test("canonical OpenReceive errors expose stable schema codes", () => {
  assert.equal(OPENRECEIVE_ERROR_CODES.includes("PAYMENT_FAILED"), true);
  assert.equal(isOpenReceiveErrorCode("INSUFFICIENT_BALANCE"), true);
  assert.equal(isOpenReceiveErrorCode("insufficient_balance"), false);
  assert.equal(isRetryableOpenReceiveErrorCode("TIMEOUT"), true);
  assert.equal(isRetryableOpenReceiveErrorCode("INVALID_REQUEST"), false);

  const error = new OpenReceiveError({
    code: "TIMEOUT",
    message: "Wallet lookup timed out",
    retryable: true,
    request_id: "req_123",
    details: {
      relay: "wss://relay.example.com"
    }
  });

  assert.deepEqual(error.toJSON(), {
    code: "TIMEOUT",
    message: "Wallet lookup timed out",
    retryable: true,
    request_id: "req_123",
    details: {
      relay: "wss://relay.example.com"
    }
  });
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

test("browser checkout state applies only matching passive invoice events", () => {
  const logs = [];
  const logger = (entry) => logs.push(entry);
  const state = createOpenReceiveCheckoutState(
    {
      invoice_id: "or_inv_browser",
      invoice: "lnbc-browser",
      payment_hash: PAYMENT_HASH,
      amount_msats: 200000,
      transaction_state: "pending",
      workflow_state: "invoice_created",
      expires_at: 1030,
      checkout: {
        events_url: "/openreceive/v1/invoices/or_inv_browser/events",
        routes_url: "/openreceive/v1/routes"
      }
    },
    { logger, now: 1000 }
  );

  assert.equal(state.lightningUri, "lightning:lnbc-browser");
  assert.equal(state.phase, "invoice_created");
  assert.equal(state.expiresInSeconds, 30);
  assert.equal(state.terminal, false);
  assert.equal(state.events_url, "/openreceive/v1/invoices/or_inv_browser/events");

  assert.equal(
    applyOpenReceiveInvoiceEvent(state, {
      invoice_id: "or_inv_other",
      transaction_state: "settled"
    }, {
      eventName: "invoice.settled",
      logger
    }),
    state
  );
  assert.equal(
    applyOpenReceiveInvoiceEvent(state, {
      invoice_id: "or_inv_browser",
      payment_hash: "b".repeat(64),
      transaction_state: "settled"
    }, {
      eventName: "invoice.settled",
      logger
    }),
    state
  );

  const verifying = applyOpenReceiveInvoiceEvent(
    state,
    {
      invoice_id: "or_inv_browser",
      payment_hash: PAYMENT_HASH,
      transaction_state: "pending",
      workflow_state: "verifying"
    },
    { eventName: "invoice.verifying", logger, now: 1005 }
  );

  assert.equal(verifying.phase, "verifying");
  assert.equal(verifying.last_event, "invoice.verifying");
  assert.equal(verifying.expiresInSeconds, 25);
  assert.equal(verifying.terminal, false);

  const settled = applyOpenReceiveInvoiceEvent(
    verifying,
    {
      invoice_id: "or_inv_browser",
      payment_hash: PAYMENT_HASH,
      amount_msats: 200000,
      transaction_state: "settled",
      workflow_state: "awaiting_fulfillment",
      settled_at: 1010
    },
    { eventName: "invoice.settled", logger }
  );

  assert.equal(settled.phase, "settled");
  assert.equal(settled.settled, true);
  assert.equal(settled.terminal, false);
  assert.equal(settled.settled_at, 1010);
  assert.equal(settled.last_event, "invoice.settled");
  assert.equal(settled.expiresInSeconds, undefined);

  const expired = applyOpenReceiveInvoiceEvent(settled, {
    invoice_id: "or_inv_browser",
    payment_hash: PAYMENT_HASH,
    transaction_state: "expired",
    workflow_state: "expired_closed"
  });

  assert.equal(expired.phase, "expired");
  assert.equal(expired.terminal, true);
  assert.deepEqual(
    logs.map((entry) => entry.event),
    [
      "checkout.state.created",
      "checkout.event.ignored",
      "checkout.event.ignored",
      "checkout.event.applied",
      "checkout.event.applied"
    ]
  );
  assert.equal(logs[0].invoice_id, "or_inv_browser");
  assert.equal(logs[3].phase, "verifying");
  assert.equal(logs[4].phase, "settled");
  assert.doesNotMatch(JSON.stringify(logs), /nostr\+walletconnect:\/\//);
});

test("browser action logs are display-safe and redact accidental secrets", async () => {
  const logs = [];
  const logger = (entry) => logs.push(entry);
  const writes = [];
  const opens = [];

  await copyInvoice({
    invoice: "lnbc-action",
    clipboard: {
      writeText: async (value) => writes.push(value)
    },
    logger,
    logContext: {
      invoice_id: "or_inv_action",
      payment_hash: PAYMENT_HASH
    }
  });
  openWallet({
    invoice: "lnbc-action",
    open: (uri) => opens.push(uri),
    logger,
    logContext: {
      invoice_id: "or_inv_action",
      nwc_secret: `nostr+walletconnect://${"d".repeat(64)}?secret=${"e".repeat(64)}`
    }
  });

  assert.deepEqual(writes, ["lnbc-action"]);
  assert.deepEqual(opens, ["lightning:lnbc-action"]);
  assert.deepEqual(
    logs.map((entry) => entry.event),
    ["checkout.invoice.copied", "checkout.wallet.opened"]
  );
  assert.equal(logs[0].invoice_id, "or_inv_action");
  assert.equal(logs[1].nwc_secret, "[REDACTED]");
  assert.doesNotMatch(JSON.stringify(logs), /nostr\+walletconnect:\/\//);
  assert.doesNotMatch(JSON.stringify(logs), /e{64}/);
});

test("browser invoice event parser accepts canonical SSE JSON payloads", () => {
  assert.deepEqual(
    parseOpenReceiveInvoiceEvent(
      JSON.stringify({
        invoice_id: "or_inv_browser",
        type: "incoming",
        transaction_state: "settled",
        workflow_state: "awaiting_fulfillment",
        payment_hash: PAYMENT_HASH,
        amount_msats: 200000,
        settled_at: 1010
      })
    ),
    {
      invoice_id: "or_inv_browser",
      type: "incoming",
      transaction_state: "settled",
      workflow_state: "awaiting_fulfillment",
      payment_hash: PAYMENT_HASH,
      amount_msats: 200000,
      settled_at: 1010
    }
  );

  assert.throws(
    () => parseOpenReceiveInvoiceEvent(JSON.stringify({ transaction_state: "settled" })),
    /invoice_id/
  );
});
