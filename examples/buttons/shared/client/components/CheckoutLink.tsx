import { Alert, Stack, Text } from "@mantine/core";
import { IconBookmark } from "@tabler/icons-react";
import { observer } from "mobx-react";
import type React from "react";
import type { ShopCheckout } from "../stores/ShopCheckout.ts";
import { CopyRow } from "./CopyRow.tsx";

/**
 * The order's id and URL, with copy buttons.
 *
 * The payer has no account and gets no email from us. Once a deposit is in
 * flight, this uuid is the ONLY thing that can bring them back to their
 * payment — so it is on screen from the moment the order exists, and it is a
 * copy affordance rather than a sentence about the address bar.
 */
const CheckoutIds: React.FC<{ checkout: ShopCheckout }> = observer(({ checkout }) => (
  <Stack gap={8}>
    <CopyRow label="Order id" value={checkout.reference} selectable truncate />
    {checkout.checkoutUrl ? (
      <CopyRow label="Checkout link" value={checkout.checkoutUrl} truncate />
    ) : null}
  </Stack>
));

/** The quiet version, on the payment screen beside what is being bought. */
export const CheckoutLinkNote: React.FC<{ checkout: ShopCheckout }> = observer(({ checkout }) => {
  if (!checkout.reference) return null;
  return (
    <div className="or-shop-keeplink">
      <Text className="or-shop-section-title">Keep this order id</Text>
      <Text size="xs" c="dimmed">
        It is the way back to this payment. The link is already in your address bar.
      </Text>
      <CheckoutIds checkout={checkout} />
    </div>
  );
});

/**
 * The loud version, on the refund screen.
 *
 * `label` is `SwapDisplayModel.refundReturnLabel` — finished copy, and NOT
 * ours to rewrite: it says "bookmark this page" only because ShopCheckout
 * declares this checkout resumable, and it says the opposite for a host that
 * cannot bring the payer back. Print it, then hand over the two strings it is
 * talking about.
 */
export const CheckoutLinkAlert: React.FC<{ checkout: ShopCheckout; label: string }> = observer(
  ({ checkout, label }) => {
    if (!checkout.reference) return null;
    return (
      <Alert color="yellow" variant="light" icon={<IconBookmark />} title="Save this before you go">
        <Text size="sm" fw={700}>
          {label}
        </Text>
        <Text size="sm" mt={4}>
          Copy the order id below. Pasting it into “Already have an order id?” on the shop page
          brings you back to this refund screen.
        </Text>
        <Stack gap={8} mt={8}>
          <CheckoutIds checkout={checkout} />
        </Stack>
      </Alert>
    );
  },
);
