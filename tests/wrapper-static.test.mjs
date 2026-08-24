// Static/compile-only checks on the SFC wrappers: source regexes, compiler
// output, and the shared binding factory. Nothing here mounts a component —
// the real happy-dom mounts live in tests/wrapper-behavior.test.mjs (this file
// was wrapper-mount.test.mjs before those existed).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { compile } from "svelte/compiler";
import { parse as parseVueSfc } from "@vue/compiler-sfc";

import { createWrapperCheckoutShellBinding } from "../packages/js/elements/src/wrapper-shared.ts";

const SVELTE_SFC = "packages/js/svelte/src/Checkout.svelte";
const VUE_SFC = "packages/js/vue/src/Checkout.vue";

// The wrappers hand their element the attribute/listener maps the shared
// factory builds, so every wrapper must forward whatever that factory emits.
// H14/H15/H16 all shipped because nothing mounted these components in CI.

function shellFixture() {
  return createWrapperCheckoutShellBinding(null, {
    reference: "order-mount",
    metadata: { sku: "sticker-1" },
    themeToggle: true,
  });
}

test("the shared shell binding is the single source of element attributes", () => {
  const shell = shellFixture();
  assert.equal(shell.checkout.attributes.reference, "order-mount");
  // Create-time metadata must survive into the element attributes: an Angular
  // template that hand-lists attributes silently dropped exactly this.
  assert.equal(shell.checkout.attributes.metadata, JSON.stringify({ sku: "sticker-1" }));
  assert.ok(shell.rootAttributes["data-openreceive-theme"]);
});

test("the Svelte wrapper compiles and wires the listener action it declares", () => {
  const source = readFileSync(SVELTE_SFC, "utf8");
  const compiled = compile(source, { generate: "client", name: "Checkout" });
  const code = compiled.js.code;

  // A `use:` directive naming an identifier the script never declares compiles
  // to a call on an undeclared binding: ReferenceError on mount.
  const actions = [...source.matchAll(/use:([A-Za-z_$][\w$]*)/g)].map((match) => match[1]);
  assert.ok(actions.length > 0, "the component must attach its listeners through a use: action");
  for (const action of actions) {
    assert.match(
      source,
      new RegExp(`function\\s+${action}\\s*\\(`),
      `use:${action} has no matching function declaration`,
    );
    assert.ok(code.includes(action), `${action} must survive compilation`);
  }
});

test("the Svelte wrapper spreads root attributes the shell actually exposes", () => {
  const source = readFileSync(SVELTE_SFC, "utf8");
  const shell = shellFixture();
  const spreads = [...source.matchAll(/\{\.\.\.shell\.([\w.]+)\}/g)].map((match) => match[1]);
  assert.ok(spreads.length > 0);
  for (const path of spreads) {
    const value = path.split(".").reduce((node, key) => node?.[key], shell);
    assert.notEqual(value, undefined, `shell.${path} is spread but does not exist on the binding`);
  }
});

test("the Vue wrapper only binds shell fields that exist", () => {
  const source = readFileSync(VUE_SFC, "utf8");
  const { descriptor, errors } = parseVueSfc(source);
  assert.equal(errors.length, 0, `Checkout.vue must parse: ${errors.map((e) => e.message).join()}`);
  assert.ok(descriptor.template, "Checkout.vue must have a template");
  const shell = shellFixture();
  const spreads = [...descriptor.template.content.matchAll(/v-bind="shell\.([\w.]+)"/g)].map(
    (match) => match[1],
  );
  for (const path of spreads) {
    const value = path.split(".").reduce((node, key) => node?.[key], shell);
    assert.notEqual(value, undefined, `shell.${path} is bound but does not exist on the binding`);
  }
});

test("the Angular component drives attributes from the binding, not a hand-written list", () => {
  const component = readFileSync(
    "packages/js/angular/src/openreceive-checkout.component.ts",
    "utf8",
  );
  // Hand-transcribed [attr.*] bindings are how the metadata input went missing
  // (and how a third rootAttributes key would go missing on the shell root);
  // every element's attributes must come from the shared binding object instead.
  const templateStart = component.indexOf("template: `");
  const template = component.slice(templateStart, component.indexOf("`,", templateStart));
  assert.ok(templateStart !== -1, "the component must declare an inline template");
  assert.doesNotMatch(template, /\[attr\./, "the template must not hand-list attributes");
  assert.match(component, /openreceiveElementBindings\]="shell\.checkout"/);
  assert.match(component, /openreceiveElementBindings\]="rootBindings"/);
  assert.match(component, /@Input\(\) metadata\?/);
});

test("the Angular element bindings apply and prune element attributes", async () => {
  const { applyElementBindings, EMPTY_APPLIED_ELEMENT_BINDINGS } = await import(
    "../packages/js/angular/src/element-bindings.ts"
  );

  const attributes = new Map();
  const listeners = [];
  const element = {
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name),
    addEventListener: (name, handler) => listeners.push(["add", name, handler]),
    removeEventListener: (name, handler) => listeners.push(["remove", name, handler]),
  };

  const handler = () => {};
  let applied = applyElementBindings(
    element,
    {
      attributes: { reference: "order-mount", metadata: '{"sku":"sticker-1"}', theme: undefined },
      listeners: { "openreceive-settled": handler },
    },
    EMPTY_APPLIED_ELEMENT_BINDINGS,
  );

  assert.equal(attributes.get("reference"), "order-mount");
  assert.equal(attributes.get("metadata"), '{"sku":"sticker-1"}');
  assert.equal(attributes.has("theme"), false, "undefined attributes must not be written");
  assert.deepEqual(listeners, [["add", "openreceive-settled", handler]]);

  // An attribute that disappears from the binding must be removed from the DOM.
  applied = applyElementBindings(
    element,
    { attributes: { reference: "order-mount" }, listeners: {} },
    applied,
  );
  assert.equal(attributes.has("metadata"), false);
  assert.deepEqual(listeners.at(-1), ["remove", "openreceive-settled", handler]);
});
