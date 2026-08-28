import {
  Alert,
  Button,
  Group,
  Loader,
  MantineProvider,
  SegmentedControl,
  Text,
} from "@mantine/core";
import type { CheckoutState } from "@openreceive/browser";
import { Checkout } from "@openreceive/react";
import { observer } from "mobx-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { loadShopBootstrap } from "../../../../shared/bootstrap.ts";
import { ShopPanel } from "../../../../shared/client/components/ShopPanel.tsx";
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
    const hostRef = useRef<HTMLDivElement | null>(null);
    const prefix = shop.checkout.prefix;

    useEffect(() => {
      const host = hostRef.current;
      if (host === null || framework === "react") return;
      const mountTarget = host;
      let canceled = false;
      let cleanup: () => void = () => undefined;

      const options = {
        rootSelector: ".or-page",
        defaultTheme: "light" as const,
        themeToggle: false as const,
        onSettled: (event: Event) => {
          const detail = (event as CustomEvent<{ state?: CheckoutState }>).detail;
          void detail;
          onSettled();
        },
      };

      const mount = async (): Promise<void> => {
        if (framework === "vue") {
          // The stylesheet loads lazily with its tab; Vite injects the CSS
          // chunk before the dynamic import resolves.
          const [{ default: VueCheckout }, { createApp }] = await Promise.all([
            import("@openreceive/vue/checkout.vue"),
            import("vue"),
            import("@openreceive/vue/styles.css"),
          ]);
          if (canceled) return;

          const app = createApp(VueCheckout, {
            reference,
            prefix,
            onSettled: options.onSettled,
            onStartOver: shop.startOver,
            options: {
              rootSelector: options.rootSelector,
              defaultTheme: options.defaultTheme,
              themeToggle: options.themeToggle,
            },
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
              onSettled: options.onSettled,
              onStartOver: shop.startOver,
              options: {
                rootSelector: options.rootSelector,
                defaultTheme: options.defaultTheme,
                themeToggle: options.themeToggle,
              },
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
          component.setInput("onSettled", options.onSettled);
          component.setInput("onStartOver", shop.startOver);
          component.setInput("options", {
            rootSelector: options.rootSelector,
            defaultTheme: options.defaultTheme,
            themeToggle: options.themeToggle,
          });
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
    }, [framework, onSettled, prefix, reference, shop.startOver]);

    return (
      <>
        <div className="or-shop-stage">
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
              onSettled={onSettled}
              onStartOver={shop.startOver}
              prefix={prefix}
              reference={reference}
              // The shop has no dark mode — shop.css hard-codes #fff in several
              // places and says so at the top. A toggle here would half-convert
              // the page, so the packaged checkout is pinned to light like every
              // other stack's.
              themeToggle={false}
            />
          ) : (
            <div data-framework={framework} ref={hostRef} />
          )}
        </div>

        <div className="or-shop-footer">
          <Button onClick={shop.startOver} size="sm" variant="subtle">
            Start over
          </Button>
          <Text c="dimmed" size="sm">
            {formatUsdCents(shop.orderTotalCents)}
          </Text>
        </div>
      </>
    );
  },
);
