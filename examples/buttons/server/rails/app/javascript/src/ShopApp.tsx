import { MantineProvider, Text } from "@mantine/core";
import type React from "react";
import { useEffect, useState } from "react";
import { CheckoutStage } from "../../../../../shared/client/components/CheckoutStage.tsx";
import { ShopPanel } from "../../../../../shared/client/components/ShopPanel.tsx";
import { ShopStore } from "../../../../../shared/client/stores/ShopStore.ts";
import { shopTheme } from "../../../../../shared/client/theme.ts";
import type { ShopBootstrap } from "../../../../../shared/shop-types.ts";
import { startShopCable } from "./cable.ts";

// The bootstrap blob the ERB layout wrote. Reading it is the one thing this
// host does that the other stacks do differently — everything below the
// ShopPanel is shared.
const readBootstrap = (): ShopBootstrap | null => {
  const node = document.getElementById("__shop_bootstrap");
  if (!node?.textContent) return null;
  const parsed = JSON.parse(node.textContent) as { shop?: ShopBootstrap };
  return parsed.shop ?? null;
};

// One store, built once. `useState` with an initializer rather than a module
// constant: the `@model("or/…")` registry is global, and a module-level
// instance would be created at import time even on a page with no #root.
const createStore = (): ShopStore => {
  const store = new ShopStore({});
  const bootstrap = readBootstrap();
  if (bootstrap) store.hydrate(bootstrap);
  return store;
};

/**
 * The Rails host.
 *
 * `renderCheckout` is the seam described in shared/client/components/ShopPanel:
 * this stack plugs in the keystone-driven CheckoutStage, which drives the
 * headless engine directly. node-express plugs in the framework-tabbed packaged
 * <Checkout> instead — same shop, same routes, a different payment screen.
 *
 * `startShopCable` is the other seam: the shared stores expose
 * `setPushConnected` / `refreshFromPush` / `confirmSettlement` and know nothing
 * about how news reaches them, so the Rails-specific ActionCable transport
 * lives beside this host and nowhere else.
 */
export const ShopApp: React.FC = () => {
  const [shop] = useState(createStore);

  // The host's realtime transport, plugged into the stores' push seams. The
  // shop itself knows nothing about websockets; see cable.ts.
  useEffect(() => startShopCable(shop), [shop]);

  return (
    <MantineProvider theme={shopTheme} defaultColorScheme="light">
      <main className="or-page">
        <div className="or-page-inner">
          <ShopPanel shop={shop} renderCheckout={() => <CheckoutStage shop={shop} />} />
          <Text className="or-page-note">Rails + Postgres.</Text>
        </div>
      </main>
    </MantineProvider>
  );
};
