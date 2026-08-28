import { ActionIcon, Alert, Button, Group, Image, Text } from "@mantine/core";
import { IconMinus, IconPlus, IconShoppingBag } from "@tabler/icons-react";
import { observer } from "mobx-react";
import type React from "react";
import { formatUsdCents, pluralize } from "../../shop-types.ts";
import type { ShopStore } from "../stores/ShopStore.ts";

// Six buttons, cheapest first. Each one is a downloadable image of a pin badge:
// the same file is the thumbnail here and the thing the payer downloads after
// settlement.
//
// `image_url` is a DIGESTED url built by the server. The browser could not
// derive it and must not be allowed to supply it — which is also why the
// catalog ships from the server rather than being a constant in this bundle.
export const CatalogStage: React.FC<{ shop: ShopStore }> = observer(({ shop }) => (
  <>
    <div className="or-shop-stage">
      <div className="or-shop-grid">
        {shop.catalog.map((entry) => {
          const quantity = shop.quantityOf(entry.sku);
          return (
            // `|| undefined` is NOT optional: data-in-cart={false} renders the
            // attribute with the string "false", and [data-in-cart] matches any
            // value — so every card would look selected.
            <div className="or-shop-card" key={entry.sku} data-in-cart={quantity > 0 || undefined}>
              <Image
                src={entry.image_url}
                alt={`${entry.name} OpenReceive button`}
                className="or-shop-card-image"
                loading="lazy"
              />
              <Text className="or-shop-card-name">{entry.name}</Text>
              <Text className="or-shop-card-price">{formatUsdCents(entry.price_cents)}</Text>

              {quantity > 0 ? (
                <Group gap={4} justify="center" wrap="nowrap">
                  <ActionIcon
                    variant="default"
                    size="sm"
                    aria-label={`Remove one ${entry.name}`}
                    onClick={() => shop.remove(entry.sku)}
                  >
                    <IconMinus size={14} />
                  </ActionIcon>
                  <Text className="or-shop-card-qty">{quantity}</Text>
                  <ActionIcon
                    variant="default"
                    size="sm"
                    aria-label={`Add one ${entry.name}`}
                    disabled={quantity >= shop.maxPerSku}
                    onClick={() => shop.add(entry.sku)}
                  >
                    <IconPlus size={14} />
                  </ActionIcon>
                </Group>
              ) : (
                <Button size="xs" variant="light" fullWidth onClick={() => shop.add(entry.sku)}>
                  Add
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>

    {shop.errorMessage ? (
      <Alert color="red" variant="light" mt="xs">
        {shop.errorMessage}
      </Alert>
    ) : null}

    <div className="or-shop-footer">
      <Group gap={8} wrap="nowrap">
        <IconShoppingBag size={18} />
        <Text size="sm">
          {shop.itemCount === 0
            ? "Your cart is empty"
            : `${pluralize(shop.itemCount, "button")} · ${formatUsdCents(shop.totalCents)}`}
        </Text>
      </Group>
      <Button
        size="md"
        disabled={shop.itemCount === 0}
        loading={shop.placingOrder}
        onClick={shop.placeOrder}
      >
        Checkout
      </Button>
    </div>
  </>
));
