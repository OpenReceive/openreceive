<script lang="ts">
import { onMount } from "svelte";
import {
  createOpenReceiveWrapperCheckoutShellBinding,
  defineOpenReceiveElements,
  validateOpenReceiveCheckoutProps,
  type CheckoutElementListeners,
  type CheckoutShellOptions,
  type CheckoutSnapshot,
  type OpenReceiveThemePreference,
} from "./index.js";

// Prop names, defaults, and per-mode applicability are the shared contract in
// docs/internal/wrapper-parity.md. This list RESTATES it because Svelte props
// are declarations, not a type: `export let` (and `let { … } = $props()` under
// runes) has to name every prop, so it cannot be derived from
// OpenReceiveWrapperCheckoutComponentProps the way Vue's defineProps and
// React's CheckoutProps are. The duplication is forced, not neglected;
// tests/wrapper-parity.test.mjs is what keeps it in step.
// Snapshot mode: pass a `checkout` to render it directly.
// Create mode: omit `checkout` and pass `orderId` (+ optional `prefix`); the underlying
// <openreceive-checkout> element creates the checkout, then renders and polls itself.
export let checkout: CheckoutSnapshot | undefined = undefined;
export let orderId: string | undefined = undefined;
export let prefix: string | undefined = undefined;
export let paymentWizard: boolean | undefined = undefined;
export let decodeLinkUrl: string | undefined = undefined;
export let themeToggle: boolean | undefined = undefined;
export let defaultTheme: OpenReceiveThemePreference | undefined = undefined;
export let storageKey: string | undefined = undefined;
// Create mode only.
export let metadata: Record<string, unknown> | undefined = undefined;
export let syncUrl: boolean | undefined = undefined;
export let resumePathPrefix: string | undefined = undefined;
export let routeOrderId: string | undefined = undefined;
export let onCopy: ((event: Event) => void) | undefined = undefined;
export let onOpenWallet: ((event: Event) => void) | undefined = undefined;
export let onState: ((event: Event) => void) | undefined = undefined;
export let onSettled: ((event: Event) => void) | undefined = undefined;
export let onProviderCopy: ((event: Event) => void) | undefined = undefined;
export let onStartOver: ((event: Event) => void) | undefined = undefined;
export let onError: ((event: Event) => void) | undefined = undefined;
export let options: CheckoutShellOptions = {};

// Storage and matchMedia only exist in the browser: resolving the theme before mount
// would make a server-rendered shell disagree with the first client render.
let mounted = false;

onMount(() => {
  defineOpenReceiveElements();
  mounted = true;
});

$: validateOpenReceiveCheckoutProps({
  framework: "@openreceive/svelte",
  checkout,
  orderId,
  metadata,
  syncUrl,
  resumePathPrefix,
  routeOrderId,
});

$: shell = createOpenReceiveWrapperCheckoutShellBinding(checkout ?? null, {
  ...options,
  themeToggle: themeToggle ?? options.themeToggle ?? true,
  deferThemeResolution: !mounted,
  ...(orderId === undefined ? {} : { orderId }),
  ...(prefix === undefined ? {} : { prefix }),
  ...(paymentWizard === undefined ? {} : { paymentWizard }),
  ...(decodeLinkUrl === undefined ? {} : { decodeLinkUrl }),
  ...(defaultTheme === undefined ? {} : { defaultTheme }),
  ...(storageKey === undefined ? {} : { storageKey }),
  ...(metadata === undefined ? {} : { metadata }),
  ...(syncUrl === undefined ? {} : { syncUrl }),
  ...(resumePathPrefix === undefined ? {} : { resumePathPrefix }),
  ...(routeOrderId === undefined ? {} : { routeOrderId }),
  ...(onCopy === undefined ? {} : { onCopy }),
  ...(onOpenWallet === undefined ? {} : { onOpenWallet }),
  ...(onState === undefined ? {} : { onState }),
  ...(onSettled === undefined ? {} : { onSettled }),
  ...(onProviderCopy === undefined ? {} : { onProviderCopy }),
  ...(onStartOver === undefined ? {} : { onStartOver }),
  ...(onError === undefined ? {} : { onError }),
});

// biome-ignore lint/correctness/noUnusedVariables: applied by the use: directive below, which biome does not read.
function checkoutListeners(node: HTMLElement, listeners: CheckoutElementListeners) {
  let activeListeners = listeners;

  const attach = () => {
    for (const [name, listener] of Object.entries(activeListeners)) {
      if (listener !== undefined) {
        node.addEventListener(name, listener);
      }
    }
  };
  const detach = () => {
    for (const [name, listener] of Object.entries(activeListeners)) {
      if (listener !== undefined) {
        node.removeEventListener(name, listener);
      }
    }
  };

  attach();

  return {
    update(nextListeners: CheckoutElementListeners) {
      detach();
      activeListeners = nextListeners;
      attach();
    },
    destroy() {
      detach();
    },
  };
}
</script>

<section {...shell.rootAttributes}>
  {#if shell.themeToggle}
    <svelte:element
      this={shell.themeToggle.tagName}
      {...shell.themeToggle.attributes}
    />
  {/if}
  <svelte:element
    this={shell.checkout.tagName}
    {...shell.checkout.attributes}
    use:checkoutListeners={shell.checkout.listeners}
  />
</section>
