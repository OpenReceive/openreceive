import assert from "node:assert/strict";
import test from "node:test";
// The dist bundle is partially compiled; its component declarations need the
// JIT compiler registered before the class definitions run.
import "@angular/compiler";
import { ChangeDetectorRef, Injector, NgZone, runInInjectionContext } from "@angular/core";

// The built entry point, not the raw .ts: the source needs Angular's AOT
// decorator handling, which node's TS loader does not provide.
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
  component.orderId = "order-construct";
  component.metadata = { sku: "sticker-1" };
  component.ngOnChanges();

  const shell = component.shell;
  assert.notEqual(shell, null);
  assert.equal(shell.checkout.attributes["order-id"], "order-construct");
  assert.equal(shell.checkout.attributes.metadata, JSON.stringify({ sku: "sticker-1" }));
  assert.ok(shell.rootAttributes["data-openreceive-theme"]);
  // The shell root is directive-driven: every rootAttributes key must reach the
  // template's binding object, not a hand-transcribed [attr.*] subset.
  assert.deepEqual(component.rootBindings.attributes, shell.rootAttributes);
});

test("subsequent input changes rebuild the shell binding", () => {
  const component = constructComponent();
  component.orderId = "order-first";
  component.ngOnChanges();
  const first = component.shell;

  component.orderId = "order-second";
  component.ngOnChanges();
  const second = component.shell;

  assert.notEqual(second, first, "input changes must produce a fresh binding");
  assert.equal(second.checkout.attributes["order-id"], "order-second");
});
