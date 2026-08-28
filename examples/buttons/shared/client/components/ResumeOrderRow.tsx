import { ActionIcon, Anchor, Group, Text, TextInput } from "@mantine/core";
import { IconArrowRight, IconX } from "@tabler/icons-react";
import { observer } from "mobx-react";
import type React from "react";
import { useState } from "react";
import type { ShopStore } from "../stores/ShopStore.ts";

/**
 * The way back into an order, for a payer who has only the uuid.
 *
 * DISCREET ON PURPOSE, and collapsed until it is asked for: on the catalog it
 * is a footnote, and the payer who needs it is the one who was told to copy an
 * id on the refund screen. It accepts the whole checkout URL as readily as the
 * bare uuid, because both are things people actually paste.
 *
 * The lookup is the host's own `GET /shop/orders/:reference`, authorized by the
 * visitor cookie — so this box opens the payer's own orders and nobody else's.
 */
export const ResumeOrderRow: React.FC<{ shop: ShopStore }> = observer(({ shop }) => {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");

  const close = () => {
    setOpen(false);
    setValue("");
    shop.setResumeError("");
  };

  if (!open) {
    return (
      <div className="or-shop-resume">
        <Anchor component="button" type="button" size="xs" onClick={() => setOpen(true)}>
          Already have an order id? Open it
        </Anchor>
      </div>
    );
  }

  return (
    <form
      className="or-shop-resume"
      onSubmit={(event) => {
        event.preventDefault();
        void shop.resume(value);
      }}
    >
      <Group gap={6} wrap="nowrap" align="flex-start">
        <TextInput
          aria-label="Order id"
          autoFocus
          className="or-shop-resume-input"
          error={shop.resumeError || undefined}
          onChange={(event) => setValue(event.currentTarget.value)}
          placeholder="Paste your order id or checkout link"
          size="xs"
          value={value}
        />
        <ActionIcon
          aria-label="Open this order"
          loading={shop.resuming}
          size="input-xs"
          type="submit"
          variant="light"
        >
          <IconArrowRight size={16} />
        </ActionIcon>
        <ActionIcon aria-label="Cancel" onClick={close} size="input-xs" variant="subtle">
          <IconX size={16} />
        </ActionIcon>
      </Group>
      <Text className="or-shop-resume-hint" size="xs">
        Orders open in the browser that placed them.
      </Text>
    </form>
  );
});
