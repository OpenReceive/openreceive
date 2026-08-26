// The create/snapshot prop surface every OpenReceive checkout component
// exposes, and the boundary check that reads it. It lives in the browser
// package because that is the floor all of them share: React renders the
// checkout itself (docs/internal/wrapper-parity.md), so it must not reach into
// @openreceive/elements for a prop contract the element wrappers also use.
//
// Prop names, defaults, and per-mode applicability are the shared contract in
// docs/internal/wrapper-parity.md; tests/wrapper-parity.test.mjs enforces it
// against the shipped source of all four framework packages.

import type { CheckoutSnapshot, ThemePreference } from "./checkout-types.ts";

/**
 * The flat prop surface of an OpenReceive checkout component. Every framework
 * package derives its props from this — directly (React, Vue) or by declaring
 * the same names because its prop syntax cannot be generated from a type
 * (Svelte, Angular). Framework-only additions (React's component/class-name
 * slots, the element wrappers' `options` escape hatch) sit beside it.
 */
export interface CheckoutComponentProps {
  /** Snapshot mode: render this checkout directly. */
  readonly checkout?: CheckoutSnapshot;
  /** Create mode: the component creates the checkout for this reference, then renders and polls. */
  readonly reference?: string;
  /**
   * Base path the shipped router is mounted at. Default `/openreceive`. The ONLY
   * URL input: create, prepare, payment-check and the four swap routes are all
   * derived from it (see `checkoutRoutes` in ./routes.ts).
   */
  readonly prefix?: string;
  readonly paymentWizard?: boolean;
  /**
   * Base URL of an external bolt11 decoder. Omitted (the default), no "Decode" link is
   * rendered and the invoice is never sent to a third party.
   */
  readonly decodeLinkUrl?: string;
  /**
   * Where this app serves the packages' `dist/assets` trees, as one base URL —
   * the string form of the `resolveAssetUrl` seam. Packaged icon and tutorial
   * keys are relative paths under one `assets/` root, so the value is joined to
   * them directly: `assetBaseUrl="/openreceive-assets"` loads
   * `assets/icons/btc.svg` from `/openreceive-assets/assets/icons/btc.svg`.
   * Needed under every bundler that does not rewrite `import.meta.url` — see
   * docs/guides/provider-registry.md.
   */
  readonly assetBaseUrl?: string;
  /** Default true: the checkout owns `data-theme` and renders the package theme toggle. */
  readonly themeToggle?: boolean;
  readonly defaultTheme?: ThemePreference;
  readonly storageKey?: string;
  /** Create mode only: metadata sent with the create request. */
  readonly metadata?: Record<string, unknown>;
  /**
   * Create mode only. Opt into History API URL sync to `{resumePathPrefix}/{reference}`
   * (default `/checkout/:id`). Off by default — many hosts own routing themselves — and
   * skipped when `routeReference` is set. This controls URL mutation only; order-resume
   * data remains a host concern.
   */
  readonly syncUrl?: boolean;
  /** Create mode only. History API path prefix when `syncUrl` is set. Default `/checkout`. */
  readonly resumePathPrefix?: string;
  /**
   * Create mode only. Order id from the app router (e.g. Next.js). When set, the component
   * does not push/replace the URL itself.
   */
  readonly routeReference?: string;
}

/** Which props only do something in create mode (no `checkout` snapshot). */
const CREATE_MODE_ONLY_PROPS = [
  "metadata",
  "syncUrl",
  "resumePathPrefix",
  "routeReference",
] as const;

type CreateModeOnlyProp = (typeof CREATE_MODE_ONLY_PROPS)[number];

const warnedSnapshotModeProps = new Set<string>();

/**
 * What the check reads: the two mode props plus the create-only ones, derived
 * from the list above so the names exist once.
 */
export interface CheckoutPropsValidation
  extends Pick<CheckoutComponentProps, CreateModeOnlyProp | "reference"> {
  readonly framework: string;
  /** `null` as well as `undefined`: Angular binds an absent snapshot input as null. */
  readonly checkout?: CheckoutSnapshot | null;
  readonly warn?: (message: string) => void;
}

/**
 * Boundary check for the checkout components: without it the missing-mode failure surfaces
 * as a `TypeError` thrown from inside a computed/reactive statement (in Angular, on every
 * change-detection pass) rather than as one clear error where the props are read.
 */
export function validateCheckoutProps(props: CheckoutPropsValidation): void {
  const snapshot = props.checkout ?? null;
  if (snapshot === null && (props.reference === undefined || props.reference.length === 0)) {
    throw new TypeError(
      `${props.framework} Checkout requires a checkout snapshot or a reference (create mode).`,
    );
  }
  if (snapshot === null) return;
  const ignored = CREATE_MODE_ONLY_PROPS.filter((name) => props[name] !== undefined);
  if (ignored.length === 0) return;
  const key = `${props.framework}:${ignored.join(",")}`;
  if (warnedSnapshotModeProps.has(key)) return;
  warnedSnapshotModeProps.add(key);
  const warn = props.warn ?? ((message: string) => globalThis.console?.warn?.(message));
  warn(
    `${props.framework} Checkout ignores ${ignored.join(", ")} in snapshot mode; ` +
      "those props only apply when the component creates the checkout from a reference.",
  );
}
