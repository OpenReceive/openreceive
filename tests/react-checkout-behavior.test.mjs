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
const { OPENRECEIVE_THEME_STORAGE_KEY, openReceiveCheckoutLabels } = await import(
  "../packages/js/browser/src/internal.ts"
);

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

test("an inline refreshStatus does not restart the poll controller on every render", async () => {
  // The controller reloads state as soon as it is created. Keeping the caller's
  // refreshStatus in the effect's dependency list therefore turned each parent render
  // into another teardown + status request, which is a request loop under any parent
  // that setStates from onState/onSettled.
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
      // Inline on purpose: a new function identity on every render.
      refreshStatus: async () => {
        refreshCalls += 1;
        return null;
      },
      logger: () => undefined,
      onError: () => undefined,
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
  // /openreceive, so <Checkout checkout={snapshot}> with no prefix and no orderUrl
  // must still poll. It used to derive orderUrl only when a prefix was supplied and
  // silently never polled.
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

test("copy feedback appears on click and resets itself", async () => {
  const snapshot = invoice({ invoice_id: "or_inv_copy_ui", invoice: "lnbc-copy-ui" });
  const written = [];
  globalThis.navigator.clipboard ??= { writeText: async (value) => void written.push(value) };
  const handle = mount(React.createElement(Checkout, { checkout: snapshot, polling: false }));
  try {
    const copy = await until(() => handle.button(openReceiveCheckoutLabels.copyInvoice), {
      label: "copy button",
    });
    copy.click();
    await until(() => handle.text().includes(openReceiveCheckoutLabels.copied), {
      label: "copied feedback",
    });
    // The feedback is transient: it must clear itself without another click.
    await until(() => !handle.text().includes(openReceiveCheckoutLabels.copied), {
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
  const handle = mount(React.createElement(Checkout, { orderId: "order-mint" }));
  try {
    const bitcoin = await until(() => handle.button("Bitcoin"), { label: "method grid" });
    bitcoin.click();
    await until(() => handle.text().includes(openReceiveCheckoutLabels.switchPaymentMethod), {
      label: "wizard breadcrumb after selecting Bitcoin",
    });
    await until(() => handle.button(openReceiveCheckoutLabels.copyInvoice), {
      label: "minted Lightning invoice",
    });
    // The grid heading only renders while no method is selected.
    assert.ok(
      !handle.text().includes(openReceiveCheckoutLabels.wizardTitle),
      "the mint must not remount the wizard back to the method grid",
    );
  } finally {
    handle.unmount();
    await stack.close();
  }
});

test("a swap start failure is discarded when the payer leaves the focused flow", async () => {
  const stack = await createLifecycleStack();
  // Every start fails: a single failure is auto-retried after the quote, which is the
  // recovery path, not the state under test.
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url, "http://harness.local");
    if (url.pathname === "/openreceive/swaps") {
      return new Response(JSON.stringify({ message: "Swap provider is unavailable." }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }
    return stack.fetchStub(input, init);
  };
  stack.addOrder("order-swap-error", 2000);
  const handle = mount(React.createElement(Checkout, { orderId: "order-swap-error" }));
  try {
    const usdt = await until(() => handle.button("USDT"), { label: "USDT tile" });
    usdt.click();
    const tron = await until(
      () => handle.buttons().find((button) => /Tron/i.test(button.textContent ?? "")),
      { label: "Tron network" },
    );
    tron.click();
    const cont = await until(() => handle.button(openReceiveCheckoutLabels.continue), {
      label: "continue button",
    });
    cont.click();
    await until(() => handle.text().includes("Swap provider is unavailable."), {
      label: "swap start failure",
    });

    const back = await until(() => handle.button(openReceiveCheckoutLabels.switchPaymentMethod), {
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
