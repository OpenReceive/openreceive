<script lang="ts">
  import {
    createOpenReceiveSvelteCheckoutShellBinding,
    defineOpenReceiveElements,
    type CheckoutElementListeners,
    type CheckoutShellOptions,
    type CheckoutSnapshot
  } from "./index.js";

  export let checkout: CheckoutSnapshot;
  export let statusUrl: string | undefined = undefined;
  export let onSettled: ((event: Event) => void) | undefined = undefined;
  export let onStartOver: ((event: Event) => void) | undefined = undefined;
  export let options: CheckoutShellOptions = {};

  $: shell = createOpenReceiveSvelteCheckoutShellBinding(checkout, {
    ...options,
    ...(statusUrl === undefined ? {} : { statusUrl }),
    ...(onSettled === undefined ? {} : { onSettled }),
    ...(onStartOver === undefined ? {} : { onStartOver })
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
