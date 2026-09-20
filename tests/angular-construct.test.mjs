import assert from "node:assert/strict";
import test from "node:test";
// Registered before the DOM-render test dynamically imports
// @angular/platform-browser (the static imports below never touch the DOM).
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { until } from "./helpers/lifecycle-harness.mjs";
// The dist bundle is partially compiled; its component declarations need the
// JIT compiler registered before the class definitions run.
import "@angular/compiler";
import {
  ChangeDetectorRef,
  createComponent,
  Injector,
  NgZone,
  provideZonelessChangeDetection,
  runInInjectionContext,
} from "@angular/core";

process.env.LOG_LEVEL ??= "error";
GlobalRegistrator.register({ url: "http://angular.local/" });

// The built entry point, not the raw .ts: the source needs Angular's AOT
// decorator handling, which node's TS loader does not provide. Every other
// @openreceive/* import under tests/ resolves from src via tsx + tsconfig
// paths; only @openreceive/angular/checkout-component has no paths entry, so
// package.json's `pretest:js` builds just this chain — angular plus the
// workspace deps whose dist .d.ts its build type-checks against.
import { CheckoutComponent } from "@openreceive/angular/checkout-component";

// Angular sets @Input values only after construction, so field initializers see
// every input as undefined. C3 shipped because the shell binding was built (and
// validated) as a field initializer: validation threw on every instantiation.

function constructComponent() {
  const injector = Injector.create({
    providers: [
      { provide: NgZone, useValue: { runOutsideAngular: (fn) => fn() } },
      { provide: ChangeDetectorRef, useValue: { detectChanges() {} } },
    ],
  });
  return runInInjectionContext(injector, () => new CheckoutComponent());
}

test("the Angular component constructs before any input is set", () => {
  const component = constructComponent();
  // No shell yet: inputs land after construction, so the binding must wait for
  // the first ngOnChanges instead of validating undefined props.
  assert.equal(component.shell, null);
});

test("ngOnChanges builds the shell binding once inputs are set", () => {
  const component = constructComponent();
  component.reference = "order-construct";
  component.metadata = { sku: "sticker-1" };
  component.ngOnChanges();

  const shell = component.shell;
  assert.notEqual(shell, null);
  assert.equal(shell.checkout.attributes.reference, "order-construct");
  assert.equal(shell.checkout.attributes.metadata, JSON.stringify({ sku: "sticker-1" }));
  assert.ok(shell.rootAttributes["data-openreceive-theme"]);
  // The shell root is directive-driven: every rootAttributes key must reach the
  // template's binding object, not a hand-transcribed [attr.*] subset.
  assert.deepEqual(component.rootBindings.attributes, shell.rootAttributes);
});

test("subsequent input changes rebuild the shell binding", () => {
  const component = constructComponent();
  component.reference = "order-first";
  component.ngOnChanges();
  const first = component.shell;

  component.reference = "order-second";
  component.ngOnChanges();
  const second = component.shell;

  assert.notEqual(second, first, "input changes must produce a fresh binding");
  assert.equal(second.checkout.attributes.reference, "order-second");
});

test("the Angular component renders the checkout shell into a real DOM", async () => {
  // The mount test the construction tests could not be: the JIT compiler
  // renders the inline template into happy-dom, ngAfterViewInit defines the
  // custom elements, and the element runs its create-mode lifecycle.
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "http://angular.local");
    calls.push(url.pathname);
    const body = url.pathname.endsWith("/checkouts/prepare")
      ? { reference: "order-ng-render", amount_msats: 21_000, payment_methods: [] }
      : { status: "pending" };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
  };

  // Imported only now: platform-browser needs the happy-dom globals.
  const { createApplication } = await import("@angular/platform-browser");
  const appRef = await createApplication({ providers: [provideZonelessChangeDetection()] });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const componentRef = createComponent(CheckoutComponent, {
    environmentInjector: appRef.injector,
    hostElement: host,
  });

  try {
    componentRef.setInput("reference", "order-ng-render");
    appRef.attachView(componentRef.hostView);
    componentRef.changeDetectorRef.detectChanges();

    const root = host.querySelector("[data-openreceive-theme]");
    assert.ok(root, "the shell root must carry data-openreceive-theme");
    assert.ok(
      host.querySelector("openreceive-theme-toggle"),
      "themeToggle defaults to true: the toggle element must render",
    );
    const element = host.querySelector("openreceive-checkout");
    assert.ok(element, "the wrapper must render the checkout element");
    assert.equal(element.getAttribute("reference"), "order-ng-render");

    // The element really runs: its connected callback prepares the checkout
    // (via the documented /openreceive default prefix) and renders shadow DOM.
    await until(() => element.shadowRoot?.innerHTML.length > 0, {
      timeoutMs: 4000,
      stepMs: 5,
      label: "checkout shadow render",
    });
    assert.ok(
      calls.includes("/openreceive/checkouts/prepare"),
      "the element must prepare against the documented /openreceive default prefix",
    );
  } finally {
    componentRef.destroy();
    appRef.destroy();
    host.remove();
  }
});

test("Angular input identity changes discard a delayed mint", async () => {
  const calls = [];
  let releaseMint;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    if (url.endsWith("/prepare"))
      return Response.json({ reference: body.reference, amount_msats: 21000, payment_methods: [] });
    if (url.endsWith("/checkouts"))
      return new Promise((resolve) => {
        releaseMint = resolve;
      });
    return Response.json({ status: "pending" });
  };
  const { createApplication } = await import("@angular/platform-browser");
  const app = await createApplication({ providers: [provideZonelessChangeDetection()] });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const component = createComponent(CheckoutComponent, {
    environmentInjector: app.injector,
    hostElement: host,
  });
  try {
    component.setInput("reference", "A");
    app.attachView(component.hostView);
    component.changeDetectorRef.detectChanges();
    const element = await until(() => host.querySelector("openreceive-checkout"));
    (await until(() => element.shadowRoot?.querySelector('[data-or-method="bitcoin"]'))).click();
    await until(() => releaseMint !== undefined);
    component.setInput("reference", "B");
    component.changeDetectorRef.detectChanges();
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
    assert.equal(element.getAttribute("reference"), "B");
    assert.equal(element.getAttribute("invoice"), null);
  } finally {
    component.destroy();
    app.destroy();
    host.remove();
    globalThis.fetch = originalFetch;
  }
});
