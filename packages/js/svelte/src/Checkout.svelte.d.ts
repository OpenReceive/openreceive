// Hand-written module shape for the shipped SFC (the raw component is copied into dist
// by the package build, so no compiler emits this). The props themselves come from the
// shared wrapper type, so the surface exists in exactly one place.
//
// Typed as Svelte 5's `Component`, not a `SvelteComponent` subclass: the peer
// is Svelte >= 5, where `new Checkout(...)` throws and `mount()` is the only
// way in — a class typing advertised an instantiation that fails.
import type { Component } from "svelte";
import type { WrapperCheckoutComponentProps } from "./index.js";

export type SvelteCheckoutProps = WrapperCheckoutComponentProps;

declare const Checkout: Component<SvelteCheckoutProps>;
export default Checkout;
