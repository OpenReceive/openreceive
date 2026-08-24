import assert from "node:assert/strict";
import test from "node:test";
import {
  createCheckoutController,
  createCheckoutState,
  createCheckoutElementAttributes,
  createStatusFetcher,
  normalizeSwapStartInvoice,
  postJson,
  prepareCheckout,
  requestCheckout,
} from "../packages/js/browser/src/headless.ts";
import {
  createSwapFeeBreakdown,
  checkoutRoutes,
} from "../packages/js/browser/src/internal/checkout.ts";
import { startSwapRequest } from "../packages/js/browser/src/headless.ts";

// The browser checkout attaches a console logger at INFO; these unit tests do not
// assert that output.
process.env.LOG_LEVEL ??= "error";

const hash = (character) => character.repeat(64);

/** Timer stubs so a started watcher never leaves a live interval behind. */
const noTimers = {
  setInterval: () => 0,
  clearInterval: () => {},
};

function lightningInvoice(overrides = {}) {
  return {
    invoice_id: hash("a"),
    rail: "lightning",
    invoice: "lnbc-light",
    payment_hash: hash("a"),
    amount_msats: 21_000,
    transaction_state: "pending",
    workflow_state: "invoice_created",
    expires_at: Math.floor(Date.now() / 1000) + 900,
    ...overrides,
  };
}

function snapshotOf(invoices, active = invoices[0]) {
  return {
    checkout_id: active.invoice_id,
    reference: "order-1",
    status: "open",
    amount_msats: 21_000,
    active,
    invoices,
  };
}

function jsonFetch(body) {
  const requests = [];
  const fetcher = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  fetcher.requests = requests;
  return fetcher;
}

test("status polling keeps sibling attempts so Lightning can be reused client-side", async () => {
  const lightning = lightningInvoice();
  const swap = {
    invoice_id: hash("b"),
    rail: "swap",
    payment_hash: hash("b"),
    amount_msats: 21_000,
    transaction_state: "pending",
    workflow_state: "invoice_created",
    swap: {
      provider: "fixedfloat",
      pay_in_asset: "USDT_TRON",
      deposit_address: "TDeposit",
      deposit_amount: "10.00",
      provider_state: "awaiting_deposit",
      provider_expires_at: Math.floor(Date.now() / 1000) + 900,
    },
  };
  const refresh = createStatusFetcher({
    prefix: "/openreceive",
    snapshot: snapshotOf([swap, lightning], swap),
    fetch: jsonFetch({ payment_hash: hash("b"), status: "pending" }),
  });

  const next = await refresh("order-1");
  assert.equal(next.active.invoice_id, hash("b"));
  assert.deepEqual(
    next.invoices.map((invoice) => invoice.invoice_id),
    [hash("b"), hash("a")],
    "the still-valid Lightning attempt must survive a swap status poll",
  );
});

test("a stopped controller reports the state its last reload produced", async () => {
  const invoice = lightningInvoice();
  let settled = false;
  const controller = createCheckoutController({
    snapshot: snapshotOf([invoice]),
    ...noTimers,
    refreshStatus: async () =>
      settled
        ? {
            ...snapshotOf([{ ...invoice, transaction_state: "settled", settled_at: 1_000 }]),
            status: "paid",
            paid_at: 1_000,
          }
        : snapshotOf([invoice]),
  });

  controller.start();
  assert.equal(controller.getState()?.settled, false);
  controller.stop();
  settled = true;

  const reloaded = await controller.reloadState();
  assert.equal(reloaded.settled, true);
  assert.equal(
    controller.getState()?.settled,
    true,
    "getState() must not serve a state older than the last reload",
  );
});

test("cancel() produces the cancelled phase it advertises", () => {
  const controller = createCheckoutController({
    snapshot: snapshotOf([lightningInvoice()]),
    ...noTimers,
    logger: false,
  });

  controller.start();
  const cancelled = controller.cancel();
  assert.equal(cancelled.phase, "cancelled");
  assert.equal(cancelled.terminal, true);
  assert.equal(cancelled.settled, false);
  assert.equal(controller.getState()?.phase, "cancelled");
  // retry() was a pure alias of reloadState() and is gone.
  assert.equal(controller.retry, undefined);
});

test("cancel() leaves a settled checkout settled", () => {
  const invoice = lightningInvoice({ transaction_state: "settled", settled_at: 1_000 });
  const controller = createCheckoutController({
    snapshot: { ...snapshotOf([invoice]), status: "paid", paid_at: 1_000 },
    ...noTimers,
    logger: false,
  });

  controller.start();
  const state = controller.cancel();
  assert.equal(state.settled, true);
  assert.equal(state.phase, "settled");
});

test("swap routes derive from the mount prefix and never carry the action key", async () => {
  const quoteFetch = jsonFetch({ pay_in_asset: "USDT_TRON" });
  await postJson({
    fetch: quoteFetch,
    prefix: "/openreceive",
    body: {
      reference: "order-1",
      action: "swap_quote",
      pay_in_asset: "USDT_TRON",
    },
  });
  assert.equal(quoteFetch.requests[0].url, "/openreceive/swaps/quote");
  assert.deepEqual(quoteFetch.requests[0].body, {
    reference: "order-1",
    pay_in_asset: "USDT_TRON",
  });

  // A body with no `action` posts to the payment-check route — still without
  // `action`, which the shipped schemas reject as an unknown property.
  const plainFetch = jsonFetch({ status: "pending" });
  await postJson({
    fetch: plainFetch,
    prefix: "/openreceive",
    body: {
      reference: "order-1",
      payment_hash: hash("a"),
    },
  });
  assert.equal(plainFetch.requests[0].url, "/openreceive/payments/check");
  assert.deepEqual(plainFetch.requests[0].body, {
    reference: "order-1",
    payment_hash: hash("a"),
  });

  // An action postJson does not route is a caller bug, not a silent post to
  // payments/check under a name that says otherwise.
  await assert.rejects(
    postJson({
      fetch: jsonFetch({ status: "pending" }),
      prefix: "/openreceive",
      body: { reference: "order-1", action: "status" },
    }),
    /Unrecognized checkout action status/,
  );
});

test("a trailing slash on the prefix does not double up in a derived route", () => {
  assert.deepEqual(checkoutRoutes("/openreceive/"), checkoutRoutes("/openreceive"));
  assert.equal(checkoutRoutes("").checkouts, "/checkouts");
  assert.equal(checkoutRoutes("/openreceive").swapsRefunds, "/openreceive/swaps/refunds");
});

// THERE IS ONE MOUNT: substituting a default for a `prefix` that never arrived
// would create a checkout against one deployment and settle it against
// another. `prefix` is required in the types, so this guard is for the callers
// the types do not reach — plain JS, and a wrapper handing through a prop that
// was never set — and it lives in `checkoutRoutes` so every published entry
// point inherits it. These cases used to be an opaque TypeError from
// `.replace` on `undefined`.
test("a missing or non-string prefix fails loudly, naming the option", () => {
  for (const bad of [undefined, null, 42, {}]) {
    assert.throws(
      () => checkoutRoutes(bad),
      (error) =>
        error instanceof TypeError &&
        error.message.includes("`prefix`") &&
        error.message.includes("/openreceive"),
      `checkoutRoutes(${String(bad)}) must name the missing option`,
    );
  }
  // `""` is a legal prefix — "mounted at the root" — not a missing one.
  assert.equal(checkoutRoutes("").paymentsCheck, "/payments/check");
});

test("the published entry points inherit the prefix guard", async () => {
  assert.throws(
    () =>
      createStatusFetcher({
        snapshot: snapshotOf([lightningInvoice()]),
        fetch: () => {},
      }),
    /OpenReceive requires `prefix`/,
  );
  await assert.rejects(
    requestCheckout({ reference: "order-1", fetch: () => {} }),
    /OpenReceive requires `prefix`/,
  );
  await assert.rejects(
    prepareCheckout({ reference: "order-1", fetch: () => {} }),
    /OpenReceive requires `prefix`/,
  );
  await assert.rejects(
    startSwapRequest({ reference: "order-1", payInAsset: "USDT", fetch: () => {} }),
    /OpenReceive requires `prefix`/,
  );
});

// A Rails page renders the session's CSRF token into `<meta name="csrf-token">`;
// the client forwards it as X-CSRF-Token so the engine can inherit the host's
// protect_from_forgery. Without the meta tag nothing is added, and a host
// `headers` value for the same name wins.
test("the client sends X-CSRF-Token from the page's csrf-token meta tag", async () => {
  const captured = [];
  const fetcher = async (_url, init) => {
    captured.push(new Headers(init.headers));
    return new Response(
      JSON.stringify({ reference: "order-1", amount_msats: 1, payment_methods: [] }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };
  const hadDocument = "document" in globalThis;
  const previous = globalThis.document;
  try {
    globalThis.document = {
      querySelector: (selector) =>
        selector === 'meta[name="csrf-token"]' ? { getAttribute: () => "tok-123" } : null,
    };
    await prepareCheckout({ prefix: "/openreceive", reference: "order-1", fetch: fetcher });
    await prepareCheckout({
      prefix: "/openreceive",
      reference: "order-1",
      fetch: fetcher,
      headers: { "X-CSRF-Token": "host-wins" },
    });
    globalThis.document = { querySelector: () => null };
    await prepareCheckout({ prefix: "/openreceive", reference: "order-1", fetch: fetcher });
  } finally {
    if (hadDocument) globalThis.document = previous;
    else delete globalThis.document;
  }
  assert.equal(captured[0].get("x-csrf-token"), "tok-123");
  assert.equal(captured[0].get("content-type"), "application/json");
  assert.equal(captured[1].get("x-csrf-token"), "host-wins");
  assert.equal(captured[2].get("x-csrf-token"), null);
});

test("deferred-mode element attributes carry the same create-time options as create mode", () => {
  const options = {
    prefix: "/openreceive",
    metadata: { cart: "abc" },
    syncUrl: true,
    resumePathPrefix: "/pay",
    routeReference: "order-1",
    theme: "dark",
  };
  const lock = {
    invoice_id: "lock:order-1",
    rail: "checkout_lock",
    amount_msats: 21_000,
    transaction_state: "pending",
    workflow_state: "invoice_created",
  };
  const created = createCheckoutElementAttributes(null, { ...options, reference: "order-1" });
  const deferred = createCheckoutElementAttributes(
    {
      checkout_id: "lock:order-1",
      reference: "order-1",
      status: "open",
      amount_msats: 21_000,
      active: lock,
      invoices: [lock],
    },
    options,
  );

  for (const attribute of ["metadata", "sync-url", "resume-path-prefix", "route-reference"]) {
    assert.equal(
      deferred[attribute],
      created[attribute],
      `${attribute} must survive prepare-server-side (deferred) mode`,
    );
  }
  assert.equal(deferred.metadata, JSON.stringify({ cart: "abc" }));
  assert.equal(deferred["amount-msats"], "21000");
});

test("swap fee breakdown stays exact on the shared decimal engine", () => {
  assert.deepEqual(
    createSwapFeeBreakdown({
      currency: "USD",
      pay_in_fiat: "105.5",
      payout_fiat: "100.00",
    }),
    {
      cartTotal: "$100.00",
      youSend: "$105.50",
      fee: "$5.50",
      feePercent: "5.5%",
    },
  );
  // The fee is a display EXTRA, so an absent figure hides the row rather than
  // failing the panel. This is optionality, not distrust of the trusted chain.
  assert.equal(createSwapFeeBreakdown(undefined), undefined);
  // A zero payout is the division guard, not a parse: it defends our own
  // fee/payout arithmetic below.
  assert.equal(
    createSwapFeeBreakdown({ currency: "USD", pay_in_fiat: "1.00", payout_fiat: "0" }),
    undefined,
  );
});

/** Every string value in a log entry, at any nesting depth. */
function logStringValues(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(logStringValues);
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap(logStringValues);
}

/** Every key in a log entry, at any nesting depth. */
function logKeys(value) {
  if (Array.isArray(value)) return value.flatMap(logKeys);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, nested]) => [key, ...logKeys(nested)]);
}

// The browser log-field builders are an allowlist, not a redaction pass:
// sanitizeBrowserLogEntry only scrubs secret/token/authorization/cookie/nwc, so
// nothing downstream would stop a raw preimage or bolt11 from reaching a log
// sink. This is the assertion that stops it.
test("browser checkout log fields never carry a preimage or a raw bolt11", () => {
  const entries = [];
  const bolt11 = "lnbc1secretinvoicepayload";
  const preimage = hash("f");
  const swapInvoice = {
    invoice_id: hash("b"),
    rail: "swap",
    invoice: bolt11,
    payment_hash: hash("b"),
    preimage,
    amount_msats: 21_000,
    transaction_state: "pending",
    workflow_state: "invoice_created",
    expires_at: 2_000,
    swap: {
      attempt_id: "attempt-1",
      provider: "fixedfloat",
      provider_order_id: "ff-1",
      pay_in_asset: "USDT_TRON",
      deposit_address: "TDeposit",
      deposit_amount: "10.00",
      provider_state: "refund_required",
      provider_expires_at: 2_000,
      refund_address: "TRefund",
      refund_reason: "under_paid",
      attention: true,
      attention_reason: "manual_review",
    },
  };
  const options = { logger: (entry) => entries.push(entry), now: 1_000 };

  const created = createCheckoutState(snapshotOf([swapInvoice]), options);
  createCheckoutState(snapshotOf([swapInvoice]), {
    ...options,
    source: "refresh",
    previousState: { ...created, swap: { ...created.swap, provider_state: "awaiting_deposit" } },
  });

  assert.ok(entries.length >= 2, "create and refresh must both emit a checkout log entry");
  for (const entry of entries) {
    const keys = logKeys(entry);
    for (const forbidden of ["preimage", "invoice", "lightning_uri"]) {
      assert.ok(
        !keys.includes(forbidden),
        `${entry.event} must not log a ${forbidden} field: ${JSON.stringify(entry)}`,
      );
    }
    for (const value of logStringValues(entry)) {
      assert.ok(!value.includes(bolt11), `${entry.event} leaked the raw bolt11`);
      assert.ok(!value.includes(preimage), `${entry.event} leaked the preimage`);
    }
  }
});

// ------------------------------- the optional checkout amount echo -----------

// `checkout.amount_msats` on a swap start / refund body is an optional echo of
// the checkout's own amount, which the client already knows: a safe integer is
// copied onto the snapshot, and anything else is simply omitted.

function swapStartBody(checkout) {
  return {
    swap: {
      payment_hash: hash("e"),
      provider: "lightning-swap-com",
      pay_in_asset: "SOL_SOL",
      deposit_address: "SoLAddress",
      deposit_amount: "0.027479",
      provider_state: "awaiting_deposit",
      provider_expires_at: Math.floor(Date.now() / 1000) + 900,
      ...(checkout === undefined ? {} : { checkout }),
    },
  };
}

test("a swap start payload copies a real amount and omits everything else", () => {
  // Zero is an amount: falsy, and the obvious thing for a copy to get wrong.
  for (const amountMsats of [0, 21_000, Number.MAX_SAFE_INTEGER]) {
    assert.equal(
      normalizeSwapStartInvoice(swapStartBody({ amount_msats: amountMsats })).amount_msats,
      amountMsats,
    );
  }

  // The field is OPTIONAL: "not echoed" — missing, no `checkout` object at
  // all, or JSON `null` — simply carries no amount.
  for (const checkout of [undefined, {}, { amount_msats: null }]) {
    const invoice = normalizeSwapStartInvoice(swapStartBody(checkout));
    assert.equal(invoice.amount_msats, undefined);
    assert.equal(invoice.rail, "swap");
    assert.equal(invoice.payment_hash, hash("e"));
  }

  // Optional means ABSENT may be absent — not that a present-but-mistyped
  // amount from our own server quietly becomes no amount at all.
  for (const checkout of [{ amount_msats: "21000" }, { amount_msats: 1.5 }]) {
    assert.throws(
      () => normalizeSwapStartInvoice(swapStartBody(checkout)),
      /amount_msats must be a safe integer/,
    );
  }
});

test("every amount a swap start copies is one the formatter will format", () => {
  for (const amountMsats of [0, 1_000, 21_000, 999_999_999]) {
    const invoice = normalizeSwapStartInvoice(swapStartBody({ amount_msats: amountMsats }));
    const state = createCheckoutState(
      {
        checkout_id: invoice.invoice_id,
        reference: "order-1",
        status: "open",
        amount_msats: amountMsats,
        active: invoice,
        invoices: [invoice],
      },
      { now: Math.floor(Date.now() / 1000), logger: false },
    );
    assert.equal(state.amount_msats, amountMsats);
    assert.notEqual(state.amountLabel, undefined, `${amountMsats} must still get a label`);
  }
});
