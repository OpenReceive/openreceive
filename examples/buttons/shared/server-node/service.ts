/**
 * The OpenReceive service, in whichever wallet mode the demo was booted in.
 *
 * `DEMO_WALLET=testkit` swaps ONLY the wallet, the swap provider and the price
 * feed for the in-memory `@openreceive/testkit` fakes — no NWC_URI, no network.
 * Every other code path (the store, the routes, the three hooks, the production
 * wiring) is identical, which is the property that makes the E2E harness worth
 * trusting.
 *
 * Shared by all three Node stacks so that "testkit mode" means exactly one
 * thing. The Hello Fruit demo this replaces had the branch in its Express app
 * only, and its Next.js stack quietly handed the testkit sentinel to a real
 * wallet client.
 */

import { StaticPriceProvider } from "@openreceive/core";
import { createOpenReceive, type OpenReceive } from "@openreceive/node";
import { createTestkitReceiveClient, createTestkitSwapProvider } from "@openreceive/testkit";
import { config } from "./openreceive-config.ts";
import { readRequiredShopNwcConnectionString, shopWalletMode } from "./nwc.ts";
import type { ShopTestkitFixtures } from "./testkit-controls.ts";

export interface ShopService {
  readonly service: OpenReceive;
  /** Present in testkit mode only. `undefined` turns the control surface into a 404. */
  readonly testkit: ShopTestkitFixtures | undefined;
}

type ShopLogger = (event: string, message: string, fields?: Record<string, unknown>) => void;

export const createShopService = async (log: ShopLogger): Promise<ShopService> => {
  if (shopWalletMode() === "testkit") {
    const testkit: ShopTestkitFixtures = {
      client: createTestkitReceiveClient(),
      swap: createTestkitSwapProvider(),
    };
    const service = await createOpenReceive({
      ...config,
      client: testkit.client,
      priceProviders: [new StaticPriceProvider()],
      swap: { provider: testkit.swap },
    });
    log("openreceive.testkit", "Testkit wallet mode: in-memory fakes, no NWC connection.", {
      controlPrefix: "/__testkit",
    });
    return { service, testkit };
  }

  // Boot refuses a missing or invalid NWC before any route is served.
  const service = await createOpenReceive({
    ...config,
    nwc: readRequiredShopNwcConnectionString(),
  });
  log("openreceive.ready", "OpenReceive service ready.", {
    priceCurrencies: service.priceCurrencies,
  });
  return { service, testkit: undefined };
};
