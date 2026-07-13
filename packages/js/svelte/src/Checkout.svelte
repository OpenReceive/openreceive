<script lang="ts">
  import {
    createOpenReceiveSvelteCheckoutShellBinding,
    defineOpenReceiveElements,
    type CheckoutElementListeners,
    type CheckoutShellOptions,
    type CheckoutSnapshot
  } from "./index.js";

  // Snapshot mode: pass a `checkout` to render it directly (backward compatible).
  // Create mode: omit `checkout` and pass `orderId` (+ optional `prefix`); the underlying
  // <openreceive-checkout> element creates the checkout, then renders and polls itself.
  // With `resume`, also fetches GET …/orders/{id}/summary and emits `openreceive-summary`.
  export let checkout: CheckoutSnapshot | undefined = undefined;
  export let orderId: string | undefined = undefined;
  export let prefix: string | undefined = undefined;
  export let metadata: Record<string, unknown> | undefined = undefined;
  export let orderUrl: string | undefined = undefined;
  export let resume: boolean | undefined = undefined;
  export let resumePathPrefix: string | undefined = undefined;
  export let routeOrderId: string | undefined = undefined;
  export let onSettled: ((event: Event) => void) | undefined = undefined;
  export let onStartOver: ((event: Event) => void) | undefined = undefined;
  export let onSummary: ((event: Event) => void) | undefined = undefined;
  export let options: CheckoutShellOptions = {};

  $: shell = createOpenReceiveSvelteCheckoutShellBinding(checkout ?? null, {
    ...options,
    ...(orderId === undefined ? {} : { orderId }),
    ...(prefix === undefined ? {} : { prefix }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(orderUrl === undefined ? {} : { orderUrl }),
    ...(resume === undefined ? {} : { resume }),
    ...(resumePathPrefix === undefined ? {} : { resumePathPrefix }),
    ...(routeOrderId === undefined ? {} : { routeOrderId }),
    ...(onSettled === undefined ? {} : { onSettled }),
    ...(onStartOver === undefined ? {} : { onStartOver }),
    ...(onSummary === undefined ? {} : { onSummary })
  });

  if (typeof window !== "undefined") {
    defineOpenReceiveElements();
  }

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
      }
    };
  }
</script>

<section {...shell.rootProps}>
  <svelte:element
    this={shell.themeToggle.tagName}
    {...shell.themeToggle.props}
  />
  <svelte:element
    this={shell.checkout.tagName}
    {...shell.checkout.props}
    use:checkoutListeners={shell.checkout.events}
  />
</section>
