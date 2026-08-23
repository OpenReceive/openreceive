// Custom-element lifecycle regressions (M33/L21/M34): one mint per Bitcoin
// selection, order swaps that land mid-prepare, self-written attributes that must
// not re-enter the element, stale QR encodes, and the shared stylesheet.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

process.env.LOG_LEVEL ??= "error";
GlobalRegistrator.register({ url: "http://elements.local/" });

const assert = (await import("node:assert/strict")).default;
const test = (await import("node:test")).default;
// Imported after DOM registration: the package touches window/document when the
// element classes are defined.
const { defineElements } = await import("../packages/js/elements/src/index.ts");

const qrRequests = [];
const qrEncoder = {
  toString(payload) {
    return new Promise((resolve) => {
      qrRequests.push({ payload, resolve });
    });
  },
};

defineElements({ qrEncoder, logger: false });

// Every test stubs globalThis.fetch; restore the real one so the stub cannot
// leak into other files sharing this process.
const originalFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Poll until predicate() is truthy (its value is returned) or fail with `label`. */
async function until(predicate, { timeoutMs = 4000, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Let queued microtasks and timers settle. */
async function flush(times = 6) {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  };
}

/**
 * Fetch stub recording every call. `routes` maps a path suffix to a handler that
 * returns a body (or a promise of one, for deliberately slow endpoints).
 */
function createFetchStub(routes) {
  const calls = [];
  const fetchStub = async (input, init) => {
    const url = String(input);
    const body = init?.body === undefined ? undefined : JSON.parse(init.body);
    const path = new URL(url, "http://elements.local").pathname;
    calls.push({ path, body });
    const handler = Object.entries(routes).find(([suffix]) => path.endsWith(suffix))?.[1];
    if (handler === undefined) throw new Error(`Unexpected request to ${path}`);
    return jsonResponse(await handler(body));
  };
  fetchStub.calls = calls;
  fetchStub.pathCount = (suffix) => calls.filter((call) => call.path.endsWith(suffix)).length;
  return fetchStub;
}

function prepareBody(reference, amountMsats) {
  return {
    reference: reference,
    amount_msats: amountMsats,
    payment_methods: [],
  };
}

function checkoutBody(reference, amountMsats, paymentHash) {
  return {
    checkout: {
      reference: reference,
      payment_hash: paymentHash,
      bolt11: `lnbc-${paymentHash}`,
      amount_msats: amountMsats,
      expires_at: Math.floor(Date.now() / 1000) + 900,
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function mount(attributes) {
  const element = document.createElement("openreceive-checkout");
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  document.body.appendChild(element);
  return element;
}

test("double-clicking Bitcoin mints exactly one Lightning invoice", async () => {
  const mint = deferred();
  const fetchStub = createFetchStub({
    "/checkouts/prepare": () => prepareBody("order-1", 21_000),
    "/checkouts": () => mint.promise,
    "/payments/check": () => ({ status: "pending" }),
  });
  globalThis.fetch = fetchStub;
  const element = mount({ reference: "order-1", prefix: "/openreceive" });

  try {
    const bitcoin = await until(
      () => element.shadowRoot?.querySelector('[data-or-method="bitcoin"]'),
      { label: "Bitcoin method tile" },
    );
    // A real double-click delivers both events to the same node before any
    // re-render can swap it out.
    bitcoin.click();
    bitcoin.click();
    await flush(2);
    assert.equal(
      fetchStub.pathCount("/checkouts"),
      1,
      "a second Bitcoin click must not POST a second checkout",
    );

    mint.resolve(checkoutBody("order-1", 21_000, "a".repeat(64)));
    await until(() => element.getAttribute("invoice") !== null, { label: "minted invoice" });
    assert.equal(fetchStub.pathCount("/checkouts"), 1);
    assert.doesNotMatch(element.shadowRoot?.innerHTML ?? "", /Could not create the Lightning/);
  } finally {
    element.remove();
  }
});

// The in-flight guard above is only half of the mint's double-POST story. The
// other half is the payer whose bolt11 has ALREADY landed: they walk back to
// the method grid and pick Bitcoin again. `mintingLightning` is false by then,
// so the only thing standing between that click and a second POST /checkouts
// is the reuse branch in the shared session (ensureLightning's
// findReusableLightningInvoice short-circuit). The pair of this is
// tests/react-checkout-behavior.test.mjs, "Bitcoin selected again after the
// mint reuses the bolt11 instead of minting a second one".
test("re-selecting Bitcoin after the mint reuses the bolt11 instead of minting again", async () => {
  const paymentHash = "d".repeat(64);
  const fetchStub = createFetchStub({
    "/checkouts/prepare": () => prepareBody("order-reuse-ln", 21_000),
    "/checkouts": () => checkoutBody("order-reuse-ln", 21_000, paymentHash),
    "/payments/check": () => ({ status: "pending" }),
  });
  globalThis.fetch = fetchStub;
  const element = mount({ reference: "order-reuse-ln", prefix: "/openreceive" });

  try {
    const bitcoin = await until(
      () => element.shadowRoot?.querySelector('[data-or-method="bitcoin"]'),
      { label: "Bitcoin method tile" },
    );
    bitcoin.click();
    await until(() => element.getAttribute("invoice") !== null, { label: "minted invoice" });
    assert.equal(fetchStub.pathCount("/checkouts"), 1);

    // Back to the grid. This breadcrumb deliberately does not dismiss anything
    // (only "back to Lightning" out of a swap panel does), so the bolt11 the
    // payer is holding is still theirs to pay.
    const breadcrumb = await until(
      () => element.shadowRoot?.querySelector('[data-or-breadcrumb="method"]'),
      { label: "method breadcrumb" },
    );
    breadcrumb.click();
    const again = await until(
      () => element.shadowRoot?.querySelector('[data-or-method="bitcoin"]'),
      { label: "method grid again" },
    );
    again.click();
    await flush(4);
    assert.equal(
      fetchStub.pathCount("/checkouts"),
      1,
      "Bitcoin re-selected with a live bolt11 must not POST a second checkout",
    );
    // Reuse means the SAME invoice, not a silently replaced one.
    assert.equal(element.getAttribute("invoice"), `lnbc-${paymentHash}`);
    assert.equal(element.getAttribute("payment-hash"), paymentHash);
    assert.doesNotMatch(element.shadowRoot?.innerHTML ?? "", /Could not create the Lightning/);
  } finally {
    element.remove();
  }
});

test("an reference change mid-prepare wins over the request it superseded", async () => {
  const firstPrepare = deferred();
  const fetchStub = createFetchStub({
    "/checkouts/prepare": (body) =>
      body.reference === "order-1" ? firstPrepare.promise : prepareBody("order-2", 2_000),
    "/payments/check": () => ({ status: "pending" }),
  });
  globalThis.fetch = fetchStub;
  const element = mount({ reference: "order-1", prefix: "/openreceive" });

  try {
    await until(() => fetchStub.pathCount("/checkouts/prepare") === 1, {
      label: "first prepare",
    });
    element.setAttribute("reference", "order-2");
    // The first order's response lands after the swap; it must not be applied.
    firstPrepare.resolve(prepareBody("order-1", 1_000));

    await until(() => element.getAttribute("amount-msats") === "2000", {
      label: "order-2 attributes",
    });
    assert.equal(element.getAttribute("reference"), "order-2");
    assert.equal(fetchStub.pathCount("/checkouts/prepare"), 2);
    assert.deepEqual(
      fetchStub.calls
        .filter((call) => call.path.endsWith("/payments/check"))
        .map((call) => call.body.reference)
        .filter((reference) => reference !== "order-2"),
      [],
      "no controller may poll the superseded order",
    );
  } finally {
    element.remove();
  }
});

test("a status transition the element wrote does not restart the controller", async () => {
  const paymentHash = "b".repeat(64);
  const fetchStub = createFetchStub({
    "/payments/check": () => ({ status: "settled", paid_at: Math.floor(Date.now() / 1000) }),
  });
  globalThis.fetch = fetchStub;
  const element = mount({
    reference: "order-3",
    prefix: "/openreceive",
    "invoice-id": paymentHash,
    invoice: `lnbc-${paymentHash}`,
    "payment-hash": paymentHash,
    "amount-msats": "21000",
    "expires-at": String(Math.floor(Date.now() / 1000) + 900),
  });

  try {
    await until(() => element.getAttribute("status") === "settled", { label: "settled status" });
    await flush();
    assert.equal(
      fetchStub.pathCount("/payments/check"),
      1,
      "writing status/expires-at back must not re-enter attributeChangedCallback",
    );
  } finally {
    element.remove();
  }
});

test("a slow QR encode never paints over a newer invoice", async () => {
  const fetchStub = createFetchStub({
    "/payments/check": () => ({ status: "pending" }),
  });
  globalThis.fetch = fetchStub;
  qrRequests.length = 0;
  const expiresAt = String(Math.floor(Date.now() / 1000) + 900);
  const element = mount({
    reference: "order-4",
    prefix: "/openreceive",
    "invoice-id": "c".repeat(64),
    invoice: "lnbc-first",
    "payment-hash": "c".repeat(64),
    "amount-msats": "21000",
    "expires-at": expiresAt,
  });

  try {
    await until(() => qrRequests.some((request) => request.payload.includes("lnbc-first")), {
      label: "first QR encode",
    });
    element.setAttribute("invoice", "lnbc-second");
    await until(() => qrRequests.some((request) => request.payload.includes("lnbc-second")), {
      label: "second QR encode",
    });
    await flush(2);

    // The slow first encode resolves last, after the invoice moved on.
    for (const request of qrRequests.filter((entry) => entry.payload.includes("lnbc-second"))) {
      request.resolve("<svg data-qr='second'></svg>");
    }
    await flush(2);
    for (const request of qrRequests.filter((entry) => entry.payload.includes("lnbc-first"))) {
      request.resolve("<svg data-qr='first'></svg>");
    }
    await flush();

    const qr = element.shadowRoot?.querySelector("[data-openreceive-qr]");
    assert.match(qr?.innerHTML ?? "", /second/);
    assert.doesNotMatch(qr?.innerHTML ?? "", /first/);
  } finally {
    element.remove();
  }
});

test("checkout and theme-toggle shadow roots share one adopted stylesheet", async () => {
  const fetchStub = createFetchStub({
    "/payments/check": () => ({ status: "pending" }),
  });
  globalThis.fetch = fetchStub;
  const paymentHash = "e".repeat(64);
  const element = mount({
    reference: "order-5",
    prefix: "/openreceive",
    "invoice-id": paymentHash,
    invoice: `lnbc-${paymentHash}`,
    "payment-hash": paymentHash,
    "amount-msats": "21000",
    "expires-at": String(Math.floor(Date.now() / 1000) + 900),
  });
  const toggle = document.createElement("openreceive-theme-toggle");
  document.body.appendChild(toggle);

  try {
    const root = await until(() => element.shadowRoot, { label: "checkout shadow root" });
    assert.equal(root.adoptedStyleSheets.length, 1);
    assert.equal(root.querySelector("style"), null, "styles must not be inlined per render");
    assert.equal(toggle.shadowRoot?.adoptedStyleSheets.length, 1);
    assert.equal(toggle.shadowRoot?.querySelector("style"), null);
    assert.equal(
      root.adoptedStyleSheets[0],
      toggle.shadowRoot?.adoptedStyleSheets[0],
      "every OpenReceive shadow root shares one constructable sheet",
    );

    // A re-render keeps exactly one sheet rather than stacking copies.
    element.setAttribute("theme", "dark");
    await flush(2);
    assert.equal(element.shadowRoot.adoptedStyleSheets.length, 1);
  } finally {
    element.remove();
    toggle.remove();
  }
});

test("a cosmetic theme flip re-renders without restarting the poll controller", async () => {
  const fetchStub = createFetchStub({
    "/payments/check": () => ({ status: "pending" }),
  });
  globalThis.fetch = fetchStub;
  const paymentHash = "a".repeat(64);
  const element = mount({
    reference: "order-theme-poll",
    prefix: "/openreceive",
    "invoice-id": paymentHash,
    invoice: `lnbc-${paymentHash}`,
    "payment-hash": paymentHash,
    "amount-msats": "21000",
    "expires-at": String(Math.floor(Date.now() / 1000) + 900),
  });

  try {
    await until(() => fetchStub.pathCount("/payments/check") > 0, {
      label: "initial status request",
    });
    await flush(4);
    const before = fetchStub.pathCount("/payments/check");

    element.setAttribute("theme", "dark");
    await flush(4);
    assert.match(
      element.shadowRoot?.innerHTML ?? "",
      /data-theme="dark"/,
      "the theme change must still re-render the shadow tree",
    );
    assert.equal(
      fetchStub.pathCount("/payments/check"),
      before,
      "a display-only attribute must not restart the controller (extra POST /payments/check)",
    );
  } finally {
    element.remove();
  }
});

test("a failed prepare plus a theme flip never re-prepares", async () => {
  // M12 regression, behaviorally: the prepare failure must not clear the
  // element's created marker, and a display-only attribute change (theme) must
  // not restart the controller — together those two bugs made every theme sync
  // after an outage fire another prepare POST (a retry storm).
  let prepareCalls = 0;
  const fetchStub = createFetchStub({
    "/checkouts/prepare": () => {
      prepareCalls += 1;
      throw new Error("prepare endpoint unavailable");
    },
  });
  globalThis.fetch = fetchStub;
  const element = mount({ reference: "order-prepare-fail", prefix: "/openreceive" });

  try {
    await until(() => prepareCalls === 1, { label: "failed prepare attempt" });
    await flush(4);

    element.setAttribute("theme", "dark");
    await flush(4);
    assert.match(
      element.shadowRoot?.innerHTML ?? "",
      /data-theme="dark"/,
      "the theme change must still re-render the shadow tree",
    );
    assert.equal(
      prepareCalls,
      1,
      "a theme flip after a failed prepare must not POST /checkouts/prepare again",
    );
  } finally {
    element.remove();
  }
});

test('polling="false" renders the snapshot without any status requests', async () => {
  const fetchStub = createFetchStub({
    "/payments/check": () => ({ status: "pending" }),
  });
  globalThis.fetch = fetchStub;
  const paymentHash = "b".repeat(64);
  const element = mount({
    reference: "order-no-poll",
    prefix: "/openreceive",
    "invoice-id": paymentHash,
    invoice: `lnbc-${paymentHash}`,
    "payment-hash": paymentHash,
    "amount-msats": "21000",
    "expires-at": String(Math.floor(Date.now() / 1000) + 900),
    polling: "false",
  });

  try {
    await until(() => element.shadowRoot?.innerHTML.length > 0, { label: "snapshot render" });
    await flush(6);
    assert.equal(fetchStub.pathCount("/payments/check"), 0);

    // Turning polling back on is a polling-affecting change: the controller restarts.
    element.setAttribute("polling", "true");
    await until(() => fetchStub.pathCount("/payments/check") > 0, {
      label: "status request after enabling polling",
    });
  } finally {
    element.remove();
  }
});

/** Prepare body advertising one payable swap asset, so the wizard offers it directly. */
function prepareBodyWithSwapAsset(reference, payInAsset) {
  return {
    reference: reference,
    amount_msats: 5_000_000,
    payment_methods: [
      {
        pay_in_asset: payInAsset,
        label: payInAsset.split("_")[0],
        network_label: "Solana",
        provider: "fixedfloat",
        available: true,
      },
    ],
  };
}

function swapStartBody(payInAsset, paymentHash) {
  return {
    swap: {
      payment_hash: paymentHash,
      provider: "fixedfloat",
      pay_in_asset: payInAsset,
      deposit_address: "SoLDeposit",
      deposit_amount: "1.50",
      provider_state: "awaiting_deposit",
      provider_expires_at: Math.floor(Date.now() / 1000) + 900,
      checkout: { payment_hash: paymentHash, amount_msats: 5_000_000 },
    },
  };
}

// The create-mode guards are double-POST guards, not tidiness: a second click
// while the first request is in flight mints a colliding attempt, and the
// loser's error then replaces a perfectly good deposit panel. This pins the
// swap-start half (the Lightning half is the double-click Bitcoin test above)
// and the prepare-once gate that has to survive the element re-rendering.
test("double-clicking a swap asset starts exactly one swap", async () => {
  const start = deferred();
  const paymentHash = "c".repeat(64);
  const fetchStub = createFetchStub({
    "/checkouts/prepare": () => prepareBodyWithSwapAsset("order-swap-1", "SOL_SOL"),
    "/swaps": () => start.promise,
    "/payments/check": () => ({ status: "pending" }),
  });
  globalThis.fetch = fetchStub;
  const element = mount({ reference: "order-swap-1", prefix: "/openreceive" });

  try {
    const asset = await until(
      () => element.shadowRoot?.querySelector('[data-or-swap-start="SOL_SOL"]'),
      { label: "SOL swap-start button" },
    );
    asset.click();
    // The DOM half of the guard: the clicked button marks itself busy.
    assert.equal(asset.disabled, true);
    // The state half: a poll-driven re-render hands the payer a fresh, enabled
    // button while the first start is still in flight. Clicking that one must
    // not mint a second attempt — the loser's 409 would then replace a good
    // deposit panel with an error.
    asset.disabled = false;
    asset.click();
    await flush(2);
    assert.equal(
      fetchStub.pathCount("/swaps"),
      1,
      "a second click must not POST a second swap start",
    );

    start.resolve(swapStartBody("SOL_SOL", paymentHash));
    await until(() => element.shadowRoot?.innerHTML.includes("SoLDeposit"), {
      label: "deposit panel",
    });
    assert.equal(fetchStub.pathCount("/swaps"), 1);
    assert.doesNotMatch(
      element.shadowRoot?.innerHTML ?? "",
      /Could not prepare the payment address/,
    );
    // Prepare stays a once-per-reference gate across all of that re-rendering.
    assert.equal(fetchStub.pathCount("/checkouts/prepare"), 1);
  } finally {
    element.remove();
  }
});

// The other half of the swap's double-POST story, and the one the in-flight
// test above cannot reach: the start has COMPLETED, so `startingSwapAsset` is
// null again. The payer holding SOL's deposit address breadcrumbs back to the
// grid and picks SOL again. What stops that click from minting a second,
// colliding attempt — and stranding the coins already sent to the first
// address — is the "already holding this asset's deposit instructions"
// short-circuit in the shared session's startSwap. The breadcrumb deliberately
// does not dismiss the attempt (only "back to Lightning" out of the deposit
// panel does), so the attempt is still the payer's to pay.
test("re-selecting a started swap asset re-opens its panel without a second start", async () => {
  const paymentHash = "e".repeat(64);
  const fetchStub = createFetchStub({
    "/checkouts/prepare": () => prepareBodyWithSwapAsset("order-swap-reselect", "SOL_SOL"),
    "/swaps": () => swapStartBody("SOL_SOL", paymentHash),
    "/payments/check": () => ({ status: "pending" }),
  });
  globalThis.fetch = fetchStub;
  const element = mount({ reference: "order-swap-reselect", prefix: "/openreceive" });

  try {
    const asset = await until(
      () => element.shadowRoot?.querySelector('[data-or-swap-start="SOL_SOL"]'),
      { label: "SOL swap-start button" },
    );
    asset.click();
    await until(() => element.shadowRoot?.innerHTML.includes("SoLDeposit"), {
      label: "deposit panel",
    });
    assert.equal(fetchStub.pathCount("/swaps"), 1);

    const breadcrumb = await until(
      () => element.shadowRoot?.querySelector('[data-or-breadcrumb="swap-asset"]'),
      { label: "swap breadcrumb" },
    );
    breadcrumb.click();
    const again = await until(
      () => element.shadowRoot?.querySelector('[data-or-swap-start="SOL_SOL"]'),
      { label: "asset grid again" },
    );
    again.click();
    await flush(4);
    assert.equal(
      fetchStub.pathCount("/swaps"),
      1,
      "an asset whose deposit instructions the payer already holds must not POST a second start",
    );
    // The short-circuit is not a silent no-op: it re-selects the asset, so the
    // payer lands back on the address they were already given.
    assert.match(
      element.shadowRoot?.innerHTML ?? "",
      /SoLDeposit/,
      "the payer is shown the instructions they already hold",
    );
    assert.doesNotMatch(
      element.shadowRoot?.innerHTML ?? "",
      /Could not prepare the payment address/,
    );
  } finally {
    element.remove();
  }
});

// Attributes the element writes back to itself must not re-enter
// attributeChangedCallback — the guard is a depth counter, so a nested apply
// (a status write while a create-mode attribute apply is still unwinding) must
// not open the gate early.
test("attributes the element writes never re-enter its own callback", async () => {
  const fetchStub = createFetchStub({
    "/checkouts/prepare": () => prepareBody("order-reentry", 21_000),
    "/payments/check": () => ({ status: "pending" }),
  });
  globalThis.fetch = fetchStub;
  const element = mount({ reference: "order-reentry", prefix: "/openreceive" });

  try {
    await until(() => element.getAttribute("amount-msats") === "21000", {
      label: "create-mode attributes",
    });
    await flush(6);
    assert.equal(
      fetchStub.pathCount("/checkouts/prepare"),
      1,
      "self-written attributes must not re-run prepare",
    );
    const checksAfterCreate = fetchStub.pathCount("/payments/check");

    // A status attribute the element owns, written by hand, is indistinguishable
    // from one the element wrote: it must re-render without restarting the poll.
    element.setAttribute("theme", "dark");
    await flush(6);
    assert.equal(fetchStub.pathCount("/checkouts/prepare"), 1);
    assert.equal(
      fetchStub.pathCount("/payments/check"),
      checksAfterCreate,
      "a cosmetic attribute must not fire another status request",
    );
  } finally {
    element.remove();
  }
});

test("amount-msats renders on the settled screen and a non-number carries no amount", async () => {
  // `createOpenReceiveCheckoutElementAttributes` writes `amount-msats` from a
  // checkout snapshot; readElementAmountMsats reads it leniently so create
  // mode can omit it — an attribute that is no number at all simply carries no
  // amount rather than rendering NaN.
  const fetchStub = createFetchStub({
    "/payments/check": () => ({ status: "settled", paid_at: Math.floor(Date.now() / 1000) }),
  });
  globalThis.fetch = fetchStub;
  const paymentHash = "f".repeat(64);
  const element = mount({
    reference: "order-good-amount",
    prefix: "/openreceive",
    "invoice-id": paymentHash,
    invoice: `lnbc-${paymentHash}`,
    "payment-hash": paymentHash,
    "amount-msats": "21000",
    status: "settled",
  });

  try {
    await flush(4);
    assert.match(element.shadowRoot?.innerHTML ?? "", /21 sats \(21000 msats\)/);

    element.setAttribute("amount-msats", "not-a-number");
    await flush(4);
    const junk = element.shadowRoot?.innerHTML ?? "";
    assert.match(junk, /<section part="root"/);
    assert.doesNotMatch(junk, /NaN/);
  } finally {
    element.remove();
  }
});

test("a missing or non-numeric expires-at costs the countdown, not the element", async () => {
  // Create mode legitimately omits `expires-at`, so readElementExpiresAt reads
  // it leniently: missing, empty, or no number at all answers undefined rather
  // than throwing inside render().
  const fetchStub = createFetchStub({
    "/payments/check": () => ({ status: "pending" }),
  });
  globalThis.fetch = fetchStub;
  const paymentHash = "c".repeat(64);
  const element = mount({
    reference: "order-no-expiry",
    prefix: "/openreceive",
    "invoice-id": paymentHash,
    invoice: `lnbc-${paymentHash}`,
    "payment-hash": paymentHash,
    "amount-msats": "21000",
    "expires-at": "not-a-number",
  });

  try {
    await flush(4);
    const html = element.shadowRoot?.innerHTML ?? "";
    assert.match(html, /<section part="root"/, "the element must still render");
    assert.match(html, /21 sats/, "the amount must survive");
    assert.doesNotMatch(html, /Invoice expires in/, "no countdown row");
    // currentCheckoutSnapshot() reads the same attribute on the poll path, so a
    // rendered screen is not proof on its own: polling must survive it too.
    await until(() => fetchStub.pathCount("/payments/check") > 0, {
      label: "status request without a usable expires-at",
    });
  } finally {
    element.remove();
  }
});

test("an expires-at already in the past still reaches the expired screen", async () => {
  // A past deadline is the expired screen's whole input. Sibling of the
  // renderCheckoutHtml case in tests/elements.test.mjs, on the ATTRIBUTE path.
  globalThis.fetch = createFetchStub({
    "/payments/check": () => ({ status: "pending" }),
  });
  const paymentHash = "b".repeat(64);
  const element = mount({
    reference: "order-past-expiry",
    prefix: "/openreceive",
    "invoice-id": paymentHash,
    invoice: `lnbc-${paymentHash}`,
    "payment-hash": paymentHash,
    "amount-msats": "21000",
    "expires-at": String(Math.floor(Date.now() / 1000) - 1),
  });

  try {
    await flush(4);
    const html = element.shadowRoot?.innerHTML ?? "";
    assert.match(html, /Invoice expired/);
    assert.doesNotMatch(html, /Invoice expires in/);
    assert.doesNotMatch(html, /Waiting for payment/);

    // A deadline a year old is just as expired: the past side has no horizon.
    element.setAttribute("expires-at", String(Math.floor(Date.now() / 1000) - 400 * 24 * 60 * 60));
    await flush(4);
    assert.match(element.shadowRoot?.innerHTML ?? "", /Invoice expired/);
  } finally {
    element.remove();
  }
});

test("a legitimate expires-at still drives the countdown", async () => {
  // The other half of the rule: leniency must not cost the feature. A real
  // expiry still produces a real countdown, ticking down from ~15:00.
  const fetchStub = createFetchStub({
    "/payments/check": () => ({ status: "pending" }),
  });
  globalThis.fetch = fetchStub;
  const paymentHash = "d".repeat(64);
  const element = mount({
    reference: "order-good-expiry",
    prefix: "/openreceive",
    "invoice-id": paymentHash,
    invoice: `lnbc-${paymentHash}`,
    "payment-hash": paymentHash,
    "amount-msats": "21000",
    "expires-at": String(Math.floor(Date.now() / 1000) + 900),
  });

  try {
    const countdown = await until(
      () => element.shadowRoot?.querySelector('[part="countdown"] strong'),
      { label: "countdown" },
    );
    assert.match(element.shadowRoot?.innerHTML ?? "", /Invoice expires in/);
    assert.match(countdown.textContent ?? "", /^1[45]:\d\d$/);
  } finally {
    element.remove();
  }
});

// The third server-written attribute, and the one that is not a label.
// `createCheckoutElementAttributes` writes `invoice-id` straight from
// `invoice.invoice_id`, so an empty one threw TypeError from inside render() —
// after `prepareShadowRoot()` had already cleared it — and the payer was left
// looking at an empty shadow root while the host heard nothing at all.
test("a hostile invoice-id costs the payment screen, not the shadow root", async () => {
  for (const hostile of ["", " ", "\t\n"]) {
    const fetchStub = createFetchStub({
      "/payments/check": () => ({ status: "pending" }),
    });
    globalThis.fetch = fetchStub;
    const element = document.createElement("openreceive-checkout");
    const errors = [];
    element.addEventListener("openreceive-error", (event) => errors.push(event.detail.error));
    for (const [name, value] of Object.entries({
      reference: "order-unidentified",
      prefix: "/openreceive",
      invoice: `lnbc-${"a".repeat(64)}`,
      "amount-msats": "21000",
      "invoice-id": hostile,
    })) {
      element.setAttribute(name, value);
    }

    try {
      // Mounting must not throw: this is the line that used to.
      document.body.appendChild(element);
      await flush(4);

      const label = `invoice-id ${JSON.stringify(hostile)}`;
      const html = element.shadowRoot?.innerHTML ?? "";
      assert.notEqual(html, "", `${label} left an empty shadow root`);
      assert.match(html, /<section part="root"/, `${label} rendered no root section`);

      // The element's own failure panel, not a new one invented for this case.
      assert.match(html, /data-openreceive-create-error/, `${label} skipped the failure panel`);
      assert.match(html, /role="alert"/);
      assert.match(html, /invoice-id is empty/);

      // No QR: an attempt this element cannot identify is one it can never
      // confirm, so it must not show a payable invoice and then go quiet.
      assert.doesNotMatch(html, /part="qr"/, `${label} showed an untrackable QR`);
      // ...and no retry button, because only the host can replace the attribute.
      assert.doesNotMatch(html, /part="retry"/, `${label} offered a dead retry`);

      // The host's half of the signal, on the channel every other element
      // failure already uses.
      assert.equal(errors.length, 1, `${label} dispatched ${errors.length} error events`);
      assert.match(String(errors[0]?.message), /invoice-id is empty/);

      // And it does not poll an attempt it has no id for.
      assert.equal(fetchStub.pathCount("/payments/check"), 0, `${label} polled anyway`);

      // Recovery: the panel is a verdict on the attribute, not a latch. A real
      // id brings back the payment screen AND the poll it suppressed — the
      // element must not be left permanently silent by one bad render.
      element.setAttribute("invoice-id", "b".repeat(64));
      await flush(4);
      const healed = element.shadowRoot?.innerHTML ?? "";
      assert.doesNotMatch(healed, /data-openreceive-create-error/, `${label} stayed failed`);
      assert.match(healed, /part="qr"/);
      assert.match(healed, /Bitcoin Lightning invoice/);
      assert.match(healed, /21 sats/);
      assert.ok(
        fetchStub.pathCount("/payments/check") > 0,
        `${label} never resumed polling after recovery`,
      );
    } finally {
      element.remove();
    }
  }
});

function prepareBodyWithSwapAssets(reference, assets) {
  return {
    reference: reference,
    amount_msats: 5_000_000,
    payment_methods: assets.map(([payInAsset, networkLabel]) => ({
      pay_in_asset: payInAsset,
      label: payInAsset.split("_")[0],
      network_label: networkLabel,
      provider: "fixedfloat",
      available: true,
    })),
  };
}

// PRODUCT CHANGE (G6b): the retry button used to leave its own error on screen
// while the retried request was in flight, because the element cleared
// `swapStartError` only after the re-render. The payer's click looked ignored.
// React always cleared it first; the merged flow keeps React's order.
test("retrying a failed swap start replaces the error with the preparing spinner", async () => {
  const retry = deferred();
  let starts = 0;
  const fetchStub = createFetchStub({
    "/checkouts/prepare": () => prepareBodyWithSwapAsset("order-swap-retry", "SOL_SOL"),
    "/swaps": () => {
      starts += 1;
      if (starts === 1) throw new Error("Swap provider is unavailable.");
      return retry.promise;
    },
    "/payments/check": () => ({ status: "pending" }),
  });
  globalThis.fetch = fetchStub;
  const element = mount({ reference: "order-swap-retry", prefix: "/openreceive" });

  try {
    const asset = await until(
      () => element.shadowRoot?.querySelector('[data-or-swap-start="SOL_SOL"]'),
      { label: "SOL swap-start button" },
    );
    asset.click();
    await until(() => element.shadowRoot?.innerHTML.includes("Swap provider is unavailable."), {
      label: "inline swap-start failure",
    });
    const tryAgain = await until(() => element.shadowRoot?.querySelector('[part="swap-retry"]'), {
      label: "retry button",
    });
    tryAgain.click();
    await flush(2);
    const html = element.shadowRoot?.innerHTML ?? "";
    assert.match(html, /Preparing payment address/);
    assert.doesNotMatch(html, /Could not prepare the payment address/);
    assert.equal(starts, 2);

    // Settle the retry inside the test: a start that lands after the element is
    // gone re-keys a poll controller onto a detached element and the process
    // never exits.
    retry.resolve(swapStartBody("SOL_SOL", "d".repeat(64)));
    await until(() => element.shadowRoot?.innerHTML.includes("SoLDeposit"), {
      label: "deposit panel after retry",
    });
  } finally {
    element.remove();
  }
});

// PRODUCT CHANGE (G6b): the "a start that lost a race must not replace a good
// deposit panel with the loser's error" recovery was not scoped to the asset
// being started. Any previously started swap satisfied it, so a failed start
// for a SECOND coin silently reopened the FIRST coin's panel and ate the error.
// The recovery now only fires for the same, undismissed attempt.
test("a failed start for a second coin does not reopen the first coin's panel", async () => {
  let starts = 0;
  const fetchStub = createFetchStub({
    "/checkouts/prepare": () =>
      prepareBodyWithSwapAssets("order-two-coins", [
        ["SOL_SOL", "Solana"],
        ["ETH_ETH", "Ethereum"],
      ]),
    "/swaps": (body) => {
      starts += 1;
      if (body.pay_in_asset === "SOL_SOL") return swapStartBody("SOL_SOL", "e".repeat(64));
      throw new Error("Swap provider is unavailable.");
    },
    "/checkouts": () => checkoutBody("order-two-coins", 5_000_000, "f".repeat(64)),
    "/payments/check": () => ({ status: "pending" }),
  });
  globalThis.fetch = fetchStub;
  const element = mount({ reference: "order-two-coins", prefix: "/openreceive" });

  try {
    const sol = await until(
      () => element.shadowRoot?.querySelector('[data-or-swap-start="SOL_SOL"]'),
      { label: "SOL swap-start button" },
    );
    sol.click();
    await until(() => element.shadowRoot?.innerHTML.includes("SoLDeposit"), {
      label: "SOL deposit panel",
    });
    const back = await until(
      () => element.shadowRoot?.querySelector('[data-or-breadcrumb="swap-asset"]'),
      { label: "switch-payment-method breadcrumb" },
    );
    back.click();
    const eth = await until(
      () => element.shadowRoot?.querySelector('[data-or-swap-start="ETH_ETH"]'),
      { label: "ETH swap-start button" },
    );
    eth.click();
    await until(() => element.shadowRoot?.innerHTML.includes("Swap provider is unavailable."), {
      label: "ETH swap-start failure",
    });
    assert.equal(starts, 2);
    assert.doesNotMatch(
      element.shadowRoot?.innerHTML ?? "",
      /SoLDeposit/,
      "the first coin's deposit panel must not stand in for the second coin's failure",
    );
  } finally {
    element.remove();
  }
});
