// P1/P2/P3: full-loop lifecycle tests. Real browser components (React and the custom
// element, both modes) run against the real HTTP handler, the real SQL repository on
// in-memory SQLite, and the testkit fake wallet + fake swap provider. The scenario the
// existing fixture tests could never cover: a payer selects USDT, the swap starts, the
// status poll re-keys onto the swap payment hash, the shadow invoice settles, and the
// settled event plus the paid panel reach the payer (H1/H2 regression coverage).
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://harness.local/" });

const assert = (await import("node:assert/strict")).default;
const test = (await import("node:test")).default;
const { createLifecycleStack, installFastTimers, until } = await import(
  "./helpers/lifecycle-harness.mjs"
);
// Imported after DOM registration: these packages touch window/document at class-definition time.
const React = (await import("react")).default;
const { createRoot } = await import("react-dom/client");
const { Checkout } = await import("../packages/js/react/src/index.ts");
const { prepareCheckout } = await import("../packages/js/browser/src/index.ts");
const elements = await import("../packages/js/elements/src/index.ts");

// Kept and used: leaving the clamped timers installed after the suite leaks a patched
// global into every later file in the same process.
const restoreTimers = installFastTimers();
test.after(restoreTimers);
elements.defineOpenReceiveElements();

const TESTKIT_TRON_DEPOSIT_ADDRESS = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";
const PAID_PANEL_PATTERN = /Payment (complete|received)/;

/** Let `ticks` clamped poll intervals elapse (installFastTimers caps delays). */
async function settle(ticks) {
  for (let index = 0; index < ticks; index += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

function setInputValue(input, value) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  descriptor?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function findRefundAddressInput(root) {
  return (
    [...root.querySelectorAll("input")].find(
      (el) =>
        el instanceof HTMLInputElement &&
        el.type !== "hidden" &&
        (el.name === "refund_address" ||
          el.hasAttribute("data-or-swap-refund-address") ||
          /refund address/i.test(el.placeholder)),
    ) ?? null
  );
}

async function createCheckoutViaHandler(stack, orderId) {
  const response = await stack.fetchStub("/openreceive/checkouts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ order_id: orderId }),
  });
  assert.equal(response.status, 201);
  return (await response.json()).checkout;
}

function elementSurface(mode) {
  return {
    name: `element-${mode}`,
    async mount(stack, orderId) {
      const el = document.createElement("openreceive-checkout");
      let settledCount = 0;
      let terminal = false;
      el.addEventListener("openreceive-settled", () => {
        settledCount += 1;
      });
      // The watcher stops itself on a terminal state and announces it here, so tests
      // can wait for "polling stopped" instead of for a stretch of wall clock.
      el.addEventListener("openreceive-state", (event) => {
        if (event.detail?.state?.terminal === true) terminal = true;
      });
      if (mode === "snapshot") {
        const created = await createCheckoutViaHandler(stack, orderId);
        el.setAttribute("invoice-id", created.payment_hash);
        el.setAttribute("invoice", created.bolt11);
        el.setAttribute("payment-hash", created.payment_hash);
        el.setAttribute("amount-msats", String(created.amount_msats));
        el.setAttribute("expires-at", String(created.expires_at));
      }
      el.setAttribute("order-id", orderId);
      if (mode === "snapshot") {
        // Snapshot mode opts into status polling by passing the mount prefix,
        // exactly like React snapshot mode.
        el.setAttribute("prefix", "/openreceive");
      }
      document.body.appendChild(el);
      const root = () => el.shadowRoot ?? el;
      return {
        root,
        settled: () => settledCount,
        terminal: () => terminal,
        text: () => root().textContent ?? "",
        html: () => root().innerHTML,
        async selectUsdtTron() {
          const picker = await until(
            () => root().querySelector('[data-or-picker-select="swap:USDT"]'),
            { label: `${this.name} USDT picker` },
          );
          picker.click();
          const network = await until(
            () => root().querySelector('[data-or-swap-network-value="USDT_TRON"]'),
            { label: `${this.name} Tron network button` },
          );
          network.click();
          const cont = await until(() => root().querySelector("[data-or-picker-continue]"), {
            label: `${this.name} continue button`,
          });
          cont.click();
        },
        unmount() {
          el.remove();
        },
      };
    },
  };
}

function reactSurface(mode) {
  return {
    name: `react-${mode}`,
    async mount(stack, orderId) {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      let settledCount = 0;
      const onSettled = () => {
        settledCount += 1;
      };
      if (mode === "snapshot") {
        const snapshot = await prepareCheckout({
          orderId,
          prefix: "/openreceive",
          fetch: stack.fetchStub,
        });
        root.render(
          React.createElement(Checkout, {
            checkout: snapshot,
            prefix: "/openreceive",
            onSettled,
          }),
        );
      } else {
        root.render(React.createElement(Checkout, { orderId, onSettled }));
      }
      const findButton = (text) =>
        [...container.querySelectorAll("button")].find((button) =>
          button.textContent.replace(/\s+/g, " ").trim().startsWith(text),
        );
      return {
        root: () => container,
        settled: () => settledCount,
        text: () => container.textContent ?? "",
        html: () => container.innerHTML,
        async selectUsdtTron() {
          const picker = await until(() => findButton("USDT"), {
            label: `${this.name} USDT picker`,
          });
          picker.click();
          const network = await until(
            () =>
              [...container.querySelectorAll("button")].find((button) =>
                /Tron/i.test(button.textContent),
              ),
            { label: `${this.name} Tron network button` },
          );
          network.click();
          const cont = await until(() => findButton("Continue"), {
            label: `${this.name} continue button`,
          });
          cont.click();
        },
        unmount() {
          root.unmount();
          container.remove();
        },
      };
    },
  };
}

const SURFACES = [
  reactSurface("create"),
  reactSurface("snapshot"),
  elementSurface("create"),
  elementSurface("snapshot"),
];

// P2: the one parametrized lifecycle scenario, run identically across all four surfaces.
for (const surface of SURFACES) {
  test(`${surface.name}: USDT swap start re-keys polling and settlement reaches the payer`, async () => {
    const stack = await createLifecycleStack();
    globalThis.fetch = stack.fetchStub;
    stack.addOrder("order-1", 2000);
    const handle = await surface.mount(stack, "order-1");
    try {
      await handle.selectUsdtTron();

      // Swap started against the real handler and the deposit address reached the UI.
      await until(() => handle.html().includes(TESTKIT_TRON_DEPOSIT_ADDRESS), {
        label: `${surface.name} deposit address`,
      });
      const swapCreate = stack.requests.find(
        (entry) => entry.method === "POST" && entry.path === "/openreceive/swaps",
      );
      assert.equal(swapCreate?.status, 201);

      // The status poll must carry the swap's shadow-invoice hash (H1: snapshot modes
      // used to keep polling the stale pre-swap hash, or nothing at all).
      const swapHash = stack.wallet.listInvoices().at(-1)?.payment_hash;
      assert.ok(swapHash, "swap start must mint a shadow invoice in the wallet");
      await until(() => stack.checkCalls().some((call) => call.body?.payment_hash === swapHash), {
        label: `${surface.name} poll with swap payment_hash`,
      });

      // Settle the shadow invoice in the fake wallet; the poll settles the repository
      // row, runs the host's onPaid, and the settled event + paid panel reach the payer.
      stack.wallet.settleInvoice({ payment_hash: swapHash });
      await until(() => handle.settled() > 0, { label: `${surface.name} settled callback` });
      await until(() => PAID_PANEL_PATTERN.test(handle.text()), {
        label: `${surface.name} paid panel`,
      });
      assert.deepEqual(
        stack.settlements.map((settlement) => settlement.orderId),
        ["order-1"],
      );
      const lastCheck = stack.checkCalls().at(-1);
      assert.equal(lastCheck.body?.payment_hash, swapHash);
    } finally {
      handle.unmount();
      await stack.close();
    }
  });
}

// P3: reachability, not fixtures — every state below is REACHED by driving the real
// controller from wire responses, never injected as a pre-built render input.
for (const surface of [elementSurface("create"), reactSurface("create")]) {
  test(`${surface.name}: refund_required reaches the refund UI`, async () => {
    const stack = await createLifecycleStack();
    globalThis.fetch = stack.fetchStub;
    stack.addOrder("order-1", 2000);
    const handle = await surface.mount(stack, "order-1");
    try {
      await handle.selectUsdtTron();
      await until(() => handle.html().includes(TESTKIT_TRON_DEPOSIT_ADDRESS), {
        label: `${surface.name} deposit address`,
      });
      stack.swapProvider.forceRefundRequired("USDT_TRON");
      await until(() => handle.text().includes("Refund needed"), {
        label: `${surface.name} refund panel`,
      });
      // The payer must get an actionable form, not just a label.
      const input = await until(() => findRefundAddressInput(handle.root()), {
        label: `${surface.name} refund address input`,
      });
      assert.ok(handle.text().includes("Bookmark this page"));

      const refundAddress = TESTKIT_TRON_DEPOSIT_ADDRESS;
      setInputValue(input, refundAddress);
      const checksBefore = stack.checkCalls().length;
      await until(() => stack.checkCalls().length >= checksBefore + 2, {
        label: `${surface.name} polls after typing refund address`,
      });
      const still = findRefundAddressInput(handle.root());
      assert.ok(still instanceof HTMLInputElement);
      assert.equal(still.value, refundAddress);

      const review = [...handle.root().querySelectorAll("button")].find((button) =>
        (button.textContent ?? "").includes("Review refund address"),
      );
      assert.ok(review, `${surface.name} Review refund address button`);
      assert.equal(review.disabled, false);
      review.click();
      await until(() => (handle.text().includes("Confirm refund to") ? true : null), {
        label: `${surface.name} confirm refund address`,
      });
      assert.ok(handle.text().includes(refundAddress));
    } finally {
      handle.unmount();
      await stack.close();
    }
  });
}

test("element-create: live provider progress states reach the UI", async () => {
  const stack = await createLifecycleStack();
  globalThis.fetch = stack.fetchStub;
  stack.addOrder("order-1", 2000);
  const handle = await elementSurface("create").mount(stack, "order-1");
  try {
    await handle.selectUsdtTron();
    await until(() => handle.html().includes(TESTKIT_TRON_DEPOSIT_ADDRESS), {
      label: "deposit address",
    });
    // H2 regression: /swaps/status is polled live, so provider transitions appear.
    stack.swapProvider.script("USDT_TRON", ["confirming", "exchanging"]);
    await until(() => handle.text().includes("Confirming payment"), {
      label: "confirming state",
    });
    await until(() => handle.text().includes("Converting payment"), {
      label: "exchanging state",
    });
  } finally {
    handle.unmount();
    await stack.close();
  }
});

test("element-create: a completed refund is terminal and stops polling", async () => {
  const stack = await createLifecycleStack();
  globalThis.fetch = stack.fetchStub;
  stack.addOrder("order-1", 2000);
  const handle = await elementSurface("create").mount(stack, "order-1");
  try {
    await handle.selectUsdtTron();
    await until(() => handle.html().includes(TESTKIT_TRON_DEPOSIT_ADDRESS), {
      label: "deposit address",
    });
    stack.swapProvider.script("USDT_TRON", ["refund_pending", "refunded"]);
    await until(() => handle.text().includes("Refund pending"), {
      label: "refund pending state",
    });
    // refund_pending is not terminal: polling must continue to see "refunded".
    await until(() => handle.text().includes("Refunded"), { label: "refunded state" });

    // The refund is the end of this attempt: the shadow invoice will never be
    // paid, so neither the wallet check nor the provider read may continue. Wait for
    // the element's own terminal state rather than timing the request stream: a
    // count that happens to be stable for 250ms of wall clock proves nothing.
    await until(() => handle.terminal(), { label: "terminal checkout state" });
    const requestsAfterRefund = stack.requests.length;
    await settle(10);
    assert.equal(
      stack.requests.length,
      requestsAfterRefund,
      `polling continued after the refund: ${stack.requests
        .slice(requestsAfterRefund)
        .map((entry) => entry.path)
        .join(", ")}`,
    );
    // The refund screen stays on the page; only the polling stops.
    assert.ok(handle.text().includes("Refunded"));
  } finally {
    handle.unmount();
    await stack.close();
  }
});

test("element-create: the attention state reaches the UI", async () => {
  const stack = await createLifecycleStack();
  globalThis.fetch = stack.fetchStub;
  stack.addOrder("order-1", 2000);
  const handle = await elementSurface("create").mount(stack, "order-1");
  try {
    await handle.selectUsdtTron();
    await until(() => handle.html().includes(TESTKIT_TRON_DEPOSIT_ADDRESS), {
      label: "deposit address",
    });
    stack.swapProvider.forceAttention("USDT_TRON");
    await until(() => handle.text().includes("Needs attention"), {
      label: "attention state",
    });
  } finally {
    handle.unmount();
    await stack.close();
  }
});
