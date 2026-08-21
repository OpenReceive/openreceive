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
