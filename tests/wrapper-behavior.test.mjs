// Real mounts of the SFC wrappers (H6): the Vue and Svelte Checkout components
// are mounted into a happy-dom document, executing the same component code an
// app would run. Vue's is the package build's own output (the SFC compiled to
// JavaScript; `pretest:js` builds it). Svelte's is compiled here with the
// Svelte compiler. The static template/spread checks live in
// wrapper-static.test.mjs; this file exists so a wrapper that compiles but
// throws on mount (H14/H15/H16's failure mode) fails CI.
//
// Angular is mounted in tests/angular-construct.test.mjs (it needs the
// ng-packagr dist + JIT compiler), React has mounted behavior tests in
// tests/react-checkout-behavior.test.mjs, and the element itself is attached to
// a DOM in tests/element-lifecycle.test.mjs.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

process.env.LOG_LEVEL ??= "error";
GlobalRegistrator.register({ url: "http://wrappers.local/" });

const assert = (await import("node:assert/strict")).default;
const test = (await import("node:test")).default;
const { mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
const path = (await import("node:path")).default;
const { fileURLToPath, pathToFileURL } = await import("node:url");
const { until } = await import("./helpers/lifecycle-harness.mjs");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Inside the repo so the compiled Svelte component's bare specifiers
// (svelte/internal/client) resolve from the workspace node_modules; never
// committed (node_modules is ignored).
const generatedDir = path.join(repoRoot, "node_modules", ".cache", "openreceive-wrapper-tests");
mkdirSync(generatedDir, { recursive: true });

async function importGeneratedModule(name, code) {
  const file = path.join(generatedDir, name);
  writeFileSync(file, code);
  return import(pathToFileURL(file).href);
}

// The file a shop's bundler gets for `import Checkout from
// "@openreceive/vue/checkout.vue"`: whatever the package's export map names.
const vuePackageDir = path.join(repoRoot, "packages/js/vue");
const vueCheckoutFile = path.join(
  vuePackageDir,
  JSON.parse(readFileSync(path.join(vuePackageDir, "package.json"), "utf8")).exports[
    "./checkout.vue"
  ].default,
);

/**
 * The shipped Vue component, as the package build emitted it: Checkout.vue
 * compiled to plain JavaScript by tools/package/compile-vue-sfc.mjs, importing
 * only `vue` and the package's own dist/index.js.
 */
async function loadVueCheckout() {
  return (await import(pathToFileURL(vueCheckoutFile).href)).default;
}

// Node resolves the bare "svelte" specifier to the server build (no `browser`
// condition), whose mount() throws by design. The client entry is imported by
// file URL instead — this is the module a browser bundle would get.
const svelteClientUrl = pathToFileURL(
  path.join(repoRoot, "node_modules", "svelte", "src", "index-client.js"),
).href;

/**
 * Compile packages/js/svelte/src/Checkout.svelte with the real Svelte 5 client
 * compiler (which strips the lang="ts" annotations itself) and import the result.
 */
async function loadSvelteCheckout() {
  const file = path.join(repoRoot, "packages/js/svelte/src/Checkout.svelte");
  const { compile } = await import("svelte/compiler");
  const compiled = compile(readFileSync(file, "utf8"), {
    generate: "client",
    name: "Checkout",
    filename: file,
  });
  const indexUrl = pathToFileURL(path.join(repoRoot, "packages/js/svelte/src/index.ts")).href;
  const mod = await importGeneratedModule(
    "checkout-svelte.mjs",
    compiled.js.code
      .replaceAll("./index.js", indexUrl)
      .replaceAll('"svelte"', `"${svelteClientUrl}"`),
  );
  return mod.default;
}

/** Poll until predicate() is truthy (its value is returned) or fail with `label`. */
/** Stub the endpoints a create-mode element hits; records every request path. */
function stubFetch(reference) {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), "http://wrappers.local");
    calls.push(url.pathname);
    const body = url.pathname.endsWith("/checkouts/prepare")
      ? { reference: reference, amount_msats: 21_000, payment_methods: [] }
      : { status: "pending" };
    void init;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => body,
    };
  };
  return calls;
}

/**
 * The shell contract every wrapper mount must satisfy: an
 * <openreceive-checkout> carrying the order id that really renders, and —
 * because no `prefix` prop was passed — the element preparing against the
 * documented `/openreceive` default prefix, plus the documented themeToggle
 * default (root theme attributes + toggle element).
 */
async function assertMountedShell(container, reference, calls) {
  {
    const root = container.querySelector("[data-openreceive-theme]");
    assert.ok(root, "the shell root must carry data-openreceive-theme");
    assert.ok(root.getAttribute("data-theme"), "the shell root must resolve a data-theme");
    assert.ok(
      container.querySelector("openreceive-theme-toggle"),
      "themeToggle defaults to true: the toggle element must render",
    );
  }
  const element = container.querySelector("openreceive-checkout");
  assert.ok(element, "the wrapper must render the checkout element");
  assert.equal(element.getAttribute("reference"), reference);

  // The element really runs: its connected callback prepares the checkout and
  // renders the shadow tree.
  await until(() => element.shadowRoot?.innerHTML.length > 0, {
    timeoutMs: 4000,
    stepMs: 5,
    label: "checkout shadow render",
  });
  const prepare = await until(() => calls.find((p) => p.endsWith("/checkouts/prepare")), {
    timeoutMs: 4000,
    stepMs: 5,
    label: "checkout prepare request",
  });
  assert.equal(
    prepare,
    "/openreceive/checkouts/prepare",
    "with no prefix prop the element must use the documented /openreceive default",
  );
}

// The 0.4.32 Nuxt trials: the package shipped Checkout.vue as source, whose
// `defineProps<WrapperCheckoutComponentProps>()` names an imported type. Every
// shop's build had to resolve it with TypeScript, so a JavaScript-only app failed
// with "Failed to load TypeScript" and TypeScript 7 with "No fs option provided".
test("the shipped Vue component is plain JavaScript: no SFC, no type-based props", async () => {
  assert.match(vueCheckoutFile, /\.js$/, "./checkout.vue must export the compiled module");
  const code = readFileSync(vueCheckoutFile, "utf8");
  assert.doesNotMatch(code, /defineProps\s*</, "a type-based defineProps needs TypeScript");
  assert.doesNotMatch(code, /\b(defineProps|withDefaults|defineOptions)\s*\(/);
  assert.doesNotMatch(code, /<script|<template/);
  const specifiers = [...code.matchAll(/^import .* from ["']([^"']+)["'];?$/gm)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(specifiers)].sort(),
    ["./index.js", "vue"],
    "the component imports only vue and the package entry",
  );

  const Checkout = await loadVueCheckout();
  assert.equal(Checkout.name, "Checkout");
  assert.equal(typeof Checkout.setup, "function");
  assert.equal(Checkout.props.reference.type, String);
});

// Nuxt server-renders the page first. The compiled component has no ssrRender,
// so Vue's server renderer runs its render function: the shell must come out.
test("the shipped Vue component server-renders the checkout shell", async () => {
  const Checkout = await loadVueCheckout();
  const { createSSRApp } = await import("vue");
  const { renderToString } = await import("vue/server-renderer");
  const html = await renderToString(createSSRApp(Checkout, { reference: "order-vue-ssr" }));
  assert.match(html, /^<section [^>]*data-openreceive-root/);
  assert.match(html, /<openreceive-theme-toggle[ >]/);
  assert.match(html, /<openreceive-checkout [^>]*reference="order-vue-ssr"/);
});

test("the Vue wrapper mounts: createApp renders the checkout shell for a reference", async () => {
  const reference = "order-vue-mount";
  const calls = stubFetch(reference);
  const Checkout = await loadVueCheckout();
  const { createApp } = await import("vue");

  const container = document.createElement("div");
  document.body.appendChild(container);
  const errors = [];
  const app = createApp(Checkout, { reference, onError: (event) => errors.push(event) });
  try {
    app.mount(container);
    await assertMountedShell(container, reference, calls);
    assert.deepEqual(errors, [], "mounting must not dispatch openreceive-error");
  } finally {
    app.unmount();
    container.remove();
  }
});

// Regression test for Vue's absent-Boolean-prop-to-false coercion: the SFC
// declares explicit `undefined` defaults so `?? options.* ?? default` chains
// see "not set" — a bare <Checkout reference> must render the documented
// defaults from docs/internal/wrapper-parity.md.
test("the mounted Vue wrapper honors the documented boolean prop defaults", async () => {
  const reference = "order-vue-defaults";
  stubFetch(reference);
  const Checkout = await loadVueCheckout();
  const { createApp } = await import("vue");

  const container = document.createElement("div");
  document.body.appendChild(container);
  const app = createApp(Checkout, { reference });
  try {
    app.mount(container);
    assert.ok(
      container.querySelector("openreceive-theme-toggle"),
      "themeToggle defaults to true: the toggle element must render",
    );
    assert.notEqual(
      container.querySelector("openreceive-checkout")?.getAttribute("payment-wizard"),
      "false",
      "an absent paymentWizard prop must not disable the wizard",
    );
  } finally {
    app.unmount();
    container.remove();
  }
});

test("the Svelte wrapper mounts: svelte mount() renders the checkout shell for a reference", async () => {
  const reference = "order-svelte-mount";
  const calls = stubFetch(reference);
  const Checkout = await loadSvelteCheckout();
  const { mount, unmount } = await import(svelteClientUrl);

  const container = document.createElement("div");
  document.body.appendChild(container);
  const errors = [];
  const component = mount(Checkout, {
    target: container,
    props: { reference, onError: (event) => errors.push(event) },
  });
  try {
    await assertMountedShell(container, reference, calls);
    assert.deepEqual(errors, [], "mounting must not dispatch openreceive-error");
  } finally {
    await unmount(component);
    container.remove();
  }
});

for (const framework of ["vue", "svelte"])
  test(`${framework} identity changes discard a delayed element mint`, async () => {
    let releaseMint;
    const calls = [];
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body });
      if (url.endsWith("/prepare"))
        return Response.json({
          reference: body.reference,
          amount_msats: 21000,
          payment_methods: [],
        });
      if (url.endsWith("/checkouts"))
        return new Promise((resolve) => {
          releaseMint = resolve;
        });
      return Response.json({ status: "pending" });
    };
    const target = document.createElement("div");
    document.body.appendChild(target);
    let change, dispose;
    if (framework === "vue") {
      const Checkout = await loadVueCheckout();
      const { createApp, h, reactive } = await import("vue");
      const state = reactive({ reference: "A" });
      const app = createApp({ render: () => h(Checkout, state) });
      app.mount(target);
      change = () => {
        state.reference = "B";
      };
      dispose = () => app.unmount();
    } else {
      const Checkout = await loadSvelteCheckout();
      const { createClassComponent } = await import(
        pathToFileURL(path.join(repoRoot, "node_modules/svelte/src/legacy/legacy-client.js")).href
      );
      const instance = createClassComponent({
        component: Checkout,
        target,
        props: { reference: "A" },
      });
      change = () => instance.$set({ reference: "B" });
      dispose = () => instance.$destroy();
    }
    try {
      let element = await until(() => target.querySelector("openreceive-checkout"));
      (await until(() => element.shadowRoot?.querySelector('[data-or-method="bitcoin"]'))).click();
      await until(() => releaseMint !== undefined);
      change();
      await until(() => calls.some((c) => c.url.endsWith("/prepare") && c.body.reference === "B"));
      releaseMint(
        Response.json({
          checkout: {
            reference: "A",
            payment_hash: "a".repeat(64),
            bolt11: "lnbc-obsolete-a",
            amount_msats: 21000,
            expires_at: Math.floor(Date.now() / 1000) + 900,
          },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      element = target.querySelector("openreceive-checkout");
      assert.equal(element.getAttribute("reference"), "B");
      assert.equal(element.getAttribute("invoice"), null);
      assert.doesNotMatch(element.shadowRoot.innerHTML, /obsolete-a/);
    } finally {
      await dispose();
      target.remove();
    }
  });
