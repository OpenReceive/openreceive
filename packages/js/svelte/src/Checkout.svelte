<script lang="ts">
  import {
    createOpenReceiveSvelteCheckoutShellBinding,
    defineOpenReceiveElements,
    type CheckoutElementListeners,
    type CheckoutShellOptions,
    type CheckoutSnapshot
  } from "./index.js";

  export let snapshot: CheckoutSnapshot;
  export let options: CheckoutShellOptions = {};

  $: shell = createOpenReceiveSvelteCheckoutShellBinding(snapshot, options);

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
