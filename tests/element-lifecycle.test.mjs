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
const { defineOpenReceiveElements } = await import("../packages/js/elements/src/index.ts");

const qrRequests = [];
const qrEncoder = {
  toString(payload) {
    return new Promise((resolve) => {
      qrRequests.push({ payload, resolve });
    });
  },
};

defineOpenReceiveElements({ qrEncoder, logger: false });

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

function prepareBody(orderId, amountMsats) {
  return {
    order_id: orderId,
    amount_msats: amountMsats,
    payment_methods: [],
  };
}

function checkoutBody(orderId, amountMsats, paymentHash) {
  return {
    checkout: {
      order_id: orderId,
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
  const element = mount({ "order-id": "order-1", prefix: "/openreceive" });

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

test("an order-id change mid-prepare wins over the request it superseded", async () => {
  const firstPrepare = deferred();
  const fetchStub = createFetchStub({
    "/checkouts/prepare": (body) =>
      body.order_id === "order-1" ? firstPrepare.promise : prepareBody("order-2", 2_000),
    "/payments/check": () => ({ status: "pending" }),
  });
  globalThis.fetch = fetchStub;
  const element = mount({ "order-id": "order-1", prefix: "/openreceive" });

  try {
    await until(() => fetchStub.pathCount("/checkouts/prepare") === 1, {
      label: "first prepare",
    });
    element.setAttribute("order-id", "order-2");
    // The first order's response lands after the swap; it must not be applied.
    firstPrepare.resolve(prepareBody("order-1", 1_000));

    await until(() => element.getAttribute("amount-msats") === "2000", {
      label: "order-2 attributes",
    });
    assert.equal(element.getAttribute("order-id"), "order-2");
    assert.equal(fetchStub.pathCount("/checkouts/prepare"), 2);
    assert.deepEqual(
      fetchStub.calls
        .filter((call) => call.path.endsWith("/payments/check"))
        .map((call) => call.body.order_id)
        .filter((orderId) => orderId !== "order-2"),
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
    "order-id": "order-3",
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
    "order-id": "order-4",
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
    "order-id": "order-5",
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
    "order-id": "order-theme-poll",
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
  const element = mount({ "order-id": "order-prepare-fail", prefix: "/openreceive" });

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
    "order-id": "order-no-poll",
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
function prepareBodyWithSwapAsset(orderId, payInAsset) {
  return {
    order_id: orderId,
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
  const element = mount({ "order-id": "order-swap-1", prefix: "/openreceive" });

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
    // Prepare stays a once-per-order gate across all of that re-rendering.
    assert.equal(fetchStub.pathCount("/checkouts/prepare"), 1);
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
  const element = mount({ "order-id": "order-reentry", prefix: "/openreceive" });

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

test("a nonsense amount-msats costs the amount label, not the element", async () => {
  // The host copies `amount-msats` straight out of a checkout snapshot
  // (createOpenReceiveCheckoutElementAttributes writes String(amount_msats)), so
  // this attribute carries SERVER data. It used to be read with the strict
  // integer parser, which threw inside render() and took the whole payment
  // screen down over a number the payer could do nothing about.
  const fetchStub = createFetchStub({
    "/payments/check": () => ({ status: "settled", paid_at: Math.floor(Date.now() / 1000) }),
  });
  globalThis.fetch = fetchStub;
  const paymentHash = "f".repeat(64);
  const element = mount({
    "order-id": "order-bad-amount",
    prefix: "/openreceive",
    "invoice-id": paymentHash,
    invoice: `lnbc-${paymentHash}`,
    "payment-hash": paymentHash,
    "amount-msats": "-1",
    status: "settled",
  });

  try {
    await flush(4);
    const html = element.shadowRoot?.innerHTML ?? "";
    assert.match(html, /<section part="root"/, "the element must still render");
    // The formatted amount is gone; the raw value is still reported.
    assert.doesNotMatch(html, /-1 msats/);
    assert.match(html, /Amount \(msats\)/);
    assert.match(html, />-1</);

    // An attribute that is no number at all is dropped rather than shown.
    element.setAttribute("amount-msats", "not-a-number");
    await flush(4);
    const junk = element.shadowRoot?.innerHTML ?? "";
    assert.match(junk, /<section part="root"/);
    assert.doesNotMatch(junk, /NaN/);
  } finally {
    element.remove();
  }

  // The rule must not blank a GOOD amount on this rail: same element, same
  // settled screen, a legitimate value.
  const good = mount({
    "order-id": "order-good-amount",
    prefix: "/openreceive",
    "invoice-id": paymentHash,
    invoice: `lnbc-${paymentHash}`,
    "payment-hash": paymentHash,
    "amount-msats": "21000",
    status: "settled",
  });
  try {
    await flush(4);
    assert.match(good.shadowRoot?.innerHTML ?? "", /21 sats \(21000 msats\)/);
  } finally {
    good.remove();
  }
});
