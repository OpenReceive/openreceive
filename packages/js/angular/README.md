# @openreceive/angular

Add Bitcoin Lightning checkout to your Angular app with a standalone
component. Give it an order reference to show payment choices, QR codes, and
live payment status. The component wraps the shared OpenReceive custom
element and fits into your existing checkout page.

OpenReceive supports optional swaps from **USDT, USDC, SOL, and ETH** through
a configured swap provider. The provider converts the payment to **BTC over
Lightning**, which settles into the merchant's connected wallet. Available
assets and networks depend on the provider; swaps are optional.

Pair this browser package with an OpenReceive server integration. Your server
authorizes the order, sets the amount, configures swaps, and verifies
settlement; wallet and provider credentials stay on the server.

## Install

Use Node.js 22 or later for package tooling and Angular 17 or later.

```sh
npm install @openreceive/angular
```

Follow the [frontend checkout guide](https://github.com/openreceive/openreceive/blob/master/docs/guides/frontend-checkout.md)
to connect the component to your server routes. Use the server-side payment
hook to fulfill orders; browser callbacks update the interface.

## Mount

The standalone component ships on the `@openreceive/angular/checkout-component`
subpath; import the checkout styles once (e.g. in your global stylesheet or the
`styles` array of `angular.json`).

```ts
import { Component } from "@angular/core";
import { CheckoutComponent } from "@openreceive/angular/checkout-component";

@Component({
  selector: "app-checkout-page",
  standalone: true,
  imports: [CheckoutComponent],
  template: `
    <openreceive-angular-checkout reference="order-123" [onSettled]="onSettled" />
  `,
})
export class CheckoutPageComponent {
  onSettled = () => console.log("paid");
}
```

```css
/* Scoped to what OpenReceive renders: safe next to any CSS framework, in any order. */
@import "@openreceive/angular/styles.css";
```

Three names, one checkout: the exported class is `CheckoutComponent`, its
Angular selector is `openreceive-angular-checkout`, and it renders the
`<openreceive-checkout>` custom element inside itself (defining it on mount).

Pass `reference` to let the element create the checkout (create mode), or pass a
`checkout` snapshot to render one your server already created. Prop names,
defaults, and the full surface are shared across the wrappers — see
[frontend checkout guide](https://github.com/openreceive/openreceive/blob/master/docs/guides/frontend-checkout.md).

Event handlers (`onCopy`, `onOpenWallet`, `onState`, `onSettled`,
`onProviderCopy`, `onStartOver`, `onError`) are `@Input()` props, not Angular
`@Output()` events: bind them as inputs (`[onSettled]="handler"`), not with
`(settled)="..."`. Each receives the DOM `CustomEvent` the element dispatches.

Part of [OpenReceive](https://openreceive.org). Start with the [Node quickstart](https://github.com/openreceive/openreceive/blob/master/docs/guides/quickstart-node.md); the full API is in the [API reference](https://github.com/openreceive/openreceive/blob/master/docs/guides/api-reference.md).
