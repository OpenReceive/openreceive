import { Component, CUSTOM_ELEMENTS_SCHEMA, Input } from "@angular/core";
import {
  OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS,
  createOpenReceiveAngularCheckoutShellBinding,
  defineOpenReceiveElements
} from "./index.js";

export class CheckoutComponent {
  snapshot;
  options = {};

  ngOnInit() {
    defineOpenReceiveElements();
  }

  get shell() {
    return createOpenReceiveAngularCheckoutShellBinding(
      this.snapshot,
      this.options
    );
  }

  get rootAttributes() {
    return this.shell.rootAttributes;
  }

  get checkoutAttributes() {
    return this.shell.checkout.attributes;
  }

  get themeToggleAttributes() {
    return this.shell.themeToggle.attributes;
  }

  onCheckoutEvent(eventName, event) {
    this.shell.checkout.events[eventName]?.(event);
  }
}

Input({ required: true })(CheckoutComponent.prototype, "snapshot");
Input()(CheckoutComponent.prototype, "options");

Component({
  selector: "openreceive-angular-checkout",
  standalone: true,
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <section
      [attr.data-theme]="rootAttributes['data-theme']"
      [attr.data-openreceive-theme]="rootAttributes['data-openreceive-theme']"
    >
      <openreceive-theme-toggle
        [attr.root-selector]="themeToggleAttributes['root-selector']"
        [attr.checkout-selector]="themeToggleAttributes['checkout-selector']"
        [attr.default-theme]="themeToggleAttributes['default-theme']"
        [attr.storage-key]="themeToggleAttributes['storage-key']"
      ></openreceive-theme-toggle>
      <openreceive-checkout
        [attr.invoice-id]="checkoutAttributes['invoice-id']"
        [attr.invoice]="checkoutAttributes.invoice"
        [attr.payment-hash]="checkoutAttributes['payment-hash']"
        [attr.amount-msats]="checkoutAttributes['amount-msats']"
        [attr.status]="checkoutAttributes.status"
        [attr.expires-at]="checkoutAttributes['expires-at']"
        [attr.status-url]="checkoutAttributes['status-url']"
        [attr.theme]="checkoutAttributes.theme"
        [attr.payment-wizard]="checkoutAttributes['payment-wizard']"
        (openreceive-copy)="onCheckoutEvent(openReceiveEvents.copy, $event)"
        (openreceive-open-wallet)="onCheckoutEvent(openReceiveEvents.openWallet, $event)"
        (openreceive-state)="onCheckoutEvent(openReceiveEvents.state, $event)"
        (openreceive-settled)="onCheckoutEvent(openReceiveEvents.settled, $event)"
        (openreceive-error)="onCheckoutEvent(openReceiveEvents.error, $event)"
        (openreceive-provider-copy)="onCheckoutEvent(openReceiveEvents.providerCopy, $event)"
      ></openreceive-checkout>
    </section>
  `
})(CheckoutComponent);

CheckoutComponent.prototype.openReceiveEvents = OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS;
