// Hand-written module shape for the shipped SFC (the raw component is copied into dist
// by the package build, so no compiler emits this). The props themselves come from the
// shared wrapper type, so the surface exists in exactly one place.
import { SvelteComponent } from "svelte";
import type { WrapperCheckoutComponentProps } from "./index.js";

export type SvelteCheckoutProps = WrapperCheckoutComponentProps;

export default class Checkout extends SvelteComponent<
  SvelteCheckoutProps,
  Record<string, never>,
  Record<string, never>
> {}
