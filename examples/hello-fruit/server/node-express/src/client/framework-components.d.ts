declare module "*.vue" {
  import type { DefineComponent } from "vue";

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

declare module "*.svelte" {
  import type { Component } from "svelte";

  const component: Component<Record<string, unknown>>;
  export default component;
}

declare module "@openreceive/angular/checkout-component" {
  import type { Type } from "@angular/core";

  export const CheckoutComponent: Type<unknown>;
}
