import { Paper, SegmentedControl, Text } from "@mantine/core";
import { observer } from "mobx-react";
import type React from "react";
import type { ReactNode } from "react";
import { useEffect } from "react";
import type { ShopStore, ShopTab } from "../stores/ShopStore.ts";
import { CatalogStage } from "./CatalogStage.tsx";
import { ReceiptStage } from "./ReceiptStage.tsx";
import { RecentOrdersStage } from "./RecentOrdersStage.tsx";

export type RenderCheckout = (args: { reference: string; onSettled: () => void }) => ReactNode;

/**
 * The shop, as one fixed-height panel with two tabs.
 *
 * THE CHECKOUT RENDERER IS PLUGGABLE. The catalog, the cart, the receipt and
 * the feed are identical on every stack; the payment step is not necessarily,
 * because node-express exists to show that the React, Vue, Svelte and Angular
 * wrappers all mount the same checkout. `renderCheckout` is that seam —
 * everything above and below it is shared.
 *
 * `tab` is panel-level state and deliberately NOT a fourth `stage`: the
 * checkout must keep polling while the payer reads the order history, and a
 * fourth stage would unmount it.
 */
export const ShopPanel: React.FC<{
  shop: ShopStore;
  renderCheckout: RenderCheckout;
}> = observer(({ shop, renderCheckout }) => {
  // Everything the stores started, stopped — the poll controller and the feed
  // interval both.
  useEffect(() => () => shop.dispose(), [shop]);

  return (
    <Paper className="or-shop" radius="lg" withBorder p={0}>
      <div className="or-shop-head">
        <div>
          <Text className="or-eyebrow">Try it</Text>
          <Text className="or-shop-title">Buy an OR button</Text>
        </div>
        <Text className="or-shop-subtitle">
          Real payments, on this page, through the library this demo documents.
        </Text>
      </div>

      {/* A SegmentedControl already renders a radiogroup and needs only a
          label. Do not hand-roll two buttons. */}
      <div className="or-shop-tabs">
        <SegmentedControl
          fullWidth
          size="xs"
          aria-label="Shop or recent orders"
          value={shop.tab}
          onChange={(value) => shop.setTab(value as ShopTab)}
          data={[
            { value: "shop", label: "Buy a button" },
            { value: "orders", label: "Recent orders" },
          ]}
        />
      </div>

      <div className="or-shop-body">
        {shop.tab === "orders" ? (
          <RecentOrdersStage shop={shop} />
        ) : (
          <>
            {shop.stage === "catalog" && <CatalogStage shop={shop} />}
            {shop.stage === "checkout" &&
              renderCheckout({
                reference: shop.orderReference,
                onSettled: () => void shop.confirmSettlement(),
              })}
            {shop.stage === "receipt" && <ReceiptStage shop={shop} />}
          </>
        )}
      </div>
    </Paper>
  );
});
