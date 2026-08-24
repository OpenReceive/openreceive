// Rendered-behavior coverage for the React checkout: the rules that used to be
// guarded by regex-matching the package source (dependency-array text), which passed
// while the behavior they described was broken.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://harness.local/" });

process.env.LOG_LEVEL ??= "error";

const assert = (await import("node:assert/strict")).default;
const test = (await import("node:test")).default;
const { createLifecycleStack, until } = await import("./helpers/lifecycle-harness.mjs");
const { invoice } = await import("./helpers/react-fixtures.mjs");
const React = (await import("react")).default;
const { createRoot } = await import("react-dom/client");
const { renderToStaticMarkup } = await import("react-dom/server");
const { Checkout, CheckoutProvider, InvoiceSummary, OpenWalletButton, ThemeScope } = await import(
  "../packages/js/react/src/index.ts"
);
const { useCheckoutSession } = await import("../packages/js/react/src/checkout-session.ts");
const { OPENRECEIVE_THEME_STORAGE_KEY, checkoutLabels } = await import(
  "../packages/js/browser/src/headless.ts"
);

// Several tests stub globalThis.fetch; restore the real one between tests so a
// stub never leaks past the test that installed it.
const originalGlobalFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = originalGlobalFetch;
});

function mount(element) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(element);
  return {
    container,
    text: () => container.textContent ?? "",
    buttons: () => [...container.querySelectorAll("button")],
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

/** Let React flush its passive effects (they are scheduled as a macrotask). */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("inline host callbacks do not restart the poll controller on every render", async () => {
  // The controller reloads state as soon as it is created. Keeping any of the
  // caller's callbacks (refreshStatus, logger, onError, onState, onSettled) in the
  // effect's dependency list therefore turned each parent render into another
  // teardown + status request, which is a request loop under any parent that
  // setStates from onState/onSettled. Every callback here is inline on purpose:
  // a new function identity on every render.
  let refreshCalls = 0;
  let renders = 0;
  const snapshot = invoice({ invoice_id: "or_inv_inline_refresh" });

  function Rerendering() {
    const [tick, setTick] = React.useState(0);
    renders += 1;
    React.useEffect(() => {
      if (tick < 10) setTick(tick + 1);
    });
    return React.createElement(CheckoutProvider, {
      checkout: snapshot,
      refreshStatus: async () => {
        refreshCalls += 1;
        return null;
      },
      logger: () => undefined,
      onError: () => undefined,
      onState: () => undefined,
      onSettled: () => undefined,
      children: () => null,
    });
  }

  const handle = mount(React.createElement(Rerendering));
  try {
    await until(() => renders > 10, { label: "parent re-renders" });
    await flush();
    assert.equal(
      refreshCalls,
      1,
      "the controller must be created once and reload state once, not once per render",
    );
  } finally {
    handle.unmount();
  }
});

test("polling: false starts no status requests while polling: true does", async () => {
  // Both mount in the same commit, so the enabled counter reaching 1 proves effects ran
  // and makes the disabled assertion deterministic instead of wall-clock.
  let enabledCalls = 0;
  let disabledCalls = 0;
  const handle = mount(
    React.createElement(
      React.Fragment,
      null,
      React.createElement(CheckoutProvider, {
        key: "enabled",
        checkout: invoice({ invoice_id: "or_inv_polling_on" }),
        refreshStatus: async () => {
          enabledCalls += 1;
          return null;
        },
        children: () => null,
      }),
      React.createElement(CheckoutProvider, {
        key: "disabled",
        checkout: invoice({ invoice_id: "or_inv_polling_off" }),
        polling: false,
        refreshStatus: async () => {
          disabledCalls += 1;
          return null;
        },
        children: () => null,
      }),
    ),
  );
  try {
    await until(() => enabledCalls > 0, { label: "status refresh with polling enabled" });
    assert.equal(disabledCalls, 0);
  } finally {
    handle.unmount();
  }
});

test("a bare snapshot Checkout polls status via the default prefix", async () => {
  // Parity with the element (docs/internal/wrapper-parity.md): `prefix` defaults to
  // /openreceive, so <Checkout checkout={snapshot}> with no prefix at all must still
  // poll. It used to derive its poll URL only when a prefix was supplied and silently
  // never polled.
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return new Response(JSON.stringify({ status: "pending" }), {
      headers: { "Content-Type": "application/json" },
    });
  };
  const handle = mount(
    React.createElement(Checkout, {
      checkout: invoice({ invoice_id: "or_inv_default_prefix_poll" }),
      paymentWizard: false,
      themeToggle: false,
    }),
  );
  try {
    await until(() => requests.some((url) => url.endsWith("/openreceive/payments/check")), {
      label: "status poll against the default prefix",
    });
  } finally {
    handle.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("the default checkout wires controller actions into its buttons", async () => {
  const written = [];
  const opened = [];
  const copied = [];
  const openedUris = [];
  let model;
  const handle = mount(
    React.createElement(CheckoutProvider, {
      checkout: invoice({ invoice_id: "or_inv_actions", invoice: "lnbc-actions" }),
      clipboard: { writeText: async (value) => void written.push(value) },
      open: (uri) => void opened.push(uri),
      onCopy: () => copied.push(true),
      onOpenWallet: (uri) => openedUris.push(uri),
      children: (checkout) => {
        model = checkout;
        return null;
      },
    }),
  );
  try {
    await until(() => model !== undefined, { label: "checkout model" });
    await model.copyInvoice();
    assert.deepEqual(written, ["lnbc-actions"]);
    assert.deepEqual(copied, [true]);
    const uri = model.openWallet();
    assert.equal(uri, "lightning:lnbc-actions");
    assert.deepEqual(opened, ["lightning:lnbc-actions"]);
    assert.deepEqual(openedUris, ["lightning:lnbc-actions"]);
  } finally {
    handle.unmount();
  }
});

test("copy feedback appears on click and resets itself", async (t) => {
  const snapshot = invoice({ invoice_id: "or_inv_copy_ui", invoice: "lnbc-copy-ui" });
  const written = [];
  const hadClipboard = globalThis.navigator.clipboard !== undefined;
  globalThis.navigator.clipboard ??= { writeText: async (value) => void written.push(value) };
  t.after(() => {
    if (!hadClipboard) delete globalThis.navigator.clipboard;
  });
  const handle = mount(React.createElement(Checkout, { checkout: snapshot, polling: false }));
  try {
    const copy = await until(() => handle.button(checkoutLabels.copyInvoice), {
      label: "copy button",
    });
    copy.click();
    await until(() => handle.text().includes(checkoutLabels.copied), {
      label: "copied feedback",
    });
    // The feedback is transient: it must clear itself without another click.
    await until(() => !handle.text().includes(checkoutLabels.copied), {
      label: "copied feedback reset",
    });
  } finally {
    handle.unmount();
  }
});

test("the default checkout ships no wallet button and renders the slot when supplied", () => {
  const snapshot = invoice({ invoice_id: "or_inv_wallet_slot", invoice: "lnbc-wallet-slot" });
  const withoutSlot = renderToStaticMarkup(React.createElement(Checkout, { checkout: snapshot }));
  assert.doesNotMatch(withoutSlot, /Open Wallet/);

  const withSlot = renderToStaticMarkup(
    React.createElement(Checkout, {
      checkout: snapshot,
      components: { OpenWalletButton },
      classNames: { openWalletButton: "host-wallet-button" },
    }),
  );
  assert.match(withSlot, /Open Wallet/);
  assert.match(withSlot, /host-wallet-button/);
});

test("the invoice summary renders the payment hash instead of leaking it as an attribute", () => {
  const html = renderToStaticMarkup(
    React.createElement(InvoiceSummary, {
      amountLabel: "200 sats",
      paymentHashLabel: "aaaaaaaa...aaaaaaaa",
      classNames: { paymentHash: "host-hash" },
    }),
  );

  assert.match(html, /aaaaaaaa\.\.\.aaaaaaaa/);
  assert.match(html, /host-hash/);
  assert.doesNotMatch(html, /paymentHashLabel=/i);
});

test("theme scope renders keyed children without React warnings", () => {
  const warnings = [];
  const originalError = console.error;
  console.error = (...args) => warnings.push(args.join(" "));
  try {
    renderToStaticMarkup(
      React.createElement(
        ThemeScope,
        { themeToggle: true },
        React.createElement("span", null, "scoped"),
      ),
    );
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(warnings, []);
});

test("a standalone checkout owns its theme toggle and flips data-theme", async () => {
  // Canonical default across the wrappers: themeToggle is on unless the host opts out.
  const snapshot = invoice({ invoice_id: "or_inv_theme_toggle", invoice: "lnbc-theme-toggle" });
  const handle = mount(React.createElement(Checkout, { checkout: snapshot, polling: false }));
  try {
    const toggle = await until(
      () => handle.container.querySelector("[data-openreceive-theme-toggle]"),
      { label: "theme toggle" },
    );
    assert.ok(handle.container.querySelector("[data-openreceive-theme='light']"));
    toggle.click();
    await until(() => handle.container.querySelector("[data-openreceive-theme='dark']") !== null, {
      label: "toggled theme",
    });
  } finally {
    handle.unmount();
    globalThis.localStorage.removeItem(OPENRECEIVE_THEME_STORAGE_KEY);
  }
});

test("the checkout theme survives hydration without a server/client mismatch", async () => {
  // Reading localStorage/matchMedia during the first render made SSR hosts hydrate a
  // different data-theme than they served.
  globalThis.localStorage.setItem(OPENRECEIVE_THEME_STORAGE_KEY, "dark");
  const snapshot = invoice({ invoice_id: "or_inv_theme_ssr", invoice: "lnbc-theme-ssr" });
  const element = React.createElement(Checkout, { checkout: snapshot, polling: false });
  const serverHtml = renderToStaticMarkup(element);
  assert.match(serverHtml, /data-openreceive-theme="light"/);

  const container = document.createElement("div");
  container.innerHTML = serverHtml;
  document.body.appendChild(container);
  const warnings = [];
  const originalError = console.error;
  console.error = (...args) => warnings.push(args.join(" "));
  const { hydrateRoot } = await import("react-dom/client");
  const root = hydrateRoot(container, element);
  try {
    await flush();
    assert.deepEqual(
      warnings.filter((entry) => /hydrat/i.test(entry)),
      [],
    );
    // After mount the stored preference wins.
    await until(() => container.querySelector("[data-openreceive-theme='dark']") !== null, {
      label: "stored theme applied after mount",
    });
  } finally {
    console.error = originalError;
    root.unmount();
    container.remove();
    globalThis.localStorage.removeItem(OPENRECEIVE_THEME_STORAGE_KEY);
  }
});

test("create mode keeps one checkout view across the deferred Lightning mint", async () => {
  // Swapping the rendered shell when the bolt11 arrives remounted PaymentWizard and
  // reset its selection, so the method grid reappeared over the fresh invoice.
  const stack = await createLifecycleStack();
  globalThis.fetch = stack.fetchStub;
  stack.addOrder("order-mint", 2000);
  const handle = mount(React.createElement(Checkout, { reference: "order-mint" }));
  try {
    const bitcoin = await until(() => handle.button("Bitcoin"), { label: "method grid" });
    bitcoin.click();
    await until(() => handle.text().includes(checkoutLabels.switchPaymentMethod), {
      label: "wizard breadcrumb after selecting Bitcoin",
    });
    await until(() => handle.button(checkoutLabels.copyInvoice), {
      label: "minted Lightning invoice",
    });
    // The grid heading only renders while no method is selected.
    assert.ok(
      !handle.text().includes(checkoutLabels.wizardTitle),
      "the mint must not remount the wizard back to the method grid",
    );
  } finally {
    handle.unmount();
    await stack.close();
  }
});

test("a swap start failure is discarded when the payer leaves the focused flow", async () => {
  const stack = await createLifecycleStack();
  // Every start fails. The in-range quote runs BEFORE the first start, and the
  // failed start must never be auto-retried — recovery is the explicit retry button.
  let swapStartPosts = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url, "http://harness.local");
    if (url.pathname === "/openreceive/swaps") {
      swapStartPosts += 1;
      return new Response(JSON.stringify({ message: "Swap provider is unavailable." }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }
    return stack.fetchStub(input, init);
  };
  stack.addOrder("order-swap-error", 2000);
  const handle = mount(React.createElement(Checkout, { reference: "order-swap-error" }));
  try {
    const usdt = await until(() => handle.button("USDT"), { label: "USDT tile" });
    usdt.click();
    const tron = await until(
      () => handle.buttons().find((button) => /Tron/i.test(button.textContent ?? "")),
      { label: "Tron network" },
    );
    tron.click();
    const cont = await until(() => handle.button(checkoutLabels.continue), {
      label: "continue button",
    });
    cont.click();
    await until(() => handle.text().includes("Swap provider is unavailable."), {
      label: "swap start failure",
    });
    assert.equal(
      stack.requests.filter((entry) => entry.path.endsWith("/swaps/quote")).length > 0,
      true,
      "the pay-in asset is quoted before the first swap start",
    );
    assert.equal(swapStartPosts, 1, "a failed swap start must not be auto-retried");

    const back = await until(() => handle.button(checkoutLabels.switchPaymentMethod), {
      label: "back breadcrumb",
    });
    back.click();
    await until(() => !handle.text().includes("Swap provider is unavailable."), {
      label: "failure cleared on leaving the focused flow",
    });
  } finally {
    handle.unmount();
    await stack.close();
  }
});

// The create-mode guards are double-POST guards, not tidiness. They live once,
// in @openreceive/browser/headless's checkout session, and these two tests are
// the React half of the pair in tests/element-lifecycle.test.mjs ("double-
// clicking Bitcoin mints exactly one Lightning invoice" / "double-clicking a
// swap asset starts exactly one swap"). React had NO guard on the mint at all
// before the flows were merged.
test("a second Bitcoin selection during the mint does not POST a second checkout", async () => {
  const stack = await createLifecycleStack();
  stack.addOrder("order-double-mint", 2000);
  let mints = 0;
  let releaseMint = () => {};
  const heldMint = new Promise((resolve) => {
    releaseMint = resolve;
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url, "http://harness.local");
    if (url.pathname === "/openreceive/checkouts") {
      mints += 1;
      await heldMint;
    }
    return stack.fetchStub(input, init);
  };
  const handle = mount(React.createElement(Checkout, { reference: "order-double-mint" }));
  try {
    const bitcoin = await until(() => handle.button("Bitcoin"), { label: "method grid" });
    bitcoin.click();
    await until(() => mints === 1, { label: "first mint in flight" });
    // React flushes a click synchronously, so the realistic double-mint is the
    // payer stepping back to the grid and choosing Bitcoin again while the first
    // POST /checkouts is still open. Unguarded, the second one went out and the
    // loser's 409 surfaced over a perfectly good invoice.
    const back = await until(() => handle.button(checkoutLabels.switchPaymentMethod), {
      label: "wizard breadcrumb",
    });
    back.click();
    const again = await until(() => handle.button("Bitcoin"), { label: "method grid again" });
    again.click();
    await flush();
    assert.equal(mints, 1, "a second Bitcoin selection must not POST a second checkout");

    releaseMint();
    await until(() => handle.button(checkoutLabels.copyInvoice), {
      label: "minted Lightning invoice",
    });
    assert.equal(mints, 1);
  } finally {
    releaseMint();
    handle.unmount();
    await stack.close();
  }
});

test("double-clicking a swap asset starts exactly one swap", async () => {
  const stack = await createLifecycleStack();
  stack.addOrder("order-swap-guard", 2000);
  let swapStarts = 0;
  let releaseStart = () => {};
  const heldStart = new Promise((resolve) => {
    releaseStart = resolve;
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url, "http://harness.local");
    if (url.pathname === "/openreceive/swaps") {
      swapStarts += 1;
      await heldStart;
    }
    return stack.fetchStub(input, init);
  };
  const handle = mount(React.createElement(Checkout, { reference: "order-swap-guard" }));
  try {
    const sol = await until(() => handle.button("SOL"), { label: "SOL tile" });
    // React's first click replaces the whole method grid with the focused swap
    // flow, so the DOM half of the guard is that the tile is simply gone. The
    // state half — one start at a time, whatever the tree looks like — is the
    // session's, and the next test pins it directly.
    sol.click();
    sol.click();
    await until(() => swapStarts === 1, { label: "swap start in flight" });
    await flush();
    assert.equal(swapStarts, 1, "a second click must not POST a second swap start");
  } finally {
    releaseStart();
    handle.unmount();
    await stack.close();
  }
});

// The state half of the swap guard, and the reason React's hook must hold ONE
// session for the component's lifetime: a poll-driven re-render lands between
// the two starts, and a session rebuilt on that render would hand the second
// one a fresh (open) guard and POST /swaps twice.
test("the checkout session survives a re-render, so a second start is refused", async () => {
  let swapStarts = 0;
  let releaseStart = () => {};
  const heldStart = new Promise((resolve) => {
    releaseStart = resolve;
  });
  const fetchStub = async (input, _init) => {
    const url = new URL(typeof input === "string" ? input : input.url, "http://harness.local");
    // The session quotes before it starts; only the START is the held request
    // this guard is about.
    if (url.pathname.endsWith("/swaps/quote")) {
      return new Response(
        JSON.stringify({ quote: { pay_asset: "SOL_SOL", label: "SOL", available: true } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    swapStarts += 1;
    await heldStart;
    return new Response(
      JSON.stringify({ swap: { pay_in_asset: "SOL_SOL", deposit_address: "SoLDeposit" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const probe = {};
  function SwapProbe() {
    const [, bump] = React.useState(0);
    const startedRef = React.useRef(undefined);
    probe.session = useCheckoutSession({
      snapshot: () => undefined,
      reference: () => "order-probe",
      swapPrefix: () => "http://harness.local/openreceive",
      fetch: () => fetchStub,
      swapSelection: {
        started: () => startedRef.current,
        setStarted: (invoice) => {
          startedRef.current = invoice;
        },
        dismissedInvoiceId: () => null,
        setDismissedInvoiceId: () => {},
        setSelectedAsset: () => {},
      },
      onError: () => {},
    });
    probe.rerender = () => bump((count) => count + 1);
    return null;
  }
  const handle = mount(React.createElement(SwapProbe));
  try {
    await until(() => probe.session !== undefined, { label: "mounted probe" });
    const first = probe.session.startSwap("SOL_SOL");
    await flush();
    assert.equal(swapStarts, 1);
    probe.rerender();
    await flush();
    const second = probe.session.startSwap("SOL_SOL");
    await flush();
    assert.equal(swapStarts, 1, "a second start while the first is in flight must not POST");
    releaseStart();
    await Promise.all([first, second]);
    assert.equal(swapStarts, 1);
  } finally {
    releaseStart();
    handle.unmount();
  }
});

// The two tests above are about a request still IN FLIGHT. These two are about
// one that already LANDED: `mintingLightning` / `startingSwapAsset` are back to
// their idle values, so the only thing between the payer's second selection and
// a second POST is the already-completed short-circuit — a different branch, on
// a different path, and the reason the in-flight pair could not catch it. Both
// have an element twin in tests/element-lifecycle.test.mjs.
test("Bitcoin selected again after the mint reuses the bolt11 instead of minting a second one", async () => {
  const stack = await createLifecycleStack();
  stack.addOrder("order-reuse-mint", 2000);
  let mints = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url, "http://harness.local");
    if (url.pathname === "/openreceive/checkouts") mints += 1;
    return stack.fetchStub(input, init);
  };
  const handle = mount(React.createElement(Checkout, { reference: "order-reuse-mint" }));
  try {
    const bitcoin = await until(() => handle.button("Bitcoin"), { label: "method grid" });
    bitcoin.click();
    // Unlike the in-flight test, the mint is allowed to finish: the payer is
    // holding a payable bolt11 before they go anywhere.
    await until(() => handle.button(checkoutLabels.copyInvoice), {
      label: "minted Lightning invoice",
    });
    assert.equal(mints, 1);

    const back = await until(() => handle.button(checkoutLabels.switchPaymentMethod), {
      label: "wizard breadcrumb",
    });
    back.click();
    const again = await until(() => handle.button("Bitcoin"), { label: "method grid again" });
    again.click();
    await flush();
    await flush();
    assert.equal(
      mints,
      1,
      "Bitcoin re-selected with a live bolt11 must not POST a second checkout",
    );
    // Reuse, not a silent no-op: the invoice is still on screen to pay.
    assert.notEqual(handle.button(checkoutLabels.copyInvoice), undefined);
  } finally {
    handle.unmount();
    await stack.close();
  }
});

// The payer-facing half of the already-started swap guard: whatever the
// internals, an asset whose deposit address the payer is already holding must
// never cost a second POST /swaps — the second attempt would strand whatever
// was sent to the first address. Two things stand in the way here, and this
// test is the pin on the pair: React's wizard skips its auto-start effect for
// an asset it can already see an attempt for, and behind that the shared
// session short-circuits on the same fact. Disabling EITHER one alone still
// leaves one POST; disabling both makes this test fail with 2. The test below
// isolates the shared branch, which is the one that has to hold for the
// element too.
test("re-selecting a started swap asset re-opens its panel without a second start", async () => {
  const stack = await createLifecycleStack();
  stack.addOrder("order-swap-reselect", 2000);
  globalThis.fetch = stack.fetchStub;
  const swapStarts = () =>
    stack.requests.filter((entry) => entry.path.endsWith("/swaps") && entry.method === "POST")
      .length;
  const solDeposit = "So11111111111111111111111111111111111111112";
  const handle = mount(React.createElement(Checkout, { reference: "order-swap-reselect" }));
  try {
    const sol = await until(() => handle.button("SOL"), { label: "SOL tile" });
    sol.click();
    await until(() => handle.container.innerHTML.includes(solDeposit), {
      label: "SOL deposit panel",
    });
    assert.equal(swapStarts(), 1);

    const back = await until(() => handle.button(checkoutLabels.switchPaymentMethod), {
      label: "back breadcrumb",
    });
    back.click();
    const again = await until(() => handle.button("SOL"), { label: "asset grid again" });
    again.click();
    await until(() => handle.container.innerHTML.includes(solDeposit), {
      label: "deposit panel again",
    });
    await flush();
    await flush();
    assert.equal(
      swapStarts(),
      1,
      "an asset whose deposit instructions the payer already holds must not POST a second start",
    );
  } finally {
    handle.unmount();
    await stack.close();
  }
});

// The shared branch on its own, through React's host wiring. It matters here
// even though the wizard has a gate in front of it: it is the same branch the
// element depends on with nothing in front of it (tests/element-lifecycle.test.mjs,
// "re-selecting a started swap asset re-opens its panel without a second
// start"), and reaching it correctly from React is not free — `started()` and
// `dismissedInvoiceId()` are read back through `optionsRef` on every call, so
// a session holding the first render's accessors would answer with a stale
// `undefined` and POST again.
test("the session refuses a second start for an asset it already holds instructions for", async () => {
  let swapStarts = 0;
  const paymentHash = "f".repeat(64);
  const fetchStub = async (input, _init) => {
    const url = new URL(typeof input === "string" ? input : input.url, "http://harness.local");
    // The session quotes before it starts; only the START is counted here.
    if (url.pathname.endsWith("/swaps/quote")) {
      return new Response(
        JSON.stringify({ quote: { pay_asset: "SOL_SOL", label: "SOL", available: true } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    swapStarts += 1;
    return new Response(
      JSON.stringify({
        swap: {
          payment_hash: paymentHash,
          provider: "fixedfloat",
          pay_in_asset: "SOL_SOL",
          deposit_address: "So11111111111111111111111111111111111111112",
          deposit_amount: "1.50",
          provider_state: "awaiting_deposit",
          provider_expires_at: Math.floor(Date.now() / 1000) + 900,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const probe = {};
  function SwapProbe() {
    // useState, not a ref: this is the wizard's own shape, so the test also
    // covers the render React has to do before the session can see the attempt.
    const [started, setStarted] = React.useState(undefined);
    const [dismissed, setDismissed] = React.useState(null);
    const [selected, setSelected] = React.useState(null);
    probe.session = useCheckoutSession({
      snapshot: () => undefined,
      reference: () => "order-reselect",
      swapPrefix: () => "http://harness.local/openreceive",
      fetch: () => fetchStub,
      swapSelection: {
        started: () => started,
        setStarted,
        dismissedInvoiceId: () => dismissed,
        setDismissedInvoiceId: setDismissed,
        setSelectedAsset: setSelected,
      },
      onError: () => {},
    });
    probe.selected = () => selected;
    probe.leaveFocus = () => setSelected(null);
    probe.dismiss = () => setDismissed(started?.invoice_id ?? null);
    return null;
  }
  const handle = mount(React.createElement(SwapProbe));
  try {
    await until(() => probe.session !== undefined, { label: "mounted probe" });
    await probe.session.startSwap("SOL_SOL");
    await flush();
    assert.equal(swapStarts, 1);
    assert.equal(probe.selected(), "SOL_SOL");

    // The payer left the focused flow and came back. Nothing is in flight, so
    // the in-flight guard is wide open; only the already-started branch is left.
    probe.leaveFocus();
    await flush();
    await probe.session.startSwap("SOL_SOL");
    await flush();
    assert.equal(swapStarts, 1, "an asset already holding instructions must not POST again");
    assert.equal(
      probe.selected(),
      "SOL_SOL",
      "the short-circuit re-selects the asset so the payer lands back on the address",
    );

    // Scoped, not blanket: once the payer dismisses that attempt (the deposit
    // panel's "back to Lightning"), the same asset may start a fresh one.
    probe.dismiss();
    await flush();
    await probe.session.startSwap("SOL_SOL");
    await flush();
    assert.equal(swapStarts, 2, "a dismissed attempt must not block a fresh start");
  } finally {
    handle.unmount();
  }
});
