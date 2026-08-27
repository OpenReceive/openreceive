import { Alert, Anchor, Button, Group, Image, Loader, Stack, Text } from "@mantine/core";
import { checkoutLabels } from "@openreceive/browser/headless";
import { IconArrowLeft } from "@tabler/icons-react";
import { observer } from "mobx-react";
import type React from "react";
import { useEffect } from "react";
import { formatUsdCents } from "../../shop-types.ts";
import type { ShopStore } from "../stores/ShopStore.ts";
import { LightningPanel } from "./LightningPanel.tsx";
import { MethodGrid } from "./MethodGrid.tsx";
import { SwapDepositPanel } from "./SwapDepositPanel.tsx";
import { TransactionDetailsPanel } from "./TransactionDetailsPanel.tsx";

export const CheckoutStage: React.FC<{ shop: ShopStore }> = observer(({ shop }) => {
  const checkout = shop.checkout;
  const status = checkout.status;
  const swap = checkout.swapDisplay;
  const unavailable = checkout.swapUnavailable;
  const isLightning = checkout.pickerKey?.startsWith("method:") ?? false;
  const hasPanel =
    isLightning || Boolean(swap) || Boolean(unavailable) || Boolean(checkout.startingSwapAsset);

  // Settlement is proven on the server. When the checkout's own poll says the
  // payment landed, we re-read our own order — the row `config.on_paid` wrote —
  // and only then show the receipt with its downloads.
  //
  // The host's realtime push calls the SAME store method, and usually gets here
  // first; `confirmSettlement` is single-flight so the two do not race.
  // `void` on the floating promise, the guard first, the store doing the work.
  useEffect(() => {
    if (!checkout.settled) return;
    void shop.confirmSettlement();
  }, [checkout.settled, shop]);

  return (
    <>
      <div className="or-shop-scroll">
        <Stack gap="md">
          <OrderStrip shop={shop} />

          {/* A status line, not a stepper. Progress here is a STATUS: four wire
              values for status, six phases, twelve provider states, and the
              forward path is the minority of all three — there is nowhere on a
              Cart → Pay → Done bar to put an expired invoice or a refund under
              review. `title` and `detail` are finished payer-facing copy; they
              are printed, not rewritten. */}
          <div className="or-shop-status" data-phase={status.phase}>
            <Group justify="space-between" align="flex-start" wrap="nowrap">
              <div>
                <Text className="or-shop-status-title">{status.title}</Text>
                <Text className="or-shop-status-detail">{status.detail}</Text>
              </div>
              {status.waiting ? <Loader size="xs" color="orGreen" /> : null}
            </Group>
            {status.countdownLabel ? (
              <Text className="or-shop-status-countdown">
                {status.countdownPrefix} {status.countdownLabel}
              </Text>
            ) : null}
          </div>

          {checkout.errorMessage ? (
            <Alert color="red" variant="light">
              {checkout.errorMessage}
            </Alert>
          ) : null}

          {checkout.preparing ? (
            <Group gap="sm" py="lg" justify="center">
              <Loader size="sm" color="orGreen" />
              <Text size="sm" c="dimmed">
                {checkoutLabels.preparingPayment}
              </Text>
            </Group>
          ) : hasPanel ? (
            <Stack gap="sm">
              {/* Backwards movement is a breadcrumb, not a step back — and it
                  names what is about to change. */}
              <Anchor component="button" type="button" size="sm" onClick={checkout.backToMethods}>
                <Group gap={4} wrap="nowrap">
                  <IconArrowLeft size={14} />
                  {checkoutLabels.switchPaymentMethod}
                </Group>
              </Anchor>

              {checkout.swapStartError ? (
                <Alert color="red" variant="light" title={checkoutLabels.swapStartFailedTitle}>
                  {checkout.swapStartError}
                </Alert>
              ) : null}

              {unavailable ? (
                <Alert color="yellow" variant="light" title={unavailable.title}>
                  <Text size="sm">{unavailable.detail}</Text>
                  {unavailable.range ? (
                    <Text size="sm" mt={4}>
                      {unavailable.range}
                    </Text>
                  ) : null}
                  <Text size="sm" mt={4}>
                    {unavailable.hint}
                  </Text>
                </Alert>
              ) : swap ? (
                <SwapDepositPanel checkout={checkout} swap={swap} />
              ) : isLightning ? (
                <LightningPanel checkout={checkout} />
              ) : (
                <Group gap="sm" py="lg" justify="center">
                  <Loader size="sm" color="orGreen" />
                  <Text size="sm" c="dimmed">
                    {checkoutLabels.preparingPaymentAddress}
                  </Text>
                </Group>
              )}
            </Stack>
          ) : (
            <MethodGrid checkout={checkout} />
          )}

          <TransactionDetailsPanel rows={checkout.transactionRows} />
        </Stack>
      </div>

      <div className="or-shop-footer">
        <Button variant="subtle" size="sm" onClick={shop.startOver}>
          {checkoutLabels.startOver}
        </Button>
        <Text size="sm" c="dimmed">
          {formatUsdCents(shop.orderTotalCents)}
        </Text>
      </div>
    </>
  );
});

// What the payer is buying, above the amount, on every screen. The checkout
// renders the total and never the order — OpenReceive owns no line items — so a
// host that shows nothing here leaves a QR code and a number with no sign of
// what the number is for. The `description` from `config.amount_for` is the one
// display string the packages carry; this strip is our own richer version of it.
const OrderStrip: React.FC<{ shop: ShopStore }> = observer(({ shop }) => (
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
      <Text className="or-shop-order-total">{formatUsdCents(shop.orderTotalCents)}</Text>
    </div>
  </div>
));
