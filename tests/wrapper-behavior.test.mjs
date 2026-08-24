// Real mounts of the SFC wrappers (H6): the Vue and Svelte Checkout components
// are compiled with their framework compilers and mounted into a happy-dom
// document, executing the same component code an app would run. The static
// template/spread checks live in wrapper-static.test.mjs; this file exists so a
// wrapper that compiles but throws on mount (H14/H15/H16's failure mode) fails CI.
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
// Inside the repo so bare specifiers (vue, svelte/internal/client) resolve from
// the workspace node_modules; never committed (node_modules is ignored).
const generatedDir = path.join(repoRoot, "node_modules", ".cache", "openreceive-wrapper-tests");
mkdirSync(generatedDir, { recursive: true });

async function importGeneratedModule(name, code) {
  const file = path.join(generatedDir, name);
  writeFileSync(file, code);
  return import(pathToFileURL(file).href);
}

/**
 * Compile packages/js/vue/src/Checkout.vue exactly as a bundler would:
 * @vue/compiler-sfc compiles <script setup> with the template inlined, then the
 * TypeScript compiler strips types. The relative ./index.js import is rewritten
 * to the package's source entry, which tsx compiles on import.
 */
async function loadVueCheckout() {
  const file = path.join(repoRoot, "packages/js/vue/src/Checkout.vue");
  const { parse, compileScript } = await import("vue/compiler-sfc");
  const { descriptor, errors } = parse(readFileSync(file, "utf8"), { filename: file });
  assert.equal(errors.length, 0, `Checkout.vue must parse: ${errors.map((e) => e.message).join()}`);
  const script = compileScript(descriptor, { id: "wrapper-behavior-vue", inlineTemplate: true });
  const indexUrl = pathToFileURL(path.join(repoRoot, "packages/js/vue/src/index.ts")).href;
  const ts = (await import("typescript")).default;
  const { outputText } = ts.transpileModule(script.content.replaceAll("./index.js", indexUrl), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const mod = await importGeneratedModule("checkout-vue.mjs", outputText);
  return mod.default;
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
