import { Button, Group, Loader, Stack, Text } from "@mantine/core";
import { checkoutLabels } from "@openreceive/browser/headless";
import { observer } from "mobx-react";
import type React from "react";
import type { ShopCheckout } from "../stores/ShopCheckout.ts";
import { ControllerCopyButton, CopyRow } from "./CopyRow.tsx";
import { useInvoiceQrSvg } from "./useQrSvg.ts";
import { WalletSuggestions } from "./WalletSuggestions.tsx";

// The payer's paths are the QR code and Copy invoice. There is deliberately no
// link that opens a wallet: Cash App cancels an invoice opened from a link and
// pays the same invoice scanned or pasted.
export const LightningPanel: React.FC<{ checkout: ShopCheckout }> = observer(({ checkout }) => {
  const invoice = checkout.lightningInvoice;
  const qr = useInvoiceQrSvg(invoice);

  if (checkout.mintingLightning || !invoice || !qr) {
    return (
      <Group gap="sm" py="lg" justify="center">
        <Loader size="sm" color="orGreen" />
        <Text size="sm" c="dimmed">
          {checkoutLabels.preparingPayment}
        </Text>
      </Group>
    );
  }

  return (
    <Stack gap="sm">
      <Text className="or-shop-section-title">{checkoutLabels.bitcoinLightningInvoice}</Text>

      {/* The QR and everything that goes with it, side by side once there is
          room — the wallet list included, because it is what fills the height
          the QR code costs. */}
      <div className="or-shop-payload">
        <div
          className="or-shop-qr"
          role="img"
          aria-label={checkoutLabels.bitcoinLightningInvoice}
          dangerouslySetInnerHTML={{ __html: qr }}
        />

        <Stack gap="sm">
          {/* The WHOLE bolt11, shortened by CSS. It reads as one line either
              way, but a payer who selects it by hand gets the invoice rather
              than a string with an ellipsis where the middle used to be. */}
          <CopyRow label="Invoice" value={invoice} truncate selectable />

          <Group gap="sm">
            <ControllerCopyButton
              onCopy={checkout.copyInvoice}
              label={checkoutLabels.copyInvoice}
              copiedLabel={checkoutLabels.copied}
            >
              {({ label, onClick }) => (
                <Button onClick={onClick} size="md">
                  {label}
                </Button>
              )}
            </ControllerCopyButton>
          </Group>

          <WalletSuggestions checkout={checkout} />
        </Stack>
      </div>
    </Stack>
  );
});
