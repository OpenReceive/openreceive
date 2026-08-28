import {
  Anchor,
  Button,
  Group,
  Image,
  Modal,
  Stack,
  Text,
  UnstyledButton,
} from "@mantine/core";
import {
  checkoutLabels,
  createWizardRouteDisplays,
  getPaymentWizardRoutes,
  type WizardProviderDisplay,
} from "@openreceive/browser/headless";
import { observer } from "mobx-react";
import type React from "react";
import { useMemo, useState } from "react";
import type { ShopCheckout } from "../stores/ShopCheckout.ts";
import { ControllerCopyButton } from "./CopyRow.tsx";

const PREVIEW_LIMIT = 8;

// "I have Cash App / Strike / Kraken — can I pay with that?"
//
// The list is the packaged registry, not a hand-curated one, and it is Lightning
// only: `getPaymentWizardRoutes()` with no arguments returns `btc-lightning`,
// the one route whose providers pay a bolt11 directly. The registry's other
// routes list exchanges that convert an asset INTO a Lightning payment, which is
// a different path from the deposit address a swap provider already quoted.
//
// The walkthrough modal below belongs to a LIVE invoice — its own first step is
// "copy the invoice" — so it lives inside the Lightning panel and goes away with
// it the moment the payer switches method.
export const WalletSuggestions: React.FC<{ checkout: ShopCheckout }> = observer(
  ({ checkout }) => {
    const [walkthrough, setWalkthrough] =
      useState<WizardProviderDisplay | null>(null);
    const [showAll, setShowAll] = useState(false);

    // The registry ranks its providers, and `providerPreviewLimit` is the seam for
    // showing the head of that ranking: thirty-seven rows under the invoice bury
    // the QR code that IS the payment path on a desktop.
    const routes = useMemo(
      () =>
        createWizardRouteDisplays(
          getPaymentWizardRoutes(),
          showAll ? {} : { providerPreviewLimit: PREVIEW_LIMIT },
        ),
      [showAll],
    );

    const providers = routes[0]?.providers ?? [];
    if (!providers.length) return null;

    return (
      <div className="or-shop-wallets">
        <Text className="or-shop-section-title">
          Wallets that can pay this invoice
        </Text>
        <Text size="xs" c="dimmed" mb={8}>
          Any wallet that can pay a Bitcoin Lightning invoice works.
        </Text>

        <div className="or-shop-wallet-grid">
          {providers.map((provider) => (
            <UnstyledButton
              key={provider.id}
              className="or-shop-wallet"
              component={provider.tutorials.length ? "button" : "a"}
              {...(provider.tutorials.length
                ? { onClick: () => setWalkthrough(provider) }
                : {
                    href: provider.url,
                    target: "_blank",
                    rel: "noopener noreferrer",
                  })}
            >
              {provider.icon ? (
                <Image src={provider.icon} alt="" w={22} h={22} />
              ) : null}
              <div>
                <Text size="sm" fw={600}>
                  {provider.name}
                </Text>
                <Text size="xs" c="dimmed">
                  {provider.kind}
                </Text>
              </div>
            </UnstyledButton>
          ))}
        </div>

        {showAll ? null : (
          <Anchor
            component="button"
            type="button"
            size="xs"
            mt={8}
            onClick={() => setShowAll(true)}
          >
            Show more wallets
          </Anchor>
        )}

        <ProviderWalkthrough
          provider={walkthrough}
          checkout={checkout}
          onClose={() => setWalkthrough(null)}
        />
      </div>
    );
  },
);

// The walkthrough's own first step is "copy the invoice", so it belongs to a
// live invoice — the parent closes it whenever the payer changes method.
const ProviderWalkthrough: React.FC<{
  provider: WizardProviderDisplay | null;
  checkout: ShopCheckout;
  onClose: () => void;
}> = observer(({ provider, checkout, onClose }) => {
  const [step, setStep] = useState(0);

  const steps = provider?.tutorials ?? [];
  const total = steps.length + 1;
  const current = Math.min(step, total - 1);

  const close = () => {
    setStep(0);
    onClose();
  };

  return (
    <Modal
      opened={Boolean(provider)}
      onClose={close}
      title={
        provider ? `${checkoutLabels.tutorialTitlePrefix} ${provider.name}` : ""
      }
      centered
      size="md"
    >
      {provider ? (
        <Stack gap="sm">
          {current === 0 ? (
            <>
              <Text size="sm">
                {checkoutLabels.tutorialIntroPrefix} {provider.name}.{" "}
                {checkoutLabels.tutorialIntroCopy}
              </Text>
              <ControllerCopyButton
                onCopy={checkout.copyInvoice}
                label={provider.copyLabel}
                copiedLabel={checkoutLabels.tutorialCopiedContinue}
              >
                {({ label, onClick }) => (
                  <Button onClick={onClick} variant="light">
                    {label}
                  </Button>
                )}
              </ControllerCopyButton>
            </>
          ) : (
            <>
              <Image src={steps[current - 1].image} alt="" radius="md" />
              <Text size="sm">{steps[current - 1].caption}</Text>
            </>
          )}

          <Group justify="space-between" mt="xs">
            <Button
              variant="default"
              disabled={current === 0}
              onClick={() => setStep(current - 1)}
            >
              {checkoutLabels.tutorialBack}
            </Button>
            {current < total - 1 ? (
              <Button onClick={() => setStep(current + 1)}>
                {checkoutLabels.tutorialNext}
              </Button>
            ) : (
              <Button variant="default" onClick={close}>
                {checkoutLabels.tutorialExit}
              </Button>
            )}
          </Group>
        </Stack>
      ) : null}
    </Modal>
  );
});
