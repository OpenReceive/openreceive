// Bundles for the browser lab: each framework wrapper built the way a shop's
// bundler builds it, so a real browser can mount it.
//
// Vue and Angular come from the packages' built files (what npm carries:
// dist/Checkout.js, the ng-packagr bundle). Svelte's package ships its
// component as source for the shop's own Svelte compiler, so it is compiled
// here; React is bundled from src/ because `pretest:js` does not build it.
// Each bundle sets `window.mountCheckout(props, options)`.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const ENTRIES = {
  vue: {
    code: `
import { createApp, createSSRApp, h } from "vue";
import Checkout from "@openreceive/vue/checkout.vue";
window.mountCheckout = (props, { hydrate = false } = {}) => {
  const app = (hydrate ? createSSRApp : createApp)({ render: () => h(Checkout, props) });
  app.mount("#app");
  window.unmountCheckout = () => app.unmount();
};`,
    // The development build: Vue's warnings reach the console, where the lab
    // counts them. A production build swallows a failed prop assignment.
    define: {
      __VUE_OPTIONS_API__: "true",
      __VUE_PROD_DEVTOOLS__: "false",
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "true",
    },
  },
  svelte: {
    code: `
import { mount, unmount } from "svelte";
import Checkout from "./packages/js/svelte/src/Checkout.svelte";
window.mountCheckout = (props) => {
  const component = mount(Checkout, { target: document.getElementById("app"), props });
  window.unmountCheckout = () => unmount(component);
};`,
    conditions: ["svelte", "browser"],
  },
  angular: {
    // The package is partially compiled; the JIT compiler finishes it in the
    // browser, as tests/angular-construct.test.mjs does in Node.
    code: `
import "@angular/compiler";
import { Component, provideZonelessChangeDetection } from "@angular/core";
import { bootstrapApplication } from "@angular/platform-browser";
import { CheckoutComponent } from "@openreceive/angular/checkout-component";
window.mountCheckout = async (props) => {
  const inputs = Object.keys(props).map((name) => "[" + name + "]=\\"props." + name + "\\"").join(" ");
  const Host = Component({
    selector: "lab-root",
    standalone: true,
    imports: [CheckoutComponent],
    template: "<openreceive-angular-checkout " + inputs + "></openreceive-angular-checkout>",
  })(class LabRoot { props = props; });
  document.getElementById("app").appendChild(document.createElement("lab-root"));
  const app = await bootstrapApplication(Host, { providers: [provideZonelessChangeDetection()] });
  window.unmountCheckout = () => app.destroy();
};`,
  },
  react: {
    code: `
import { createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Checkout } from "./packages/js/react/src/index.ts";
window.mountCheckout = (props, { strict = true } = {}) => {
  const root = createRoot(document.getElementById("app"));
  const checkout = createElement(Checkout, props);
  root.render(strict ? createElement(StrictMode, null, checkout) : checkout);
  window.unmountCheckout = () => root.unmount();
};`,
  },
};

/** Svelte components, compiled as a Svelte shop's bundler plugin would. */
const sveltePlugin = {
  name: "svelte",
  setup(build) {
    build.onLoad({ filter: /\.svelte$/ }, async (args) => {
      const { compile } = await import("svelte/compiler");
      const compiled = compile(readFileSync(args.path, "utf8"), {
        generate: "client",
        filename: args.path,
      });
      return { contents: compiled.js.code, loader: "js", resolveDir: path.dirname(args.path) };
    });
  },
};

const built = new Map();

/** The bundle for one wrapper (`vue`, `svelte`, `angular`, `react`), built once per process. */
export function wrapperBundle(name) {
  if (!built.has(name)) built.set(name, bundle(name));
  return built.get(name);
}

async function bundle(name) {
  const entry = ENTRIES[name];
  if (entry === undefined) throw new Error(`no browser bundle for ${name}`);
  const { build } = await import("esbuild");
  const result = await build({
    stdin: {
      contents: entry.code,
      resolveDir: repoRoot,
      loader: "js",
      sourcefile: `${name}-lab.js`,
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
    logLevel: "silent",
    conditions: entry.conditions ?? ["browser"],
    define: { "process.env.NODE_ENV": '"development"', ...entry.define },
    loader: { ".css": "empty" },
    plugins: [sveltePlugin],
  });
  return result.outputFiles[0].text;
}
