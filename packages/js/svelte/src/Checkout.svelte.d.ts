// Hand-written types for the shipped SFC (the raw component is copied into dist by the
// package build, so no compiler emits these). Kept in step with Checkout.svelte and with
// docs/internal/wrapper-parity.md.
import { SvelteComponent } from "svelte";
import type {
  CheckoutShellOptions,
  CheckoutSnapshot,
  OpenReceiveThemePreference,
} from "./index.js";

export interface OpenReceiveSvelteCheckoutProps {
  /** Snapshot mode: render this checkout directly. */
  checkout?: CheckoutSnapshot;
  /** Create mode: the element creates the checkout for this order, then renders and polls. */
  orderId?: string;
  prefix?: string;
  orderUrl?: string;
  paymentWizard?: boolean;
  /** Base URL of an external bolt11 decoder; omitted, no "Decode" link is rendered. */
  decodeLinkUrl?: string;
  /** Default true: the shell owns `data-theme` and renders the package theme toggle. */
  themeToggle?: boolean;
  defaultTheme?: OpenReceiveThemePreference;
  storageKey?: string;
  /** Create mode only. */
  metadata?: Record<string, unknown>;
  /** Create mode only. */
  syncUrl?: boolean;
  /** Create mode only. */
  resumePathPrefix?: string;
  /** Create mode only. */
  routeOrderId?: string;
  onCopy?: (event: Event) => void;
  onOpenWallet?: (event: Event) => void;
  onState?: (event: Event) => void;
  onSettled?: (event: Event) => void;
  onProviderCopy?: (event: Event) => void;
  onStartOver?: (event: Event) => void;
  onError?: (event: Event) => void;
  options?: CheckoutShellOptions;
}

export default class Checkout extends SvelteComponent<
  OpenReceiveSvelteCheckoutProps,
  Record<string, never>,
  Record<string, never>
> {}
