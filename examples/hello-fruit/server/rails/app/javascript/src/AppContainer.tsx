import { observer } from "mobx-react";
import type React from "react";
import { useContext, useEffect } from "react";
import CheckoutPanel from "./app/components/CheckoutPanel.tsx";
import OrderPanel from "./app/components/OrderPanel.tsx";
import ProductHeader from "./app/components/ProductHeader.tsx";
import ShopPanel from "./app/components/ShopPanel.tsx";
import StickerModal from "./app/components/StickerModal.tsx";
import ThemeToggle from "./app/components/ThemeToggle.tsx";
import { startOrderActionCable } from "./app/helpers/actionCable.ts";
import { logDemo } from "./app/helpers/logging.ts";
import { startHelloFruitPollers } from "./app/helpers/pollers.ts";
import { ShopWorkspaceContext } from "./app/stores/ShopWorkspace.ts";

const AppContainer: React.FC = observer(() => {
  const workspace = useContext(ShopWorkspaceContext);

  useEffect(() => {
    workspace.hydrateFromPage();
    void workspace.loadRates();
    startHelloFruitPollers(workspace);
    startOrderActionCable(workspace);
    logDemo("app.ready", "Rails demo app mounted.");
    const onPopState = (): void => {
      void workspace.resumeFromUrl();
    };
    globalThis.addEventListener("popstate", onPopState);
    return () => globalThis.removeEventListener("popstate", onPopState);
  }, [workspace]);

  if (!workspace.hydrated) {
    return (
      <main className="page min-h-screen grid justify-items-center content-start p-4 md:p-8 gap-3">
        <span className="loading loading-spinner loading-md" aria-hidden="true" />
      </main>
    );
  }

  return (
    <main className="page min-h-screen grid justify-items-center content-start p-4 md:p-8 gap-3">
      <section className="checkout w-full max-w-5xl grid gap-3" aria-labelledby="product-title">
        <div className="topbar w-full max-w-5xl flex justify-end" id="topbar">
          <ThemeToggle />
        </div>

        <ProductHeader />

        {workspace.mode === "shop" ? (
          <ShopPanel />
        ) : (
          <div className="grid gap-3">
            <OrderPanel />
            <CheckoutPanel />
          </div>
        )}

        {workspace.errorMessage !== "" ? (
          <p className="alert alert-error" id="error" role="status">
            {workspace.errorMessage}
          </p>
        ) : null}
      </section>
      {workspace.stickerModal !== null ? <StickerModal /> : null}
    </main>
  );
});

export default AppContainer;
