import { Alert, Button, Group, Loader, MantineProvider, Stack, Text } from "@mantine/core";
import type { CheckoutState } from "@openreceive/browser";
import { createCheckoutStatusModel } from "@openreceive/browser/headless";
import { Checkout } from "@openreceive/react";
import { observer } from "mobx-react";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { loadShopBootstrap } from "../../../../shared/bootstrap.ts";
import { readSwapAttempt, rememberSwapAttempt } from "../../../../shared/checkout-resume.ts";
import { OrderStrip } from "../../../../shared/client/components/OrderStrip.tsx";
import { ShopPanel } from "../../../../shared/client/components/ShopPanel.tsx";
import { StatusCard } from "../../../../shared/client/components/StatusCard.tsx";
import { ShopStore } from "../../../../shared/client/stores/ShopStore.ts";
import { shopTheme } from "../../../../shared/client/theme.ts";
import { formatUsdCents } from "../../../../shared/shop-types.ts";

/**
 * The Fastify host — the MINIMAL one.
 *
 * node-express already proves that all four wrapper packages mount the same
 * checkout, so this stack does not repeat the tab strip. It plugs the packaged
 * React `<Checkout>` into the shared shop's `renderCheckout` seam and nothing
 * else: the smallest correct integration of a packaged checkout against a
 * Fastify-registered OpenReceive plugin. The catalog, the cart, the receipt and
 * the recent-orders feed are the identical shared components.
 */
export const ShopApp: React.FC = () => {
  const [shop] = useState(() => new ShopStore({}));
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [error, setError] = useState("");

  // The Node hosts fetch the bootstrap payload; Rails inlines it. Everything
  // the store does with it is shared.
  useEffect(() => {
    let cancelled = false;
    loadShopBootstrap()
      .then((bootstrap) => {
        if (cancelled) return;
        if (bootstrap) shop.hydrate(bootstrap);
        setStatus(bootstrap ? "ready" : "failed");
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setStatus("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [shop]);

  return (
    <MantineProvider theme={shopTheme} defaultColorScheme="light">
      <main className="or-page">
        <div className="or-page-inner">
          {status === "loading" ? (
            <Group gap="sm" py="xl" justify="center">
              <Loader size="sm" color="orGreen" />
              <Text size="sm" c="dimmed">
                Loading the shop…
              </Text>
            </Group>
          ) : status === "failed" ? (
            <Alert color="red" variant="light" title="The shop could not load">
              {error || "The bootstrap payload was empty."}
            </Alert>
          ) : (
            <ShopPanel
              shop={shop}
              renderCheckout={({ reference, onSettled }) => (
                <PackagedCheckout onSettled={onSettled} reference={reference} shop={shop} />
              )}
            />
          )}
          <Text className="or-page-note">Fastify + SQLite. React.</Text>
        </div>
      </main>
    </MantineProvider>
  );
};

interface PackagedCheckoutProps {
  readonly onSettled: () => void;
  readonly reference: string;
  readonly shop: ShopStore;
}

/**
 * The packaged checkout, self-contained: it creates the checkout against the
 * registered plugin, polls, and drives swaps itself. The prefix comes from the
 * bootstrap payload, so the mount path lives on the server and not in a second
 * copy here.
 */
const PackagedCheckout: React.FC<PackagedCheckoutProps> = observer(
  ({ onSettled, reference, shop }) => {
    const prefix = shop.checkout.prefix;

    // The checkout's `onStartOver` is offered when an invoice EXPIRES, and what
    // the payer wants then is a fresh invoice for the cart they already have —
    // so it remounts the checkout on the SAME reference (a `key` change) rather
    // than throwing the order away. Abandoning the order is the footer's job.
    const [retryNonce, setRetryNonce] = useState(0);
    const retrySameOrder = useCallback(() => setRetryNonce((nonce) => nonce + 1), []);

    // THE ORDER'S DEPOSIT, KEPT ACROSS A CLOSED TAB. `/checkouts/prepare`
    // carries no attempts, so a bookmarked checkout would open on the method
    // grid — and a payer sent away to fetch a refund address would come back
    // to a shop. The packaged checkout takes the attempt's payment hash and
    // reopens it; remembering the hash is ours, because the library owns no
    // order and no storage. The same callback feeds the summary column.
    const resumePaymentHash = readSwapAttempt(reference);
    const [checkoutState, setCheckoutState] = useState<CheckoutState | undefined>(undefined);
    const rememberSwap = useCallback(
      (state: CheckoutState) => {
        setCheckoutState(state);
        if (state.rail !== "swap" || !state.payment_hash) return;
        rememberSwapAttempt(reference, state.payment_hash);
      },
      [reference],
    );

    return (
      <>
        {/* Two columns on a desktop, one on a phone, from the shop's own
            stylesheet: the summary — what is being bought, where the payment
            has got to — beside the payment column the payer acts in. */}
        <div className="or-shop-stage or-checkout">
          <Stack className="or-checkout-summary" gap="md">
            <OrderStrip shop={shop} />
            <StatusCard status={createCheckoutStatusModel(checkoutState)} />
          </Stack>

          <Stack className="or-checkout-pay" gap="sm">
            <Checkout
              defaultTheme="light"
              key={`react-${retryNonce}`}
              onSettled={onSettled}
              onStartOver={retrySameOrder}
              onState={rememberSwap}
              prefix={prefix}
              reference={reference}
              // NOT `syncUrl`: the HOST owns the address bar here, because it
              // also has to restore the order behind `/checkout/:reference` on
              // a cold load — see shared/checkout-resume.ts. `resumable` says
              // the order HAS such a URL, which decides whether the refund
              // screen tells the payer to bookmark it.
              resumable
              {...(resumePaymentHash ? { resumePaymentHash } : {})}
              // The shop has no dark mode — shop.css hard-codes #fff in several
              // places — so the checkout is pinned to light like every stack's.
              themeToggle={false}
            />
          </Stack>
        </div>

        <div className="or-shop-footer">
          {/* Abandoning the order, as distinct from the checkout's own
              "Start over", which retries this one. */}
          <Button onClick={shop.startOver} size="sm" variant="subtle">
            Back to shop
          </Button>
          <Text c="dimmed" size="sm">
            {formatUsdCents(shop.orderTotalCents)}
          </Text>
        </div>
      </>
    );
  },
);
