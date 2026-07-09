import { Component, CUSTOM_ELEMENTS_SCHEMA, Input } from "@angular/core";
import {
  OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS,
  createOpenReceiveAngularCheckoutShellBinding,
  defineOpenReceiveElements
} from "./index.js";

export class CheckoutComponent {
  // Snapshot mode: bind a `checkout` to render it directly (backward compatible).
  // Create mode: omit `checkout` and bind `orderId` (+ optional `prefix`); the underlying
  // <openreceive-checkout> element creates the checkout, then renders and polls itself.
  checkout;
  orderId;
  prefix;
  metadata;
  orderUrl;
  onSettled;
  onStartOver;
  options = {};

  ngOnInit() {
    defineOpenReceiveElements();
  }

  get shell() {
    const options = {
      ...this.options,
      ...(this.orderId === undefined ? {} : { orderId: this.orderId }),
      ...(this.prefix === undefined ? {} : { prefix: this.prefix }),
      ...(this.metadata === undefined ? {} : { metadata: this.metadata }),
      ...(this.orderUrl === undefined ? {} : { orderUrl: this.orderUrl }),
      ...(this.onSettled === undefined ? {} : { onSettled: this.onSettled }),
      ...(this.onStartOver === undefined ? {} : { onStartOver: this.onStartOver })
    };
    return createOpenReceiveAngularCheckoutShellBinding(
      this.checkout ?? null,
      options
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

Input()(CheckoutComponent.prototype, "checkout");
Input()(CheckoutComponent.prototype, "orderId");
Input()(CheckoutComponent.prototype, "prefix");
Input()(CheckoutComponent.prototype, "metadata");
Input()(CheckoutComponent.prototype, "orderUrl");
Input()(CheckoutComponent.prototype, "onSettled");
Input()(CheckoutComponent.prototype, "onStartOver");
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
        [attr.order-id]="checkoutAttributes['order-id']"
        [attr.prefix]="checkoutAttributes.prefix"
        [attr.invoice-id]="checkoutAttributes['invoice-id']"
        [attr.invoice]="checkoutAttributes.invoice"
        [attr.payment-hash]="checkoutAttributes['payment-hash']"
        [attr.amount-msats]="checkoutAttributes['amount-msats']"
        [attr.status]="checkoutAttributes.status"
        [attr.expires-at]="checkoutAttributes['expires-at']"
        [attr.order-url]="checkoutAttributes['order-url']"
        [attr.theme]="checkoutAttributes.theme"
        [attr.payment-wizard]="checkoutAttributes['payment-wizard']"
        (openreceive-copy)="onCheckoutEvent(openReceiveEvents.copy, $event)"
        (openreceive-open-wallet)="onCheckoutEvent(openReceiveEvents.openWallet, $event)"
        (openreceive-state)="onCheckoutEvent(openReceiveEvents.state, $event)"
        (openreceive-settled)="onCheckoutEvent(openReceiveEvents.settled, $event)"
        (openreceive-start-over)="onCheckoutEvent(openReceiveEvents.startOver, $event)"
        (openreceive-error)="onCheckoutEvent(openReceiveEvents.error, $event)"
        (openreceive-provider-copy)="onCheckoutEvent(openReceiveEvents.providerCopy, $event)"
      ></openreceive-checkout>
    </section>
  `
})(CheckoutComponent);

CheckoutComponent.prototype.openReceiveEvents = OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS;
