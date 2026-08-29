import {
  Alert,
  Button,
  Group,
  Loader,
  MantineProvider,
  SegmentedControl,
  Stack,
  Text,
} from "@mantine/core";
import type { CheckoutState } from "@openreceive/browser";
import { createCheckoutStatusModel } from "@openreceive/browser/headless";
import { Checkout } from "@openreceive/react";
import { observer } from "mobx-react";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { loadShopBootstrap } from "../../../../shared/bootstrap.ts";
import { readSwapAttempt, rememberSwapAttempt } from "../../../../shared/checkout-resume.ts";
import { OrderStrip } from "../../../../shared/client/components/OrderStrip.tsx";
import { ShopPanel } from "../../../../shared/client/components/ShopPanel.tsx";
import { StatusCard } from "../../../../shared/client/components/StatusCard.tsx";
import { ShopStore } from "../../../../shared/client/stores/ShopStore.ts";
import { shopTheme } from "../../../../shared/client/theme.ts";
import { formatUsdCents } from "../../../../shared/shop-types.ts";

type CheckoutFramework = "react" | "vue" | "svelte" | "angular";

const FRAMEWORKS: readonly { readonly value: CheckoutFramework; readonly label: string }[] = [
  { value: "react", label: "React" },
  { value: "vue", label: "Vue" },
  { value: "svelte", label: "Svelte" },
  { value: "angular", label: "Angular" },
];

/**
 * The Express host.
 *
 * THIS IS THE STACK WHOSE CHECKOUT SCREEN DIFFERS. Rails and Next.js plug the
 * keystone-driven CheckoutStage into `renderCheckout`; this one plugs in the
 * PACKAGED <Checkout>, behind a tab strip, because node-express exists to show
 * that @openreceive/react, /vue, /svelte and /angular all mount the same
 * checkout. The catalog, the cart, the receipt and the recent-orders feed
 * above and below that seam are the identical shared components.
 *
 * The tab strip lives inside the seam rather than above the panel: choosing a
 * framework is a statement about the payment screen and means nothing on the
 * catalog or the receipt.
 */
export const ShopApp: React.FC = () => {
  const [shop] = useState(() => new ShopStore({}));
  const [framework, setFramework] = useState<CheckoutFramework>("react");
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
                <FrameworkCheckout
                  framework={framework}
                  onFrameworkChange={setFramework}
                  onSettled={onSettled}
                  reference={reference}
                  shop={shop}
                />
              )}
            />
          )}
          <Text className="or-page-note">Express + SQLite. React, Vue, Svelte and Angular.</Text>
        </div>
      </main>
    </MantineProvider>
  );
};

interface FrameworkCheckoutProps {
  readonly framework: CheckoutFramework;
  readonly onFrameworkChange: (framework: CheckoutFramework) => void;
  readonly onSettled: () => void;
  readonly reference: string;
  readonly shop: ShopStore;
}

/**
 * The packaged checkout, in whichever framework is selected.
 *
 * Each one mounts the SELF-CONTAINED <Checkout reference>: the component
 * creates the checkout against the mounted router, polls, and drives swaps
 * itself. The prefix comes from the bootstrap payload, so the mount path lives
 * on the server and not in a second copy here.
 */
const FrameworkCheckout: React.FC<FrameworkCheckoutProps> = observer(
  ({ framework, onFrameworkChange, onSettled, reference, shop }) => {
    const prefix = shop.checkout.prefix;

    // TWO DIFFERENT INTENTIONS, and the packaged checkout only has one callback
    // for them. Its `onStartOver` is the action offered when an invoice
    // EXPIRES, where what the payer wants is a fresh invoice for the cart they
    // already have — so this remounts the checkout on the SAME reference
    // rather than throwing the order away. The reference is minted once and
    // survives every retry; discarding it here would leave one cart payable
    // twice.
    //
    // Abandoning the order is the footer's job, and it is labelled for that.
    // The retry is spelled as a REMOUNT — a changing `key` — so React tears the
    // old checkout down and builds a new one, rather than an effect dependency
    // nothing in the effect actually reads.
    const [retryNonce, setRetryNonce] = useState(0);
    const retrySameOrder = useCallback(() => setRetryNonce((nonce) => nonce + 1), []);

    // THE ORDER'S DEPOSIT, KEPT ACROSS A CLOSED TAB.
    //
    // `/checkouts/prepare` carries no attempts, so a bookmarked checkout would
    // open on the method grid — and a payer sent away to fetch a refund address
    // would come back to a shop. The packaged checkout takes the attempt's
    // payment hash and reopens it; remembering the hash is ours, because the
    // library owns no order and no storage.
    //
    // `onState` is where it comes from: the checkout reports every attempt it
    // is watching, and a swap attempt names its own hash.
    //
    // THE SAME CALLBACK FEEDS THE SUMMARY COLUMN. Rails reads its status card
    // off the keystone store that drives the engine; this stack has no such
    // store — the packaged checkout drives itself — so the state it reports IS
    // the source, run through the same `createCheckoutStatusModel` the Rails
    // store uses. Identical copy beside two different payment panels.
    //
    // One `useCallback` with only `reference` in it, deliberately: this
    // callback is a dependency of the effect that mounts Vue/Svelte/Angular
    // below, and an identity that changed on every state update would tear the
    // embedded app down and rebuild it once a second.
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
            has got to — is the column that does not change when the payer picks
            a coin; the payment column is the one they act in. The framework tab
            strip belongs INSIDE that second column, because choosing a
            framework is a statement about the payment screen and means nothing
            beside the cart. */}
        <div className="or-shop-stage or-checkout">
          <Stack className="or-checkout-summary" gap="md">
            <OrderStrip shop={shop} />
            <StatusCard status={createCheckoutStatusModel(checkoutState)} />
          </Stack>

          <Stack className="or-checkout-pay" gap="sm">
            <SegmentedControl
              aria-label="Checkout framework"
              data={FRAMEWORKS as unknown as { value: string; label: string }[]}
              fullWidth
              onChange={(value) => onFrameworkChange(value as CheckoutFramework)}
              size="xs"
              value={framework}
            />

            {framework === "react" ? (
              <Checkout
                defaultTheme="light"
                key={`react-${retryNonce}`}
                onSettled={onSettled}
                onStartOver={retrySameOrder}
                onState={rememberSwap}
                prefix={prefix}
                reference={reference}
                // NOT `syncUrl`: the HOST owns the address bar here, because it
                // also has to restore the order behind `/checkout/:reference`
                // on a cold load — see shared/checkout-resume.ts. This says the
                // order HAS such a URL, which is the one thing that decides
                // whether the refund screen tells the payer to bookmark it.
                resumable
                {...(resumePaymentHash ? { resumePaymentHash } : {})}
                // The shop has no dark mode — shop.css hard-codes #fff in
                // several places and says so at the top. A toggle here would
                // half-convert the page, so the packaged checkout is pinned to
                // light like every other stack's.
                themeToggle={false}
              />
            ) : (
              <EmbeddedCheckout
                framework={framework}
                key={`${framework}-${retryNonce}`}
                onSettled={onSettled}
                onStartOver={retrySameOrder}
                onSwapAttempt={rememberSwap}
                prefix={prefix}
                reference={reference}
                resumePaymentHash={resumePaymentHash}
              />
            )}
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

/**
 * Vue, Svelte and Angular, mounted imperatively into a plain div.
 *
 * `resumable: true` on all three, for the same reason as the React one above:
 * the host puts the order in the URL, so the packaged refund screen may tell
 * the payer to bookmark it.
 *
 * A component of its own so that REMOUNTING is a `key` change and nothing
 * else: the effect below runs on mount and tears down on unmount, which is
 * what an effect is for. Keeping it inside FrameworkCheckout meant carrying a
 * retry counter in the dependency array that the effect never read.
 */
const EmbeddedCheckout: React.FC<{
  readonly framework: Exclude<CheckoutFramework, "react">;
  readonly onSettled: () => void;
  readonly onStartOver: () => void;
  readonly onSwapAttempt: (state: CheckoutState) => void;
  readonly prefix: string;
  readonly reference: string;
  readonly resumePaymentHash: string;
}> = ({
  framework,
  onSettled,
  onStartOver,
  onSwapAttempt,
  prefix,
  reference,
  resumePaymentHash,
}) => {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const mountTarget = host;
    let canceled = false;
    let cleanup: () => void = () => undefined;

    const options = {
      rootSelector: ".or-page",
      defaultTheme: "light" as const,
      // The shop has no dark mode — shop.css hard-codes #fff in several places
      // and says so at the top — so every framework is pinned to light.
      themeToggle: false as const,
      onSettled: () => onSettled(),
      // The three element wrappers deliver state as a DOM CustomEvent rather
      // than a typed callback; the detail is the same CheckoutState React gets.
      onState: (event: Event) => {
        const state = (event as CustomEvent<CheckoutState>).detail;
        if (state) onSwapAttempt(state);
      },
    };
    const resumeProps = resumePaymentHash.length === 0 ? {} : { resumePaymentHash };

    const mount = async (): Promise<void> => {
      if (framework === "vue") {
        // The stylesheet loads lazily with its tab; Vite injects the CSS chunk
        // before the dynamic import resolves.
        const [{ default: VueCheckout }, { createApp }] = await Promise.all([
          import("@openreceive/vue/checkout.vue"),
          import("vue"),
          import("@openreceive/vue/styles.css"),
        ]);
        if (canceled) return;

        const app = createApp(VueCheckout, {
          reference,
          prefix,
          resumable: true,
          ...resumeProps,
          onSettled: options.onSettled,
          onStartOver,
          options,
        });
        app.mount(mountTarget);
        cleanup = () => app.unmount();
      }

      if (framework === "svelte") {
        const [{ default: SvelteCheckout }, { mount: mountSvelte, unmount }] = await Promise.all([
          import("@openreceive/svelte/checkout.svelte"),
          import("svelte"),
          import("@openreceive/svelte/styles.css"),
        ]);
        if (canceled) return;

        const component = mountSvelte(SvelteCheckout, {
          target: mountTarget,
          props: {
            reference,
            prefix,
            resumable: true,
            ...resumeProps,
            onSettled: options.onSettled,
            onStartOver,
            options,
          },
        });
        cleanup = () => void unmount(component);
      }

      if (framework === "angular") {
        await import("@angular/compiler");
        const [{ CheckoutComponent }, { createComponent }, { createApplication }] =
          await Promise.all([
            import("@openreceive/angular/checkout-component"),
            import("@angular/core"),
            import("@angular/platform-browser"),
            import("@openreceive/angular/styles.css"),
          ]);
        if (canceled) return;

        const application = await createApplication();
        if (canceled) {
          application.destroy();
          return;
        }

        const component = createComponent(CheckoutComponent, {
          environmentInjector: application.injector,
          hostElement: mountTarget,
        });
        component.setInput("reference", reference);
        component.setInput("prefix", prefix);
        component.setInput("resumable", true);
        if (resumePaymentHash.length > 0) {
          component.setInput("resumePaymentHash", resumePaymentHash);
        }
        component.setInput("onSettled", options.onSettled);
        component.setInput("onStartOver", onStartOver);
        component.setInput("options", options);
        application.attachView(component.hostView);
        component.changeDetectorRef.detectChanges();
        cleanup = () => {
          application.detachView(component.hostView);
          component.destroy();
          application.destroy();
        };
      }
    };

    void mount().catch((cause: unknown) => {
      console.error("Embedded checkout failed to mount.", cause);
    });

    return () => {
      canceled = true;
      cleanup();
      host.replaceChildren();
    };
  }, [framework, onSettled, onStartOver, onSwapAttempt, prefix, reference, resumePaymentHash]);

  return <div data-framework={framework} ref={hostRef} />;
};
