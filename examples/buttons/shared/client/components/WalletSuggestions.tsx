import { Anchor, Button, Image, Modal, Stack, Text, UnstyledButton } from "@mantine/core";
import {
  checkoutLabels,
  createWizardRouteDisplays,
  getPaymentWizardRoutes,
  loadPayTutorialImages,
  type WizardProviderDisplay,
} from "@openreceive/browser/headless";
import { observer } from "mobx-react";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import type { ShopCheckout } from "../stores/ShopCheckout.ts";

const PREVIEW_LIMIT = 8;

// "I have Cash App / Strike / Kraken — can I pay with that?"
//
// The list is the packaged registry, not a hand-curated one, and it is Lightning
// only: `getPaymentWizardRoutes()` with no arguments returns `btc-lightning`,
// the one route whose providers pay a bolt11 directly. The registry's other
// routes list exchanges that convert an asset INTO a Lightning payment, which is
// a different path from the deposit address a swap provider already quoted.
//
// The walkthrough modal below belongs to a LIVE invoice — its Copy invoice button
// copies that invoice — so it lives inside the Lightning panel and goes away with
// it the moment the payer switches method.
//
// The wallet logos are `data:` URIs inside @openreceive/provider-data's main
// bundle; the tutorial screenshots are a lazy chunk of the same package, which
// `loadPayTutorialImages()` fetches on the first walkthrough open. Nothing here
// is a file the host has to serve.
export const WalletSuggestions: React.FC<{ checkout: ShopCheckout }> = observer(({ checkout }) => {
  const [walkthrough, setWalkthrough] = useState<WizardProviderDisplay | null>(null);
  const [copied, setCopied] = useState(false);
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

  const route = routes[0];
  if (!route?.providers.length) return null;

  // A refused copy just leaves the Copy invoice button showing.
  const copy = () => {
    checkout.copyInvoice().then(
      () => setCopied(true),
      () => undefined,
    );
  };
  const open = (provider: WizardProviderDisplay) => {
    setCopied(false);
    setWalkthrough(provider);
  };

  return (
    <div className="or-shop-wallets">
      <Text className="or-shop-section-title">Wallets that can pay this invoice</Text>
      <Text size="xs" c="dimmed" mb={8}>
        Any wallet that can pay a Bitcoin Lightning invoice works.
      </Text>

      <div className="or-shop-wallet-grid">
        {route.providers.map((provider) => (
          <UnstyledButton
            key={provider.id}
            className="or-shop-wallet"
            component={provider.tutorials.length ? "button" : "a"}
            {...(provider.tutorials.length
              ? { onClick: () => open(provider) }
              : {
                  href: provider.url,
                  target: "_blank",
                  rel: "noopener noreferrer",
                })}
          >
            {provider.icon ? <Image src={provider.icon} alt="" w={22} h={22} /> : null}
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
        <Anchor component="button" type="button" size="xs" mt={8} onClick={() => setShowAll(true)}>
          Show more wallets
        </Anchor>
      )}

      <ProviderWalkthrough
        provider={walkthrough}
        copied={copied}
        onCopy={copy}
        onClose={() => setWalkthrough(null)}
      />
    </div>
  );
});

// One screen, because the payer leaves this page to act on it: every step is
// visible at once and Next moves through the screenshots.
const ProviderWalkthrough: React.FC<{
  provider: WizardProviderDisplay | null;
  copied: boolean;
  onCopy: () => void;
  onClose: () => void;
}> = ({ provider, copied, onCopy, onClose }) => {
  const [step, setStep] = useState(0);
  const [images, setImages] = useState<Readonly<Record<string, string>>>();
  // Step 1 is the copy, so step N shows screenshot N - 1.
  const lastStep = step >= (provider?.tutorials.length ?? 0);

  // Load-then-render: a step shows its caption alone until the chunk arrives
  // (or if it never does), never an <img> with an empty src.
  useEffect(() => {
    if (provider === null || images !== undefined) return;
    let live = true;
    loadPayTutorialImages().then(
      (table) => {
        if (live) setImages(table);
      },
      () => {
        if (live) setImages({});
      },
    );
    return () => {
      live = false;
    };
  }, [provider, images]);

  // Every walkthrough starts at its first step.
  useEffect(() => {
    if (provider !== null) setStep(0);
  }, [provider]);

  return (
    <Modal
      opened={Boolean(provider)}
      onClose={onClose}
      title={provider ? `${checkoutLabels.tutorialTitlePrefix} ${provider.name}` : ""}
      centered
      size="md"
    >
      {provider ? (
        <Stack gap="xs">
          <ol className="or-shop-tutorial-steps">
            <li>
              <Button
                fullWidth
                size="lg"
                justify="flex-start"
                variant={copied ? "light" : "filled"}
                leftSection={
                  <span className="or-shop-tutorial-number" aria-hidden="true">
                    1
                  </span>
                }
                onClick={onCopy}
              >
                {copied ? checkoutLabels.tutorialInvoiceCopied : checkoutLabels.copyInvoice}
              </Button>
            </li>
            {provider.tutorials.map((tutorial, index) => (
              <li key={tutorial.path}>
                <UnstyledButton
                  className="or-shop-tutorial-step"
                  data-active={index + 1 === step || undefined}
                  aria-current={index + 1 === step ? "step" : undefined}
                  disabled={!copied}
                  onClick={() => setStep(index + 1)}
                >
                  <span className="or-shop-tutorial-number" aria-hidden="true">
                    {index + 2}
                  </span>
                  <span>{tutorial.caption}</span>
                </UnstyledButton>
              </li>
            ))}
          </ol>

          <div className="or-shop-tutorial-frame" hidden={step === 0}>
            {provider.tutorials.map((tutorial, index) =>
              images?.[tutorial.path] === undefined ? null : (
                <img
                  key={tutorial.path}
                  className="or-shop-tutorial-image"
                  src={images[tutorial.path]}
                  alt={tutorial.caption}
                  hidden={index + 1 !== step}
                />
              ),
            )}
          </div>

          <Text size="sm" c="dimmed" ta="center">
            {checkoutLabels.tutorialComeBack}
          </Text>

          <Button disabled={!copied} onClick={lastStep ? onClose : () => setStep(step + 1)}>
            {lastStep ? checkoutLabels.tutorialDone : checkoutLabels.tutorialNext}
          </Button>
        </Stack>
      ) : null}
    </Modal>
  );
};
