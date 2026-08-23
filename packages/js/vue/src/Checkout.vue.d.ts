// Hand-written module shape for the shipped SFC (the raw component is copied into dist
// by the package build, so no compiler emits this). The props themselves come from the
// shared wrapper type, so the surface exists in exactly one place.
import type { DefineComponent } from "vue";
import type { WrapperCheckoutComponentProps } from "./index.js";

export type VueCheckoutProps = WrapperCheckoutComponentProps;

declare const Checkout: DefineComponent<VueCheckoutProps>;

export default Checkout;
