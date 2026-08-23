# @openreceive/angular

Angular wrapper for the OpenReceive checkout custom element.

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
@import "@openreceive/angular/styles.css";
```

Three names, one checkout: the exported class is `CheckoutComponent`, its
Angular selector is `openreceive-angular-checkout`, and it renders the
`<openreceive-checkout>` custom element inside itself (defining it on mount).

Pass `reference` to let the element create the checkout (create mode), or pass a
`checkout` snapshot to render one your server already created. Prop names,
defaults, and the full surface are shared across the wrappers — see
`docs/internal/wrapper-parity.md` in the repository.

Event handlers (`onCopy`, `onOpenWallet`, `onState`, `onSettled`,
`onProviderCopy`, `onStartOver`, `onError`) are `@Input()` props, not Angular
`@Output()` events: bind them as inputs (`[onSettled]="handler"`), not with
`(settled)="..."`. Each receives the DOM `CustomEvent` the element dispatches.

Part of [OpenReceive](https://openreceive.org). Start with the [Node quickstart](https://github.com/openreceive/openreceive/blob/master/docs/guides/quickstart-node.md); the full API is in the [API reference](https://github.com/openreceive/openreceive/blob/master/docs/guides/api-reference.md).
