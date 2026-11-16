import { Group, Image, Text } from "@mantine/core";
import { observer } from "mobx-react";
import type React from "react";
import { formatUsdCents } from "../../shop-types.ts";
import type { ShopStore } from "../stores/ShopStore.ts";

/**
 * What the payer is buying, above the amount, on every payment screen.
 *
 * The checkout renders the total and never the order — OpenReceive owns no line
 * items — so a host that shows nothing here leaves a QR code and a number with
 * no sign of what the number is for. The `description` from `config.amount_for`
 * is the one display string the packages carry; this strip is our own richer
 * version of it, and it is the reason both stacks put a summary column beside
 * the payment column rather than a bare panel.
 *
 * Shared because it is host data — the product, its picture, its price — on a
 * screen the library cannot draw: node-express puts it beside the PACKAGED
 * checkout, Rails and Next.js beside the keystone-driven one.
 *
 * `hideTotal` leaves the price out, and every host sets it while a swap is on
 * screen. A swap screen shows ONE amount, the one to send: "$36.00" here beside
 * "37.04 USDC" there is a second figure a payer can type into their wallet, and
 * a deposit of 36 does not complete the order.
 */
export const OrderStrip: React.FC<{ shop: ShopStore; hideTotal?: boolean }> = observer(
  ({ shop, hideTotal = false }) => (
    <div className="or-shop-order-strip">
      <Group gap={6} wrap="nowrap" className="or-shop-order-thumbs">
        {shop.orderItems.map((item) => (
          <Image
            key={item.sku}
            src={shop.imageFor(item.sku)}
            alt={item.name}
            w={34}
            h={34}
            radius="sm"
          />
        ))}
      </Group>
      <div>
        <Text className="or-shop-order-title">
          {shop.orderDescription || shop.checkout.description}
        </Text>
        {hideTotal ? null : (
          <Text className="or-shop-order-total">{formatUsdCents(shop.orderTotalCents)}</Text>
        )}
      </div>
    </div>
  ),
);
