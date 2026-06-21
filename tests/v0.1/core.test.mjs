import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryInvoiceStore,
  OPENRECEIVE_ERROR_CODES,
  OpenReceiveError,
  classifyLookupInvoiceSettlement,
  createIdempotencyRequestHash,
  createOpenReceiveSettlementPollingRunner,
  getPollingDelaySeconds,
  isOpenReceiveErrorCode,
  isRetryableOpenReceiveErrorCode,
  parseNwcUri,
  pollInvoiceUntilFinalState,
  quoteFiatToMsats,
  redactNwcUri
} from "../../packages/js/core/src/index.ts";
import {
  OPENRECEIVE_COUNTRY_MAP_HEIGHT,
  OPENRECEIVE_COUNTRY_MAP_VIEW_BOX,
  OPENRECEIVE_COUNTRY_MAP_WIDTH,
  OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES,
  OPENRECEIVE_CHECKOUT_DATA_SELECTORS,
  OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES,
  OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS,
  OPENRECEIVE_CHECKOUT_ELEMENT_PARTS,
  OPENRECEIVE_CHECKOUT_ELEMENT_PART_SELECTORS,
  OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES,
  OPENRECEIVE_PAYMENT_WIZARD_SELECTORS,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_EVENTS,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_PARTS,
  OPENRECEIVE_THEME_TOGGLE_ELEMENT_PART_SELECTORS,
  applyOpenReceiveInvoiceEvent,
  copyInvoice,
  createOpenReceiveCheckoutActionEvent,
  createOpenReceiveCheckoutController,
  createOpenReceiveCheckoutDisplayModel,
  createOpenReceiveCheckoutErrorEvent,
  createOpenReceiveCheckoutSnapshotFromDisplayData,
  createOpenReceiveCheckoutStatusModel,
  createOpenReceiveCheckoutState,
  createOpenReceiveCheckoutStateFromDisplayData,
  createOpenReceiveCheckoutStateEvent,
  createOpenReceiveCountryPickerModel,
  createOpenReceiveLookupInvoiceFetcher,
  createOpenReceiveProviderCopyEvent,
  createOpenReceiveRefreshInvoiceFetcher,
  createOpenReceiveThemeChangeEvent,
  createOpenReceiveTransientFeedbackController,
  createLightningUri,
  createQrSvg,
  escapeOpenReceiveHtml,
  formatOpenReceiveCountryMetaLabel,
  formatOpenReceivePaymentHashLabel,
  OpenReceiveCheckoutWatcher,
  createOpenReceiveThemeModel,
  openReceiveCheckoutElementStyles,
  openReceiveCountryMapRegions,
  openReceiveThemeToggleElementStyles,
  openWallet,
  assertOpenReceiveDisplayInvoice,
  parseOpenReceiveBooleanAttribute,
  parseOpenReceiveInvoiceEvent,
  parseOpenReceiveOptionalInteger,
  parseOpenReceivePaymentMethod,
  parseOpenReceiveRegion,
  parseOpenReceiveResolvedTheme,
  parseOpenReceiveThemePreference,
  shouldOpenReceiveCheckoutShowWaiting
} from "../../packages/js/browser/src/index.ts";
import { openReceiveCountryMapLandPaths } from "../../packages/js/browser/src/country-map.ts";

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

test("settlement polling runner recovers and completes open invoices", async () => {
  const store = new InMemoryInvoiceStore();
  store.createInvoice({
    invoice_id: "or_inv_runner",
    merchant_scope: "demo:tenant",
    operation: "invoice.create",
    idempotency_key: "order-runner",
    idempotency_request_hash: `sha256:${"a".repeat(64)}`,
    payment_hash: PAYMENT_HASH,
    invoice: "lnbc-runner",
    amount_msats: 200000,
    transaction_state: "pending",
    workflow_state: "invoice_created",
    settlement_action_state: "pending",
    created_at: 1000,
    expires_at: 1600,
    metadata: {
      fruit: "banana"
    }
  });

  let now = 1000;
  let settlementActionCalls = 0;
  const events = [];
  const client = {
    async preflight() {
      throw new Error("preflight is not needed by the polling runner");
    },
    async makeInvoice() {
      throw new Error("makeInvoice is not needed by the polling runner");
    },
    async lookupInvoice(request) {
      assert.equal(request.payment_hash, PAYMENT_HASH);
      return {
        payment_hash: PAYMENT_HASH,
        state: "settled",
        settled_at: now
      };
    }
  };
  const runner = createOpenReceiveSettlementPollingRunner({
    client,
    store,
    settlementAction: async ({ invoice }) => {
      settlementActionCalls += 1;
      assert.equal(invoice.invoice_id, "or_inv_runner");
      assert.deepEqual(invoice.metadata, { fruit: "banana" });
    },
    onEvent: (event) => events.push(event.event),
    clock: {
      now: () => now,
      sleep_until: async (timestamp) => {
        now = timestamp;
      }
    }
  });

  const recovery = await runner.recoverOpenInvoices();
  const result = await runner.watchInvoice("or_inv_runner");
  const stored = store.getInvoice("or_inv_runner");

  assert.deepEqual(recovery.invoice_ids, ["or_inv_runner"]);
  assert.equal(result.outcome, "settled");
  assert.equal(stored.transaction_state, "settled");
  assert.equal(stored.workflow_state, "settlement_action_completed");
  assert.equal(stored.settlement_action_state, "completed");
  assert.equal(settlementActionCalls, 1);
  assert.deepEqual(events, [
    "invoice.verifying",
    "invoice.settled",
    "invoice.settlement_action_completed"
  ]);
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
    settlement_action_state: "pending",
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

test("browser owns checkout display-safe labels", () => {
  const model = createOpenReceiveCheckoutDisplayModel({
    invoice: "lnbc-display",
    payment_hash: "a".repeat(64),
    amount_msats: 200000,
    fiat_quote: {
      fiat: {
        currency: "USD",
        value: "0.05"
      }
    },
    transaction_state: "pending"
  });

  assert.equal(model.lightningUri, "lightning:lnbc-display");
  assert.equal(model.amountLabel, "200 sats");
  assert.equal(model.fiatLabel, "$0.05");
  assert.equal(model.paymentHashLabel, "aaaaaaaa...aaaaaaaa");
  assert.equal(model.transactionStateLabel, "pending");
  assert.equal(formatOpenReceivePaymentHashLabel("short-hash"), "short-hash");
  assert.throws(
    () => assertOpenReceiveDisplayInvoice("nostr+walletconnect://secret"),
    /must not be an NWC/
  );
});

test("browser owns display HTML escaping for string-rendered adapters", () => {
  assert.equal(
    escapeOpenReceiveHtml(`<&>"invoice"`),
    "&lt;&amp;&gt;&quot;invoice&quot;"
  );
});

test("browser owns checkout display data to state conversion", () => {
  const displayData = {
    invoice_id: "or_inv_display_state",
    invoice: "lnbc-display-state",
    payment_hash: "b".repeat(64),
    amount_msats: 21000,
    transaction_state: "pending",
    workflow_state: "invoice_created",
    expires_at: 2000,
    settled_at: 1999,
    checkout: {
      events_url: "/api/openreceive/invoices/or_inv_display_state/events"
    }
  };

  const snapshot = createOpenReceiveCheckoutSnapshotFromDisplayData(displayData);
  assert.deepEqual(snapshot, displayData);

  const state = createOpenReceiveCheckoutStateFromDisplayData(displayData, {
    now: 1940
  });
  assert.equal(state.invoice_id, "or_inv_display_state");
  assert.equal(state.lightningUri, "lightning:lnbc-display-state");
  assert.equal(state.amount_msats, 21000);
  assert.equal(state.phase, "invoice_created");
  assert.equal(state.expiresInSeconds, 60);
  assert.equal(state.settled_at, 1999);
  assert.equal(
    state.events_url,
    "/api/openreceive/invoices/or_inv_display_state/events"
  );
  const defaultClockState = createOpenReceiveCheckoutStateFromDisplayData({
    ...displayData,
    expires_at: Math.floor(Date.now() / 1000) + 30
  });
  assert.equal(defaultClockState.expiresInSeconds !== undefined, true);
  assert.equal(defaultClockState.expiresInSeconds <= 30, true);
  assert.equal(defaultClockState.expiresInSeconds >= 0, true);

  assert.throws(
    () => createOpenReceiveCheckoutSnapshotFromDisplayData({
      invoice: "lnbc-no-id"
    }),
    /invoice_id is required for checkout state/
  );
});

test("browser owns checkout payment status display model", () => {
  const state = createOpenReceiveCheckoutState({
    invoice_id: "or_inv_status",
    invoice: "lnbc-status",
    transaction_state: "pending",
    workflow_state: "verifying",
    expires_at: 1065
  }, {
    now: 1000
  });

  const status = createOpenReceiveCheckoutStatusModel(state, { now: 1000 });
  assert.equal(status.phase, "verifying");
  assert.equal(status.waiting, true);
  assert.equal(status.title, "Waiting for payment");
  assert.equal(status.detail, "Keep this page open while we verify settlement.");
  assert.equal(status.countdownPrefix, "Invoice expires in");
  assert.equal(status.expiresInSeconds, 65);
  assert.equal(status.countdownLabel, "1:05");

  const settled = createOpenReceiveCheckoutStatusModel({
    ...state,
    transaction_state: "settled",
    workflow_state: "settlement_action_completed",
    phase: "settled",
    settled: true,
    terminal: false,
    expiresInSeconds: undefined
  });
  assert.equal(settled.waiting, false);
  assert.equal(settled.title, "Payment received");
  assert.equal(settled.countdownLabel, undefined);

  const lightweight = createOpenReceiveCheckoutStatusModel({
    phase: "expired",
    waiting: false,
    expiresInSeconds: 0
  });
  assert.equal(lightweight.title, "Invoice expired");
  assert.equal(lightweight.countdownLabel, undefined);

  const zeroCountdown = createOpenReceiveCheckoutStatusModel({
    ...state,
    expiresInSeconds: 0
  });
  assert.equal(zeroCountdown.phase, "expired");
  assert.equal(zeroCountdown.waiting, false);
  assert.equal(zeroCountdown.title, "Invoice expired");
  assert.equal(zeroCountdown.countdownLabel, undefined);
});

test("browser owns reusable checkout attribute parsers", () => {
  assert.equal(parseOpenReceiveOptionalInteger(null), undefined);
  assert.equal(parseOpenReceiveOptionalInteger(""), undefined);
  assert.equal(
    parseOpenReceiveOptionalInteger("123", { label: "amount-msats" }),
    123
  );
  assert.throws(
    () => parseOpenReceiveOptionalInteger("-1", { label: "expires-at" }),
    /expires-at must be a non-negative safe integer/
  );
  assert.equal(parseOpenReceiveBooleanAttribute(null), undefined);
  assert.equal(parseOpenReceiveBooleanAttribute("false"), false);
  assert.equal(parseOpenReceiveBooleanAttribute(""), true);
  assert.equal(parseOpenReceiveResolvedTheme("dark"), "dark");
  assert.equal(parseOpenReceiveResolvedTheme("system"), undefined);
  assert.equal(parseOpenReceiveThemePreference("system"), "system");
  assert.equal(parseOpenReceiveThemePreference("sepia"), undefined);
});

test("browser owns transient copy feedback timing", () => {
  const values = [];
  const timers = new Map();
  let nextTimerId = 1;
  const controller = createOpenReceiveTransientFeedbackController({
    resetValue: "Copy invoice",
    delayMs: 20,
    setTimeout: (callback, delay) => {
      const id = nextTimerId++;
      timers.set(id, {
        callback: () => {
          timers.delete(id);
          callback();
        },
        delay
      });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
    onValue: (value) => values.push(value)
  });

  controller.show("Copied!");
  assert.deepEqual(values, ["Copied!"]);
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].delay, 20);

  controller.show("Copied again!");
  assert.deepEqual(values, ["Copied!", "Copied again!"]);
  assert.equal(timers.size, 1);

  [...timers.values()][0].callback();
  assert.deepEqual(values, ["Copied!", "Copied again!", "Copy invoice"]);

  controller.show("Copied!");
  controller.clear();
  assert.equal(timers.size, 0);
});

test("browser owns shared country map geometry", () => {
  assert.equal(OPENRECEIVE_COUNTRY_MAP_WIDTH, 820);
  assert.equal(OPENRECEIVE_COUNTRY_MAP_HEIGHT, 420);
  assert.equal(OPENRECEIVE_COUNTRY_MAP_VIEW_BOX, "0 0 820 420");
  assert.deepEqual(
    openReceiveCountryMapRegions.map((region) => region.id),
    [
      "north-america",
      "latin-america",
      "europe",
      "africa",
      "middle-east",
      "asia-pacific"
    ]
  );
  assert.equal(openReceiveCountryMapLandPaths.length > 0, true);
  assert.match(openReceiveCountryMapLandPaths[0].d, /^M/);
  const countries = [
    { code: "US", name: "United States", currency: "USD", coverage: "deep" },
    { code: "GB", name: "United Kingdom", currency: "GBP", coverage: "thin" }
  ];
  const picker = createOpenReceiveCountryPickerModel({
    countries,
    selectedCountryCode: "US",
    selectedRegion: "north-america",
    hoveredCountryCode: "GB"
  });
  assert.equal(formatOpenReceiveCountryMetaLabel(countries[0]), "USD");
  assert.equal(picker.selectedCountryDisplay?.label, "United States");
  assert.equal(picker.selectedCountryDisplay?.metaLabel, "USD");
  assert.equal(picker.hoveredCountryDisplay?.metaLabel, "GBP");
  assert.equal(picker.readoutLabel, "United Kingdom");
  assert.equal(picker.readoutMetaLabel, "GBP");
  assert.equal(picker.visibleRegionCountryDisplays[0].selected, true);
  assert.equal(picker.visibleRegionCountryDisplays[0].metaLabel, "USD");
});

test("browser owns web-component shadow styles", () => {
  assert.match(openReceiveCheckoutElementStyles, /:host/);
  assert.match(openReceiveCheckoutElementStyles, /part="wizard"/);
  assert.match(openReceiveCheckoutElementStyles, /openreceive-spin/);
  assert.match(openReceiveThemeToggleElementStyles, /data-openreceive-theme-toggle|min-height/);
});

test("browser lookup fetcher owns display-safe lookup POST shape", async () => {
  const requests = [];
  const lookupInvoice = createOpenReceiveLookupInvoiceFetcher({
    lookupUrl: "/openreceive/v1/invoices/lookup",
    fetch: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        json: async () => ({
          invoice_id: "or_inv_lookup",
          payment_hash: PAYMENT_HASH,
          transaction_state: "settled"
        })
      };
    }
  });

  const body = await lookupInvoice({
    invoice_id: "or_inv_lookup",
    invoice: "lnbc-lookup",
    lightningUri: "lightning:lnbc-lookup",
    payment_hash: PAYMENT_HASH,
    transaction_state: "pending",
    workflow_state: "invoice_created",
    phase: "pending",
    settled: false,
    terminal: false
  });

  assert.deepEqual(body, {
    invoice_id: "or_inv_lookup",
    payment_hash: PAYMENT_HASH,
    transaction_state: "settled"
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/openreceive/v1/invoices/lookup");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    payment_hash: PAYMENT_HASH
  });

  const failingLookup = createOpenReceiveLookupInvoiceFetcher({
    lookupUrl: "/openreceive/v1/invoices/lookup",
    fetch: async () => ({
      ok: false,
      json: async () => ({
        message: "Invoice not found."
      })
    })
  });
  await assert.rejects(
    () => failingLookup({
      invoice_id: "or_inv_lookup",
      invoice: "lnbc-lookup",
      lightningUri: "lightning:lnbc-lookup",
      transaction_state: "pending",
      workflow_state: "invoice_created",
      phase: "pending",
      settled: false,
      terminal: false
    }),
    /payment_hash/
  );
  await assert.rejects(
    () => failingLookup({
      invoice_id: "or_inv_lookup",
      invoice: "lnbc-lookup",
      lightningUri: "lightning:lnbc-lookup",
      payment_hash: PAYMENT_HASH,
      transaction_state: "pending",
      workflow_state: "invoice_created",
      phase: "pending",
      settled: false,
      terminal: false
    }),
    /Invoice not found/
  );
});

test("browser refresh fetcher owns idempotent refresh POST shape", async () => {
  const requests = [];
  const refreshInvoice = createOpenReceiveRefreshInvoiceFetcher({
    refreshUrl: (state) => `/openreceive/v1/invoices/${state.invoice_id}/refresh`,
    idempotencyKey: (state) => `${state.invoice_id}-refresh-1`,
    reason: "expired",
    fetch: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        json: async () => ({
          old_invoice_id: "or_inv_refresh_old",
          new_invoice_id: "or_inv_refresh_new",
          reason: "expired",
          invoice: {
            invoice_id: "or_inv_refresh_new",
            invoice: "lnbc-refresh-new",
            payment_hash: "c".repeat(64),
            amount_msats: 200000,
            transaction_state: "pending",
            workflow_state: "invoice_created",
            expires_at: 1100
          }
        })
      };
    }
  });

  const result = await refreshInvoice({
    invoice_id: "or_inv_refresh_old",
    invoice: "lnbc-refresh-old",
    lightningUri: "lightning:lnbc-refresh-old",
    payment_hash: PAYMENT_HASH,
    transaction_state: "expired",
    workflow_state: "expired_closed",
    phase: "expired",
    settled: false,
    terminal: true
  });

  assert.equal(result.new_invoice_id, "or_inv_refresh_new");
  assert.equal(result.invoice.invoice, "lnbc-refresh-new");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/openreceive/v1/invoices/or_inv_refresh_old/refresh");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(
    requests[0].init.headers["Idempotency-Key"],
    "or_inv_refresh_old-refresh-1"
  );
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    reason: "expired"
  });

  await assert.rejects(
    () => createOpenReceiveRefreshInvoiceFetcher({
      refreshUrl: "/refresh",
      idempotencyKey: "",
      fetch: async () => ({
        ok: true,
        json: async () => ({})
      })
    })({
      invoice_id: "or_inv_refresh_old",
      invoice: "lnbc-refresh-old",
      lightningUri: "lightning:lnbc-refresh-old",
      transaction_state: "expired",
      workflow_state: "expired_closed",
      phase: "expired",
      settled: false,
      terminal: true
    }),
    /Idempotency-Key/
  );
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
      workflow_state: "settlement_action_pending",
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

test("browser checkout watcher owns countdown, passive events, and lookup polling", async () => {
  let now = 1000;
  let nextTimer = 1;
  const timers = new Map();
  const clearedTimers = [];
  const states = [];
  const listeners = new Map();
  let closedEvents = 0;
  let lookupCalls = 0;

  const watcher = new OpenReceiveCheckoutWatcher({
    snapshot: {
      invoice_id: "or_inv_watch",
      invoice: "lnbc-watch",
      payment_hash: PAYMENT_HASH,
      amount_msats: 200000,
      transaction_state: "pending",
      workflow_state: "invoice_created",
      expires_at: 1010,
      checkout: {
        events_url: "/events/or_inv_watch"
      }
    },
    now: () => now,
    setInterval: (callback, ms) => {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, { callback, ms });
      return id;
    },
    clearInterval: (id) => {
      clearedTimers.push(id);
      timers.delete(id);
    },
    eventSourceFactory: (url) => {
      assert.equal(url, "/events/or_inv_watch");
      return {
        addEventListener: (type, listener) => {
          listeners.set(type, listener);
        },
        close: () => {
          closedEvents += 1;
        }
      };
    },
    lookupInvoice: async (state) => {
      lookupCalls += 1;
      assert.equal(state.payment_hash, PAYMENT_HASH);
      return {
        transaction_state: "settled",
        workflow_state: "settlement_action_pending",
        settled_at: 1002
      };
    },
    onState: (state) => {
      states.push(state);
    }
  });

  const initial = watcher.start();
  assert.equal(initial.expiresInSeconds, 10);
  assert.equal(shouldOpenReceiveCheckoutShowWaiting(initial, { now }), true);
  const countdownTimer = [...timers].find(([, timer]) => timer.ms === 1000);
  const pollTimer = [...timers].find(([, timer]) => timer.ms === 3000);
  assert.ok(countdownTimer);
  assert.ok(pollTimer);
  assert.equal(listeners.has("invoice.verifying"), true);
  assert.equal(listeners.has("invoice.settlement_action_completed"), true);

  now = 1003;
  countdownTimer[1].callback();
  assert.equal(states.at(-1).expiresInSeconds, 7);

  listeners.get("invoice.verifying")({
    type: "invoice.verifying",
    data: JSON.stringify({
      invoice_id: "or_inv_watch",
      payment_hash: PAYMENT_HASH,
      transaction_state: "pending",
      workflow_state: "verifying"
    })
  });
  assert.equal(states.at(-1).phase, "verifying");

  pollTimer[1].callback();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(lookupCalls, 1);
  assert.equal(states.at(-1).phase, "settled");
  assert.equal(shouldOpenReceiveCheckoutShowWaiting(states.at(-1), { now }), false);
  assert.equal(timers.has(countdownTimer[0]), false);
  assert.equal(timers.has(pollTimer[0]), false);
  assert.equal(closedEvents, 0);
  assert.ok(clearedTimers.includes(countdownTimer[0]));
  assert.ok(clearedTimers.includes(pollTimer[0]));

  listeners.get("invoice.settlement_action_completed")({
    type: "invoice.settlement_action_completed",
    data: JSON.stringify({
      invoice_id: "or_inv_watch",
      payment_hash: PAYMENT_HASH,
      transaction_state: "settled",
      workflow_state: "settlement_action_completed"
    })
  });
  assert.equal(states.at(-1).phase, "settled");
  assert.equal(closedEvents, 0);
  watcher.stop();
  assert.equal(closedEvents, 1);
});

test("browser checkout controller owns lifecycle actions for framework adapters", async () => {
  const states = [];
  const writes = [];
  const opens = [];
  let lookupCalls = 0;
  let refreshCalls = 0;
  const controller = createOpenReceiveCheckoutController({
    snapshot: {
      invoice_id: "or_inv_controller",
      invoice: "lnbc-controller",
      payment_hash: PAYMENT_HASH,
      amount_msats: 200000,
      transaction_state: "pending",
      workflow_state: "invoice_created"
    },
    lookupInvoice: async (state) => {
      lookupCalls += 1;
      assert.equal(state.payment_hash, PAYMENT_HASH);
      return {
        transaction_state: "settled",
        workflow_state: "settlement_action_pending",
        settled_at: 1042
      };
    },
    refreshInvoice: async (state) => {
      refreshCalls += 1;
      assert.equal(state.invoice_id, "or_inv_controller");
      return {
        old_invoice_id: state.invoice_id,
        new_invoice_id: "or_inv_controller_refresh",
        reason: "expired",
        invoice: {
          invoice_id: "or_inv_controller_refresh",
          invoice: "lnbc-controller-refresh",
          payment_hash: "e".repeat(64),
          amount_msats: state.amount_msats,
          transaction_state: "pending",
          workflow_state: "invoice_created",
          expires_at: 1200
        }
      };
    },
    clipboard: {
      writeText: async (value) => writes.push(value)
    },
    open: (uri) => opens.push(uri),
    onState: (state) => states.push(state)
  });

  const initial = controller.start();
  assert.equal(initial.invoice_id, "or_inv_controller");
  assert.equal(controller.getState()?.phase, "invoice_created");

  await controller.copyInvoice();
  const uri = controller.openWallet();
  assert.deepEqual(writes, ["lnbc-controller"]);
  assert.deepEqual(opens, ["lightning:lnbc-controller"]);
  assert.equal(uri, "lightning:lnbc-controller");

  const reloaded = await controller.reloadState();
  assert.equal(lookupCalls, 1);
  assert.equal(reloaded.phase, "settled");
  assert.equal(reloaded.settled_at, 1042);
  assert.equal(states.at(-1).settled_at, 1042);

  const retried = await controller.retry();
  assert.equal(lookupCalls, 2);
  assert.equal(retried.phase, "settled");

  const cancelled = controller.cancel();
  assert.equal(cancelled.phase, "settled");

  const refreshed = await controller.refreshExpiredInvoice();
  assert.equal(refreshCalls, 1);
  assert.equal(refreshed.invoice_id, "or_inv_controller_refresh");
  assert.equal(refreshed.invoice, "lnbc-controller-refresh");
  assert.equal(refreshed.phase, "invoice_created");
  assert.equal(states.at(-1).invoice_id, "or_inv_controller_refresh");

  const next = controller.update({
    snapshot: {
      invoice_id: "or_inv_controller_2",
      invoice: "lnbc-controller-2",
      payment_hash: PAYMENT_HASH,
      transaction_state: "settled",
      workflow_state: "settlement_action_pending",
      settled_at: 1000
    },
    clipboard: {
      writeText: async (value) => writes.push(value)
    },
    open: (value) => opens.push(value),
    onState: (state) => states.push(state)
  });
  assert.equal(next.invoice_id, "or_inv_controller_2");
  assert.equal(next.phase, "settled");
  await controller.copyInvoice();
  assert.deepEqual(writes, ["lnbc-controller", "lnbc-controller-2"]);
  assert.equal(states.at(-1).invoice_id, "or_inv_controller_2");
  controller.stop();
});

test("browser checkout controller owns lookupUrl fetcher creation", async () => {
  let nextTimer = 1;
  const timers = new Map();
  const states = [];
  const controller = createOpenReceiveCheckoutController({
    snapshot: {
      invoice_id: "or_inv_controller_lookup",
      invoice: "lnbc-controller-lookup",
      payment_hash: PAYMENT_HASH,
      transaction_state: "pending",
      workflow_state: "invoice_created"
    },
    lookupUrl: "/openreceive/v1/invoices/lookup",
    fetch: async (url, init) => {
      assert.equal(url, "/openreceive/v1/invoices/lookup");
      assert.deepEqual(JSON.parse(init.body), {
        payment_hash: PAYMENT_HASH
      });
      return {
        ok: true,
        json: async () => ({
          transaction_state: "settled",
          workflow_state: "settlement_action_pending",
          settled_at: 1000
        })
      };
    },
    setInterval: (callback, ms) => {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, { callback, ms });
      return id;
    },
    clearInterval: (id) => {
      timers.delete(id);
    },
    onState: (state) => states.push(state)
  });

  controller.start();
  const pollTimer = [...timers.values()].find((timer) => timer.ms === 3000);
  assert.ok(pollTimer);
  pollTimer.callback();
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
  }
  assert.equal(states.at(-1).phase, "settled");
  controller.stop();
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

test("browser custom-element event map covers checkout lifecycle events", () => {
  assert.deepEqual(OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS, {
    copy: "openreceive-copy",
    openWallet: "openreceive-open-wallet",
    paymentReceived: "openreceive-payment-received",
    state: "openreceive-state",
    settled: "openreceive-settled",
    providerCopy: "openreceive-provider-copy",
    startOver: "openreceive-start-over",
    error: "openreceive-error"
  });
  const providerCopyEvent = createOpenReceiveProviderCopyEvent("boltz");
  assert.equal(providerCopyEvent.type, OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.providerCopy);
  assert.deepEqual(providerCopyEvent.detail, {
    providerId: "boltz"
  });
  assert.equal(
    createOpenReceiveCheckoutActionEvent(OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.copy).type,
    OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.copy
  );
  assert.equal(
    createOpenReceiveCheckoutActionEvent(OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.startOver).type,
    OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.startOver
  );
  const stateEventState = createOpenReceiveCheckoutState({
    invoice_id: "or_inv_event",
    invoice: "lnbc-event",
    payment_hash: PAYMENT_HASH,
    transaction_state: "settled",
    workflow_state: "settlement_action_pending"
  });
  const stateEvent = createOpenReceiveCheckoutStateEvent(
    OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.settled,
    stateEventState
  );
  assert.equal(stateEvent.type, OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.settled);
  assert.deepEqual(stateEvent.detail, {
    state: stateEventState
  });
  const error = new Error("boom");
  const errorEvent = createOpenReceiveCheckoutErrorEvent(error);
  assert.equal(errorEvent.type, OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.error);
  assert.deepEqual(errorEvent.detail, {
    error
  });
  assert.deepEqual(OPENRECEIVE_THEME_TOGGLE_ELEMENT_EVENTS, {
    change: "openreceive-theme-change"
  });
  const themeChangeEvent = createOpenReceiveThemeChangeEvent(
    createOpenReceiveThemeModel("dark")
  );
  assert.equal(themeChangeEvent.type, OPENRECEIVE_THEME_TOGGLE_ELEMENT_EVENTS.change);
  assert.deepEqual(themeChangeEvent.detail, {
    theme: "dark",
    resolvedTheme: "dark"
  });
});

test("browser owns payment wizard DOM contract", () => {
  assert.deepEqual(OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES, {
    root: "data-openreceive-wizard",
    breadcrumb: "data-or-breadcrumb",
    method: "data-or-method",
    region: "data-or-region",
    regionShape: "data-or-region-shape",
    country: "data-or-country",
    switchCountry: "data-or-switch-country",
    route: "data-or-route",
    providerCopy: "data-or-provider-copy",
    providerTutorial: "data-or-provider-tutorial",
    providerTutorialIndex: "data-or-provider-tutorial-index"
  });
  assert.equal(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.breadcrumb, "[data-or-breadcrumb]");
  assert.equal(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.method, "[data-or-method]");
  assert.equal(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.providerCopy, "[data-or-provider-copy]");
  assert.equal(OPENRECEIVE_PAYMENT_WIZARD_SELECTORS.providerTutorial, "[data-or-provider-tutorial]");
  assert.equal(parseOpenReceivePaymentMethod("bitcoin"), "bitcoin");
  assert.equal(parseOpenReceivePaymentMethod("wire"), null);
  assert.equal(parseOpenReceiveRegion("europe"), "europe");
  assert.equal(parseOpenReceiveRegion("antarctica"), null);
});

test("browser owns checkout data attribute contract", () => {
  assert.deepEqual(OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES, {
    root: "data-openreceive-checkout",
    qr: "data-openreceive-qr",
    meta: "data-openreceive-meta",
    state: "data-openreceive-state",
    actions: "data-openreceive-actions",
    theme: "data-openreceive-theme",
    themeToggle: "data-openreceive-theme-toggle"
  });
  assert.equal(OPENRECEIVE_CHECKOUT_DATA_SELECTORS.root, "[data-openreceive-checkout]");
  assert.equal(OPENRECEIVE_CHECKOUT_DATA_SELECTORS.qr, "[data-openreceive-qr]");
  assert.equal(OPENRECEIVE_CHECKOUT_DATA_SELECTORS.themeToggle, "[data-openreceive-theme-toggle]");
});

test("browser owns custom-element attribute contracts", () => {
  assert.deepEqual(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES, {
    invoiceId: "invoice-id",
    invoice: "invoice",
    paymentHash: "payment-hash",
    amountMsats: "amount-msats",
    fiatCurrency: "fiat-currency",
    fiatValue: "fiat-value",
    transactionState: "transaction-state",
    workflowState: "workflow-state",
    expiresAt: "expires-at",
    eventsUrl: "events-url",
    lookupUrl: "lookup-url",
    theme: "theme",
    paymentWizard: "payment-wizard"
  });
  assert.deepEqual(OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES, {
    rootSelector: "root-selector",
    checkoutSelector: "checkout-selector",
    defaultTheme: "default-theme",
    storageKey: "storage-key"
  });
});

test("browser owns web-component shadow part contracts", () => {
  assert.deepEqual(OPENRECEIVE_CHECKOUT_ELEMENT_PARTS, {
    copy: "copy",
    open: "open",
    startOver: "start-over"
  });
  assert.deepEqual(OPENRECEIVE_CHECKOUT_ELEMENT_PART_SELECTORS, {
    copy: '[part="copy"]',
    open: '[part="open"]',
    startOver: '[part="start-over"]'
  });
  assert.deepEqual(OPENRECEIVE_THEME_TOGGLE_ELEMENT_PARTS, {
    button: "button"
  });
  assert.deepEqual(OPENRECEIVE_THEME_TOGGLE_ELEMENT_PART_SELECTORS, {
    button: '[part="button"]'
  });
});

test("browser invoice event parser accepts canonical SSE JSON payloads", () => {
  assert.deepEqual(
    parseOpenReceiveInvoiceEvent(
      JSON.stringify({
        invoice_id: "or_inv_browser",
        type: "incoming",
        transaction_state: "settled",
        workflow_state: "settlement_action_pending",
        payment_hash: PAYMENT_HASH,
        amount_msats: 200000,
        settled_at: 1010
      })
    ),
    {
      invoice_id: "or_inv_browser",
      type: "incoming",
      transaction_state: "settled",
      workflow_state: "settlement_action_pending",
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
