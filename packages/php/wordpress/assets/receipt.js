for (const checkout of document.querySelectorAll("openreceive-checkout[data-thank-you]")) {
  // Checkout events are dispatched on the element and do not bubble.
  checkout.addEventListener("openreceive-settled", () => {
    window.location.assign(checkout.dataset.thankYou);
  });
}

// Refresh the authorized receipt on a later visit before its one-hour cookie expires.
const openedAt = Date.now();
window.addEventListener("focus", () => {
  if (Date.now() - openedAt > 45 * 60 * 1000) window.location.reload();
});
