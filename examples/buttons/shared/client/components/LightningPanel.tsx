import { Button, Group, Loader, Stack, Text } from "@mantine/core";
import { checkoutLabels } from "@openreceive/browser/headless";
import { observer } from "mobx-react";
import type React from "react";
import { useMemo } from "react";
import type { ShopCheckout } from "../stores/ShopCheckout.ts";
import { ControllerCopyButton, CopyRow } from "./CopyRow.tsx";
import { useInvoiceQrSvg } from "./useQrSvg.ts";
import { WalletSuggestions } from "./WalletSuggestions.tsx";

// A desktop payer's payment path IS the QR code. There is deliberately no
// "Open wallet" button here: `openWallet` is `location.assign("lightning:…")` on
// the CURRENT window, and that window is a live checkout polling for
// settlement — with no registered handler the button is inert, and with one it
// walks the payer off the page that was about to tell them they had paid. On a
// touch device it hands off to a real wallet app, so it appears there only.
const isTouchDevice = (): boolean =>
  typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true;

export const LightningPanel: React.FC<{ checkout: ShopCheckout }> = observer(({ checkout }) => {
  const invoice = checkout.lightningInvoice;
  const touch = useMemo(isTouchDevice, []);
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

            {touch ? (
              <Button variant="default" size="md" onClick={checkout.openWallet}>
                {checkoutLabels.openWallet}
              </Button>
            ) : null}
          </Group>

          <WalletSuggestions checkout={checkout} />
        </Stack>
      </div>
    </Stack>
  );
});
