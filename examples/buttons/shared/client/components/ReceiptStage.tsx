import { Anchor, Button, Group, Image, Stack, Text } from "@mantine/core";
import { IconCircleCheck, IconDownload } from "@tabler/icons-react";
import { observer } from "mobx-react";
import type React from "react";
import { formatUsdCents } from "../../shop-types.ts";
import type { ShopStore } from "../stores/ShopStore.ts";
import { TransactionDetailsPanel } from "./TransactionDetailsPanel.tsx";

export const ReceiptStage: React.FC<{ shop: ShopStore }> = observer(({ shop }) => (
  <>
    <div className="or-shop-stage">
      <Stack gap="md">
        <Group gap={8} wrap="nowrap">
          <IconCircleCheck size={22} className="or-shop-paid-icon" />
          <div>
            <Text className="or-shop-status-title">Payment received</Text>
            <Text className="or-shop-status-detail">
              {shop.orderDescription} · {formatUsdCents(shop.orderTotalCents)}
            </Text>
          </div>
        </Group>

        <Stack gap="xs">
          {shop.orderItems.map((item) => (
            <div className="or-shop-receipt-line" key={item.sku}>
              <Image src={shop.imageFor(item.sku)} alt={item.name} w={44} h={44} radius="sm" />
              <div className="or-shop-receipt-copy">
                <Text size="sm" fw={600}>
                  {item.name}
                  {item.quantity > 1 ? ` ×${item.quantity}` : ""}
                </Text>
                <Text size="xs" c="dimmed">
                  {formatUsdCents(item.lineTotalCents)}
                </Text>
              </div>
              {/* The download exists because the order row says `paid`, and that
                  row was written inside OpenReceive's settlement transaction.
                  The browser never decides this. */}
              <Button
                component="a"
                href={item.downloadPath ?? "#"}
                size="xs"
                variant="light"
                disabled={!item.downloadPath}
                leftSection={<IconDownload size={14} />}
              >
                Download
              </Button>
            </div>
          ))}
        </Stack>

        {/* The order that was just paid is now the top row of a feed every
            visitor can see. Saying so is the shortest route to the point of
            the demo. */}
        <Anchor component="button" type="button" size="sm" onClick={shop.showFeed}>
          See it in recent orders
        </Anchor>

        {/* The same transaction record as the live checkout, on the receipt.
            The payment hash and the deposit txid are the only evidence the payer
            has that they paid. */}
        <TransactionDetailsPanel rows={shop.checkout.transactionRows} />
      </Stack>
    </div>

    <div className="or-shop-footer">
      <Text size="sm" c="dimmed">
        Order {shop.orderReference.slice(0, 8)}
      </Text>
      <Button variant="default" size="sm" onClick={shop.startOver}>
        Buy more buttons
      </Button>
    </div>
  </>
));
