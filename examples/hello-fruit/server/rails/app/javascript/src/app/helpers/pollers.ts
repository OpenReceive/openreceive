import type { ShopWorkspace } from "../stores/ShopWorkspace.ts";

let started = false;

/**
 * The countdown clock, and nothing else.
 *
 * Payment-status polling is not here: `CheckoutFlow` drives the packaged
 * `createCheckoutController`, which owns the interval, the one-at-a-time rule,
 * Retry-After backoff and the stop rules for a settled or terminal attempt.
 * ActionCable (solid_cable) rides on top for instant settlement pushes — see
 * actionCable.ts.
 */
export function startHelloFruitPollers(workspace: ShopWorkspace): void {
  if (started) return;
  started = true;
  setInterval(() => {
    workspace.checkout?.setNow(Math.floor(Date.now() / 1000));
  }, 1000);
}
