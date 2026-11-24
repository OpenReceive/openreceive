// What a checkout modal (the wallet walkthrough) needs once it is on screen,
// shared by the React checkout and the custom element so both behave alike on
// a phone. Found by the Android lab (tests/android) on 2026-11-23.

interface CloseWatcherLike {
  onclose: (() => void) | null;
  destroy(): void;
}

type CloseWatcherConstructor = new () => CloseWatcherLike;

/**
 * Open `overlay` (the modal's backdrop; its first child is the box): focus it,
 * bring the box into view, and let Android's Back close it. Returns the
 * cleanup to run when the modal closes, by whatever route.
 *
 * - Focus moves in without scrolling the page.
 * - The box is scrolled into view when it is off the screen. Chrome 124, and
 *   any engine that still treats the checkout's size container as the
 *   containing block of a fixed overlay, centred it in the whole checkout
 *   column, a screen or more below the invoice: the payer saw a dimmed page and
 *   nothing to read. Where the overlay is fixed to the screen this does nothing.
 * - Back closes the modal instead of leaving the page, through a CloseWatcher
 *   (Chromium 120 and later). Pressing Back on Android with the walkthrough
 *   open took the payer to the shop's home page with an empty cart. Browsers
 *   without CloseWatcher keep Escape and the close button, and the page's
 *   history is never touched.
 */
export function openCheckoutModal(overlay: HTMLElement, close: () => void): () => void {
  overlay.focus({ preventScroll: true });
  const box = overlay.firstElementChild;
  if (box instanceof HTMLElement && typeof box.scrollIntoView === "function") {
    const rect = box.getBoundingClientRect();
    const screenHeight = overlay.ownerDocument.defaultView?.innerHeight ?? 0;
    if (rect.height > 0 && (rect.top < 0 || rect.bottom > screenHeight)) {
      box.scrollIntoView({ block: "center" });
    }
  }
  const Watcher = (globalThis as { CloseWatcher?: CloseWatcherConstructor }).CloseWatcher;
  if (typeof Watcher !== "function") return () => {};
  let watcher: CloseWatcherLike;
  try {
    watcher = new Watcher();
  } catch {
    return () => {};
  }
  watcher.onclose = close;
  return () => {
    watcher.onclose = null;
    watcher.destroy();
  };
}
