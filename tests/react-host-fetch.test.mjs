// <Checkout fetch> carries every request the checkout makes, not only the
// create calls. A single-page app whose session is a bearer token (supabase-js
// keeps it in localStorage) has no cookie for `authorize` to read: one request
// sent with the page's plain fetch is a 403 the payer sees as a broken
// checkout. So the stack below refuses any request without the token, and the
// page's global fetch carries none.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://harness.local/" });

process.env.LOG_LEVEL ??= "error";

const assert = (await import("node:assert/strict")).default;
const test = (await import("node:test")).default;
const { createLifecycleStack, installFastTimers, until } = await import(
  "./helpers/lifecycle-harness.mjs"
);
const React = (await import("react")).default;
const { createRoot } = await import("react-dom/client");
const { requestCheckout } = await import("../packages/js/browser/src/headless.ts");
const { Checkout } = await import("../packages/js/react/src/index.ts");
const { checkoutLabels } = await import("../packages/js/browser/src/headless.ts");

const TOKEN = "Bearer buyer-token";
const originalGlobalFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = originalGlobalFetch;
});

async function tokenStack() {
  const stack = await createLifecycleStack({
    authorize: ({ request }) => request.headers.get("authorization") === TOKEN,
  });
  // Anything that bypasses the host's fetch reaches the stack without a token.
  globalThis.fetch = stack.fetchStub;
  const tokenFetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", TOKEN);
    return stack.fetchStub(input, { ...init, headers });
  };
  const paths = () => stack.requests.map((entry) => `${entry.method} ${entry.path}`);
  const refused = () => stack.requests.filter((entry) => entry.status === 403);
  return { stack, tokenFetch, paths, refused };
}

function mount(element) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(element);
  return {
    text: () => container.textContent ?? "",
    button: (label) =>
      [...container.querySelectorAll("button")].find((candidate) =>
        (candidate.textContent ?? "").replace(/\s+/g, " ").trim().startsWith(label),
      ),
    unmount() {
      root.unmount();
      container.remove();
    },
  };
}

test("create mode sends prepare, the mint and the status poll through the host's fetch", async () => {
  const { stack, tokenFetch, paths, refused } = await tokenStack();
  stack.addOrder("order-token-ln", 2000);
  const restoreTimers = installFastTimers();
  const handle = mount(
    React.createElement(Checkout, { reference: "order-token-ln", fetch: tokenFetch }),
  );
  try {
    (await until(() => handle.button("Bitcoin"), { label: "method grid" })).click();
    await until(() => handle.button(checkoutLabels.copyInvoice), { label: "minted invoice" });
    await until(
      () => stack.checkCalls().some((entry) => typeof entry.body?.payment_hash === "string"),
      { label: "a status poll for the minted invoice" },
    );
    assert.ok(paths().includes("POST /openreceive/checkouts/prepare"), paths().join("\n"));
    assert.ok(paths().includes("POST /openreceive/checkouts"), paths().join("\n"));
    assert.deepEqual(refused(), [], "every request must carry the host's token");
  } finally {
    handle.unmount();
    restoreTimers();
    await stack.close();
  }
});

test("the swap quote, start and status poll go through the host's fetch", async () => {
  const { stack, tokenFetch, paths, refused } = await tokenStack();
  stack.addOrder("order-token-swap", 2000);
  const restoreTimers = installFastTimers();
  const handle = mount(
    React.createElement(Checkout, { reference: "order-token-swap", fetch: tokenFetch }),
  );
  try {
    (await until(() => handle.button("SOL"), { label: "SOL tile" })).click();
    await until(() => paths().includes("POST /openreceive/swaps"), { label: "swap start" });
    await until(() => paths().includes("POST /openreceive/swaps/status"), {
      label: "swap status poll",
    });
    assert.ok(paths().includes("POST /openreceive/swaps/quote"), paths().join("\n"));
    assert.deepEqual(refused(), [], "every request must carry the host's token");
  } finally {
    handle.unmount();
    restoreTimers();
    await stack.close();
  }
});

test("snapshot mode polls through the host's fetch", async () => {
  const { stack, tokenFetch, refused } = await tokenStack();
  stack.addOrder("order-token-snapshot", 2000);
  const checkout = await requestCheckout({
    prefix: "/openreceive",
    reference: "order-token-snapshot",
    fetch: tokenFetch,
  });
  const before = stack.checkCalls().length;
  const handle = mount(
    React.createElement(Checkout, { checkout, fetch: tokenFetch, paymentWizard: false }),
  );
  try {
    await until(() => stack.checkCalls().length > before, { label: "status poll" });
    assert.deepEqual(refused(), [], "the poll must carry the host's token");
  } finally {
    handle.unmount();
    await stack.close();
  }
});

test("createFetch, the old name, now carries the poll too", async () => {
  const { stack, tokenFetch, refused } = await tokenStack();
  stack.addOrder("order-token-legacy", 2000);
  const restoreTimers = installFastTimers();
  const handle = mount(
    React.createElement(Checkout, { reference: "order-token-legacy", createFetch: tokenFetch }),
  );
  try {
    (await until(() => handle.button("Bitcoin"), { label: "method grid" })).click();
    await until(
      () => stack.checkCalls().some((entry) => typeof entry.body?.payment_hash === "string"),
      { label: "a status poll for the minted invoice" },
    );
    assert.deepEqual(refused(), [], "every request must carry the host's token");
  } finally {
    handle.unmount();
    restoreTimers();
    await stack.close();
  }
});

test("without a host fetch the token-only stack refuses the checkout", async () => {
  // The control: the same page with no `fetch` prop is refused, so the passes
  // above are the prop's doing, not a stack that lets everything through.
  const { stack, refused } = await tokenStack();
  stack.addOrder("order-no-token", 2000);
  const handle = mount(
    React.createElement(Checkout, { reference: "order-no-token", onError: () => {} }),
  );
  try {
    await until(() => handle.text().includes("Could not start checkout."), {
      label: "the refused prepare",
    });
    assert.ok(refused().length > 0);
  } finally {
    handle.unmount();
    await stack.close();
  }
});
