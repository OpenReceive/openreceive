import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CheckoutState } from "@openreceive/browser";
import { Checkout } from "@openreceive/react";
// Only the default (React) checkout styles load eagerly so first paint is
// correct; each other framework's stylesheet loads with its tab (see
// mountFrameworkCheckout below).
import "@openreceive/react/styles.css";
import { createHelloFruitDemoBrowserConsoleLogger } from "../../../../shared/demo-browser-logging.ts";
import {
  enterHelloFruitCheckout,
  leaveHelloFruitCheckout,
  parseHelloFruitCheckoutOrderId,
} from "../../../../shared/demo-checkout-resume.ts";
import {
  HelloFruitShopApp,
  type HelloFruitShopCheckoutSlotProps,
} from "../../../../shared/demo-shop-app.tsx";
import fruitsData from "../../../../shared/fruits.json" with { type: "json" };
import product from "../../../../shared/product.json" with { type: "json" };
import "./styles.css";

const logDemo = createHelloFruitDemoBrowserConsoleLogger("node-express");
const fruits = fruitsData.fruits;
type CheckoutFramework = "react" | "vue" | "svelte" | "angular";
const checkoutFrameworks: readonly {
  readonly id: CheckoutFramework;
  readonly label: string;
}[] = [
  { id: "react", label: "React" },
  { id: "vue", label: "Vue" },
  { id: "svelte", label: "Svelte" },
  { id: "angular", label: "Angular" },
];

function App(): React.ReactElement {
  const [framework, setFramework] = useState<CheckoutFramework>("react");
  const [resumeOrderId, setResumeOrderId] = useState(() =>
    parseHelloFruitCheckoutOrderId(globalThis.location.pathname),
  );

  useEffect(() => {
    function onPopState(): void {
      setResumeOrderId(parseHelloFruitCheckoutOrderId(globalThis.location.pathname));
    }
    globalThis.addEventListener("popstate", onPopState);
    return () => globalThis.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    logDemo("checkout.framework_selected", "Checkout framework selected.", {
      framework,
    });
  }, [framework]);

  const onEnterCheckout = useCallback((orderId: string): void => {
    enterHelloFruitCheckout(orderId);
    setResumeOrderId(orderId);
  }, []);

  const onExitCheckout = useCallback((): void => {
    leaveHelloFruitCheckout();
    setResumeOrderId(undefined);
  }, []);

  const renderCheckout = useCallback(
    (slot: HelloFruitShopCheckoutSlotProps): React.ReactElement => (
      <FrameworkCheckout framework={framework} {...slot} />
    ),
    [framework],
  );

  return (
    <HelloFruitShopApp
      logDemo={logDemo}
      product={product}
      fruits={fruits}
      resumeOrderId={resumeOrderId}
      onEnterCheckout={onEnterCheckout}
      onExitCheckout={onExitCheckout}
      renderCheckout={renderCheckout}
      topContent={
        <div className="tabs tabs-box" role="tablist" aria-label="Checkout framework">
          {checkoutFrameworks.map((item) => (
            <button
              aria-selected={framework === item.id}
              className={framework === item.id ? "tab tab-active" : "tab"}
              key={item.id}
              onClick={() => {
                logDemo("checkout.framework_click", "Framework tab clicked.", {
                  framework: item.id,
                });
                setFramework(item.id);
              }}
              role="tab"
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>
      }
    />
  );
}

interface FrameworkCheckoutProps extends HelloFruitShopCheckoutSlotProps {
  readonly framework: CheckoutFramework;
}

// Each framework mounts its SELF-CONTAINED <Checkout orderId>: the component creates the
// checkout against the mounted router, polls, and drives swaps itself.
// Pass `syncUrl` only when you want Checkout to push `/checkout/:orderId` (this demo owns that).
function FrameworkCheckout({
  framework,
  orderId,
  routeOrderId,
  onError,
  onSettled,
  onState,
  onStartOver,
}: FrameworkCheckoutProps): React.ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null || framework === "react") return;
    const mountTarget = host;
    let canceled = false;
    let cleanup: () => void = () => undefined;

    // ThemeScope on `.page` owns the toggle; frameworks inherit via ancestor data-theme.
    const options = {
      rootSelector: ".page",
      defaultTheme: "light" as const,
      themeToggle: false as const,
      onError: (event: Event) => {
        const detail = (event as CustomEvent<{ error?: unknown }>).detail;
        logDemo("checkout.embedded_error", "Embedded framework checkout reported an error.", {
          framework,
          error:
            detail?.error instanceof Error ? detail.error.message : String(detail?.error ?? event),
        });
        onError(detail?.error ?? event);
      },
      onSettled: (event: Event) => {
        const detail = (event as CustomEvent<{ state?: CheckoutState }>).detail;
        if (detail?.state !== undefined) onState(detail.state);
        onSettled();
      },
      onState: (event: Event) => {
        const detail = (event as CustomEvent<{ state?: CheckoutState }>).detail;
        if (detail?.state !== undefined) onState(detail.state);
      },
    };

    async function mountFrameworkCheckout() {
      logDemo("checkout.embedded_mount_start", "Mounting embedded checkout framework.", {
        framework,
        orderId,
      });
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
          orderId,
          ...(routeOrderId === undefined ? {} : { routeOrderId }),
          onSettled: options.onSettled,
          onStartOver,
          options: {
            rootSelector: options.rootSelector,
            defaultTheme: options.defaultTheme,
            themeToggle: options.themeToggle,
            onError: options.onError,
          },
        });
        app.mount(mountTarget);
        logDemo("checkout.embedded_mount_ready", "Vue checkout mounted.", {
          orderId,
        });
        cleanup = () => app.unmount();
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
        component.setInput("orderId", orderId);
        if (routeOrderId !== undefined) component.setInput("routeOrderId", routeOrderId);
        component.setInput("onSettled", options.onSettled);
        component.setInput("onStartOver", onStartOver);
        component.setInput("options", {
          rootSelector: options.rootSelector,
          defaultTheme: options.defaultTheme,
          themeToggle: options.themeToggle,
          onError: options.onError,
        });
        application.attachView(component.hostView);
        component.changeDetectorRef.detectChanges();
        logDemo("checkout.embedded_mount_ready", "Angular checkout mounted.", {
          orderId,
        });
        cleanup = () => {
          application.detachView(component.hostView);
          component.destroy();
          application.destroy();
        };
      }

      if (framework === "svelte") {
        const [{ default: SvelteCheckout }, { mount, unmount }] = await Promise.all([
          import("@openreceive/svelte/checkout.svelte"),
          import("svelte"),
          import("@openreceive/svelte/styles.css"),
        ]);
        if (canceled) return;

        const component = mount(SvelteCheckout, {
          target: mountTarget,
          props: {
            orderId,
            ...(routeOrderId === undefined ? {} : { routeOrderId }),
            onSettled: options.onSettled,
            onStartOver,
            options: {
              rootSelector: options.rootSelector,
              defaultTheme: options.defaultTheme,
              themeToggle: options.themeToggle,
              onError: options.onError,
            },
          },
        });
        logDemo("checkout.embedded_mount_ready", "Svelte checkout mounted.", {
          orderId,
        });
        cleanup = () => {
          void unmount(component);
        };
      }
    }

    void mountFrameworkCheckout().catch(onError);

    return () => {
      logDemo("checkout.embedded_unmount", "Unmounting embedded checkout framework.", {
        framework,
        orderId,
      });
      canceled = true;
      cleanup();
      host.replaceChildren();
    };
  }, [framework, orderId, routeOrderId, onError, onSettled, onState, onStartOver]);

  if (framework === "react") {
    return (
      <Checkout
        className="demo-checkout"
        orderId={orderId}
        routeOrderId={routeOrderId}
        onError={onError}
        onSettled={onSettled}
        onState={onState}
        onStartOver={onStartOver}
      />
    );
  }

  return (
    <div
      className="demo-checkout embedded-framework-checkout"
      data-framework={framework}
      ref={hostRef}
    />
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
