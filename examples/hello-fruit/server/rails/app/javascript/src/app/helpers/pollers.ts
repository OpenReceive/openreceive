import { OPENRECEIVE_DEFAULT_POLL_INTERVAL_MS } from "@openreceive/browser/headless";
import type { ShopWorkspace } from "../stores/ShopWorkspace.ts";

let started = false;

/**
 * Browser polling is the baseline transport: one payment-status tick every
 * 3 s (the flow itself enforces in-flight/backoff/terminal rules), plus a 1 s
 * clock tick for countdowns. ActionCable (solid_cable) rides on top for
 * instant settlement pushes — see actionCable.ts.
 */
export function startHelloFruitPollers(workspace: ShopWorkspace): void {
  if (started) return;
  started = true;
  setInterval(() => {
    const checkout = workspace.checkout;
    if (checkout !== null) void checkout.pollTick();
  }, OPENRECEIVE_DEFAULT_POLL_INTERVAL_MS);
  setInterval(() => {
    workspace.checkout?.setNow(Math.floor(Date.now() / 1000));
  }, 1000);
}
