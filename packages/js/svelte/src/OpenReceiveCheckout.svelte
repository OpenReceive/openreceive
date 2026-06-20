<script lang="ts">
  import {
    createOpenReceiveSvelteCheckoutShellBinding,
    defineOpenReceiveElements,
    type OpenReceiveCheckoutElementListeners,
    type OpenReceiveCheckoutShellOptions,
    type OpenReceiveCheckoutSnapshot
  } from "./index.js";

  export let snapshot: OpenReceiveCheckoutSnapshot;
  export let options: OpenReceiveCheckoutShellOptions = {};

  $: shell = createOpenReceiveSvelteCheckoutShellBinding(snapshot, options);

  if (typeof window !== "undefined") {
    defineOpenReceiveElements();
  }

  function checkoutListeners(node: HTMLElement, listeners: OpenReceiveCheckoutElementListeners) {
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
      update(nextListeners: OpenReceiveCheckoutElementListeners) {
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
