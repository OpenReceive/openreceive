// Hand-written module shape for the shipped component. The package build compiles
// Checkout.vue into dist/Checkout.js (tools/package/compile-vue-sfc.mjs), which
// emits JavaScript only, so this file types it. The props themselves come from the
// shared wrapper type, so the surface exists in exactly one place.
import type { DefineComponent } from "vue";
import type { WrapperCheckoutComponentProps } from "./index.js";

export type VueCheckoutProps = WrapperCheckoutComponentProps;

declare const Checkout: DefineComponent<VueCheckoutProps>;

export default Checkout;
