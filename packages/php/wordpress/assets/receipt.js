for (const checkout of document.querySelectorAll("openreceive-checkout[data-thank-you]")) {
  // Checkout events are dispatched on the element and do not bubble.
  checkout.addEventListener("openreceive-settled", () => {
    window.location.assign(checkout.dataset.thankYou);
  });
}

// A swap screen shows one amount, the one to send. WooCommerce prints the
// order's total in its own order details above the checkout ("Total: $12.00"),
// and a payer who sends that number has not paid. It leaves the page while a
// swap is on screen and comes back with the method picker or Lightning. The
// inline style is deliberate: a theme's own `display` rule on these list items
// would beat the `hidden` attribute.
const ORDER_TOTAL = "ul.order_details li.total";
for (const checkout of document.querySelectorAll("openreceive-checkout")) {
  checkout.addEventListener("openreceive-state", (event) => {
    const swapOnScreen = event.detail?.state?.rail === "swap";
    for (const total of document.querySelectorAll(ORDER_TOTAL)) {
      total.style.display = swapOnScreen ? "none" : "";
    }
  });
}

// Refresh the authorized receipt on a later visit before its one-hour cookie expires.
const openedAt = Date.now();
window.addEventListener("focus", () => {
  if (Date.now() - openedAt > 45 * 60 * 1000) window.location.reload();
});
