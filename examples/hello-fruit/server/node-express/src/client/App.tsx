import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CheckoutState } from "@openreceive/browser";
import { Checkout, ThemeScope, TransactionDetails } from "@openreceive/react";
import "@openreceive/angular/styles.css";
import "@openreceive/react/styles.css";
import "@openreceive/vue/styles.css";
import "@openreceive/svelte/styles.css";
import { createHelloFruitDemoBrowserConsoleLogger } from "../../../../shared/demo-browser-logging.ts";
import {
  enterHelloFruitCheckout,
  forgetHelloFruitOrder,
  leaveHelloFruitCheckout,
  loadHelloFruitOrderForResume,
  parseHelloFruitCheckoutOrderId,
  rememberHelloFruitOrder,
} from "../../../../shared/demo-checkout-resume.ts";
import {
  fetchHelloFruitPurchasedStickers,
  revokeHelloFruitStickers,
  type HelloFruitPurchasedSticker,
  waitForHelloFruitPaidSummary,
} from "../../../../shared/demo-delivery-client.ts";
import { launchHelloFruitConfetti } from "../../../../shared/demo-confetti.ts";
import { isHelloFruitDemoOrder } from "../../../../shared/demo-order.ts";
import { readHelloFruitCheckoutCurrencies } from "../../../../shared/demo-currencies.ts";
import {
  formatHelloFruitBuyNowLabel,
  formatHelloFruitFiat,
  helloFruitDemoLabels,
  helloFruitStickerModalCopy,
} from "../../../../shared/demo-formatting.ts";
import {
  formatHelloFruitDisplayPrice,
  toHelloFruitDisplayAmount,
  type HelloFruitBtcFiatRates,
} from "../../../../shared/demo-pricing.ts";
import fruitsData from "../../../../shared/fruits.json" with { type: "json" };
import product from "../../../../shared/product.json" with { type: "json" };
import "./styles.css";

const logDemo = createHelloFruitDemoBrowserConsoleLogger("node-express");
const fruits = fruitsData.fruits;
const currencyOptions = readHelloFruitCheckoutCurrencies();
type CheckoutFramework = "react" | "vue" | "svelte" | "angular";
const initialFruitId = fruits[1]?.id ?? fruits[0]?.id ?? "";
const checkoutFrameworks: readonly {
  readonly id: CheckoutFramework;
  readonly label: string;
}[] = [
  { id: "react", label: "React" },
  { id: "vue", label: "Vue" },
  { id: "svelte", label: "Svelte" },
  { id: "angular", label: "Angular" },
];

interface DemoOrder {
  readonly uuid: string;
  readonly status: "pending_payment" | "paid";
  readonly items: readonly DemoOrderItem[];
  readonly total_amount: DemoMoneyAmount;
}

interface DemoOrderItem {
  readonly product_id: string;
  readonly name: string;
  readonly sticker: string;
  readonly quantity: number;
  readonly unit_amount: DemoMoneyAmount;
  readonly line_amount: DemoMoneyAmount;
}

interface DemoMoneyAmount {
  readonly currency: string;
  readonly value: string;
}

interface PrepareOrderResponse {
  readonly order_id: string;
  readonly summary?: DemoOrder;
}

function App(): React.ReactElement {
  const [framework, setFramework] = useState<CheckoutFramework>("react");
  const [fruitId, setFruitId] = useState(initialFruitId);
  const [currency, setCurrency] = useState("USD");
  const [rates, setRates] = useState<HelloFruitBtcFiatRates | undefined>(undefined);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [order, setOrder] = useState<DemoOrder | null>(null);
  const [purchasedStickers, setPurchasedStickers] = useState<readonly HelloFruitPurchasedSticker[]>(
    [],
  );
  const [stickerModalOpen, setStickerModalOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [settledCheckoutState, setSettledCheckoutState] = useState<CheckoutState | null>(null);
  const [resumeOrderId, setResumeOrderId] = useState(() =>
    parseHelloFruitCheckoutOrderId(globalThis.location.pathname),
  );
  const [resuming, setResuming] = useState(() =>
    Boolean(parseHelloFruitCheckoutOrderId(globalThis.location.pathname)),
  );
  const [resumeError, setResumeError] = useState<string | null>(null);
  const displayError = error === "" ? (resumeError ?? "") : error;

  function onCheckoutState(state: CheckoutState): void {
    if (state.settled) {
      setSettledCheckoutState(state);
    }
    // Soft swap-preparing conflicts are not sticky once checkout is progressing again.
    setError((current) => (current.includes("still being prepared") ? "" : current));
  }

  function closeStickerModal(): void {
    setStickerModalOpen(false);
    setPurchasedStickers((current) => {
      revokeHelloFruitStickers(current);
      return [];
    });
  }

  /** onSettled is a display hint — wait for server onPaid to mark the summary paid. */
  const revealFulfilledDelivery = useCallback(async (orderId: string): Promise<void> => {
    const paid = await waitForHelloFruitPaidSummary({ orderId });
    logDemo("fulfillment.summary_paid", "Server marked order paid; loading delivery.", {
      orderId,
      itemCount: paid.items.length,
    });
    setOrder(paid);
    const stickers = await fetchHelloFruitPurchasedStickers(paid);
    setPurchasedStickers((current) => {
      revokeHelloFruitStickers(current);
      return stickers;
    });
    setStickerModalOpen(true);
  }, []);

  function onSettled(): void {
    const orderId = order?.uuid ?? resumeOrderId;
    launchHelloFruitConfetti();
    logDemo(
      "checkout.settled",
      "Checkout settled callback received — waiting for server fulfillment.",
      {
        orderId,
        purchasedItemCount: order?.items.length ?? 0,
      },
    );
    if (orderId === undefined) return;
    void revealFulfilledDelivery(orderId).catch((cause: unknown) => {
      logDemo("fulfillment.error", "Failed to load server fulfillment.", {
        orderId,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }

  function resetCheckoutResume(): void {
    setSettledCheckoutState(null);
    setResumeError(null);
    setResuming(false);
  }

  useEffect(() => {
    if (resumeOrderId === undefined || order?.uuid === resumeOrderId) return;
    let cancelled = false;
    setResuming(true);
    void loadHelloFruitOrderForResume(resumeOrderId).then((summary) => {
      if (cancelled) return;
      if (summary === undefined) {
        logDemo("checkout.resume_miss", "Checkout resume order not found.", {
          orderId: resumeOrderId,
        });
        leaveHelloFruitCheckout();
        setResumeOrderId(undefined);
        setOrder(null);
        setResuming(false);
        setResumeError("Order not found.");
        return;
      }
      logDemo("checkout.resume", "Resuming checkout from summary.", { orderId: summary.uuid });
      setOrder(summary);
      setResuming(false);
      setResumeError(null);
      if (summary.status === "paid") {
        void revealFulfilledDelivery(summary.uuid).catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [resumeOrderId, order?.uuid, revealFulfilledDelivery]);

  useEffect(() => {
    function onPopState(): void {
      const next = parseHelloFruitCheckoutOrderId(globalThis.location.pathname);
      setResumeOrderId(next);
      if (next === undefined) {
        setOrder(null);
        setResuming(false);
        return;
      }
      if (order?.uuid === next) return;
      setOrder(null);
      setResuming(true);
    }
    globalThis.addEventListener("popstate", onPopState);
    return () => globalThis.removeEventListener("popstate", onPopState);
  }, [order?.uuid]);
  const selectedFruit = fruits.find((fruit) => fruit.id === fruitId) ?? fruits[0];
  const createCheckoutLabel =
    selectedFruit === undefined
      ? helloFruitDemoLabels.createOrder
      : formatHelloFruitBuyNowLabel(toHelloFruitDisplayAmount(selectedFruit.fiat, currency, rates));
  const cartItems = fruits
    .map((fruit) => ({ fruit, quantity: cart[fruit.id] ?? 0 }))
    .filter((item) => item.quantity > 0);
  const cartQuantity = cartItems.reduce((total, item) => total + item.quantity, 0);
  const stickerModalCopy = helloFruitStickerModalCopy(purchasedStickers);

  useEffect(() => {
    logDemo("app.ready", "React demo app mounted.", {
      fruitCount: fruits.length,
      currencyOptions,
      initialFruitId,
      framework,
    });
  }, [framework]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/rates");
        if (!response.ok) throw new Error(`rates request failed: HTTP ${response.status}`);
        const body = (await response.json()) as {
          rates?: HelloFruitBtcFiatRates;
        };
        if (cancelled || body.rates === undefined) return;
        setRates(body.rates);
        logDemo("rates.loaded", "Loaded display exchange rates.", {
          rateCurrencies: Object.keys(body.rates.bitcoin),
        });
      } catch (cause: unknown) {
        logDemo("rates.error", "Failed to load display exchange rates.", {
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    logDemo("checkout.framework_selected", "Checkout framework selected.", {
      framework,
    });
  }, [framework]);

  function addSelectedFruitToCart() {
    if (selectedFruit === undefined) return;
    const nextQuantity = Math.min((cart[selectedFruit.id] ?? 0) + 1, 9);
    logDemo("cart.add", "Adding selected fruit to cart.", {
      fruitId: selectedFruit.id,
      fruitName: selectedFruit.name,
      currency,
      quantity: nextQuantity,
    });
    setCart((current) => ({
      ...current,
      [selectedFruit.id]: Math.min((current[selectedFruit.id] ?? 0) + 1, 9),
    }));
  }

  function removeFruitFromCart(fruitIdToRemove: string) {
    logDemo("cart.remove", "Removing fruit from cart.", {
      fruitId: fruitIdToRemove,
    });
    setCart((current) => {
      const next = { ...current };
      delete next[fruitIdToRemove];
      return next;
    });
  }

  async function createOrder() {
    if (cartItems.length === 0) {
      logDemo("prepare_order.skipped", "Prepare order clicked with an empty cart.");
      return;
    }
    const startedAt = Date.now();

    setCreating(true);
    setError("");
    closeStickerModal();
    resetCheckoutResume();

    try {
      logDemo("prepare_order.request", "Posting prepare order request.", {
        currency,
        cartLineCount: cartItems.length,
        cartQuantity: cartQuantity,
        productIds: cartItems.map((item) => item.fruit.id),
      });
      // The host creates its own order first. <Checkout orderId> then asks the mounted
      // OpenReceive route to mint at the amount resolved from that host row.
      const response = await fetch("/orders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          currency,
          cart: cartItems.map((item) => ({
            product_id: item.fruit.id,
            quantity: item.quantity,
          })),
        }),
      });
      const body = (await response.json()) as unknown;
      logDemo("prepare_order.response", "Received prepare order response.", {
        ok: response.ok,
        status: response.status,
        elapsedMs: Date.now() - startedAt,
        hasOrder: isPrepareOrderResponse(body),
      });
      if (!response.ok || !isPrepareOrderResponse(body) || !isHelloFruitDemoOrder(body.summary)) {
        throw new Error(readErrorMessage(body) ?? helloFruitDemoLabels.createOrderError);
      }

      const order = body.summary;
      logDemo("prepare_order.ready", "Order accepted by browser app.", {
        orderId: order.uuid,
        orderStatus: order.status,
        itemCount: order.items.length,
        total: order.total_amount,
      });
      rememberHelloFruitOrder(order);
      enterHelloFruitCheckout(order.uuid);
      setResumeOrderId(order.uuid);
      setOrder(order);
    } catch (cause: unknown) {
      logDemo("prepare_order.error", "Prepare order failed in the browser.", {
        error: cause instanceof Error ? cause.message : String(cause),
        elapsedMs: Date.now() - startedAt,
      });
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  }

  function startOver() {
    logDemo("app.reset", "Resetting the demo state.", {
      hadOrder: order !== null,
    });
    forgetHelloFruitOrder(order?.uuid);
    leaveHelloFruitCheckout();
    setResumeOrderId(undefined);
    setFruitId(initialFruitId);
    setCart({});
    setOrder(null);
    closeStickerModal();
    resetCheckoutResume();
    setCreating(false);
    setError("");
  }

  const fruitCardClass = (selected: boolean) =>
    [
      "card card-border bg-base-100 p-3 grid gap-2 text-left cursor-pointer hover:border-primary",
      selected ? "border-primary ring-2 ring-primary/30" : "",
    ]
      .filter(Boolean)
      .join(" ");

  return (
    <ThemeScope
      as="main"
      className="page min-h-screen grid justify-items-center content-start p-4 md:p-8 gap-3"
      defaultTheme="light"
      themeToggle
      topbarClassName="topbar w-full max-w-5xl flex justify-end"
    >
      <section className="checkout w-full max-w-5xl grid gap-3">
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

        <div className="flex gap-3 items-center">
          <img className="w-16 aspect-square" src={`/${selectedFruit?.sticker}`} alt="" />
          <div className="min-w-0">
            <h1 className="text-2xl font-bold leading-tight">{product.name}</h1>
            <p className="text-base-content/70 text-sm">{product.description}</p>
          </div>
        </div>

        {order === null && resumeOrderId === undefined ? (
          <>
            <label className="form-control w-full max-w-xs">
              <span className="label-text mb-1">Currency</span>
              <select
                className="select select-bordered w-full"
                value={currency}
                onChange={(event) => {
                  logDemo("currency.change", "Currency changed.", {
                    from: currency,
                    to: event.target.value,
                  });
                  setCurrency(event.target.value);
                }}
              >
                {currencyOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {fruits.map((fruit) => (
                <button
                  className={fruitCardClass(fruit.id === fruitId)}
                  key={fruit.id}
                  onClick={() => {
                    logDemo("fruit.select", "Fruit selected.", {
                      fruitId: fruit.id,
                      fruitName: fruit.name,
                    });
                    setFruitId(fruit.id);
                  }}
                  type="button"
                >
                  <img className="w-full aspect-square" src={`/${fruit.sticker}`} alt="" />
                  <span>{fruit.name}</span>
                  <small className="text-base-content/70">
                    {formatHelloFruitDisplayPrice(fruit.fiat, currency, rates)}
                  </small>
                </button>
              ))}
            </div>

            <button className="btn btn-outline" onClick={addSelectedFruitToCart} type="button">
              {createCheckoutLabel}
            </button>

            {cartItems.length === 0 ? null : (
              <>
                <section
                  className="card card-border bg-base-100 px-3 py-2.5 grid gap-1.5"
                  aria-label="Cart"
                >
                  <div className="flex justify-between items-center text-sm">
                    <strong>Cart</strong>
                    <span>
                      {cartQuantity} item{cartQuantity === 1 ? "" : "s"}
                    </span>
                  </div>
                  {cartItems.map((item) => (
                    <div
                      className="flex justify-between items-center gap-2 text-sm"
                      key={item.fruit.id}
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <img className="w-6 h-6 shrink-0" src={`/${item.fruit.sticker}`} alt="" />
                        {item.fruit.name} ×{item.quantity}
                      </span>
                      <span className="text-base-content/70">
                        {formatHelloFruitDisplayPrice(item.fruit.fiat, currency, rates)}
                      </span>
                      <button
                        className="btn btn-ghost btn-xs"
                        onClick={() => removeFruitFromCart(item.fruit.id)}
                        type="button"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </section>

                <button
                  className="btn btn-outline"
                  disabled={creating}
                  onClick={createOrder}
                  type="button"
                >
                  {creating ? helloFruitDemoLabels.creatingOrder : helloFruitDemoLabels.createOrder}
                </button>
              </>
            )}
          </>
        ) : (
          <>
            {order === null ? (
              <p className="text-base-content/70 text-sm">
                {resuming ? "Restoring checkout…" : "Loading order…"}
              </p>
            ) : (
              <section
                className="card card-border bg-base-200 px-3 py-2.5 grid gap-1"
                aria-label="Order"
              >
                <div className="flex justify-between items-baseline gap-3">
                  <strong className="text-sm">Order</strong>
                  <span className="font-semibold">{formatHelloFruitFiat(order.total_amount)}</span>
                </div>
                {order.items.map((item) => (
                  <div
                    className="flex justify-between items-baseline gap-3 text-sm text-base-content/80"
                    key={item.product_id}
                  >
                    <span>
                      {item.name} ×{item.quantity}
                    </span>
                    <span className="text-base-content/60">
                      {formatHelloFruitFiat(item.line_amount)}
                      {order.status === "paid" ? " · Paid" : ""}
                    </span>
                  </div>
                ))}
                <div className="card-actions pt-1">
                  <button
                    className="btn btn-sm btn-outline"
                    disabled={creating}
                    onClick={startOver}
                    type="button"
                  >
                    Start over
                  </button>
                </div>
              </section>
            )}

            <FrameworkCheckout
              framework={framework}
              orderId={(order?.uuid ?? resumeOrderId) as string}
              routeOrderId={resumeOrderId}
              onError={(cause) => {
                logDemo("checkout.error", "Checkout component reported an error.", {
                  framework,
                  error: cause instanceof Error ? cause.message : String(cause),
                });
                setError(cause instanceof Error ? cause.message : String(cause));
              }}
              onSettled={onSettled}
              onState={onCheckoutState}
              onStartOver={startOver}
            />
          </>
        )}

        {displayError === "" ? null : <p className="alert alert-error">{displayError}</p>}
      </section>
      {purchasedStickers.length === 0 || !stickerModalOpen ? null : (
        <div className="modal modal-open">
          <section
            aria-labelledby="sticker-modal-title"
            aria-modal="true"
            className="modal-box"
            role="dialog"
          >
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 justify-items-center">
              {purchasedStickers.map((sticker) => (
                <img
                  className="w-full max-w-[180px] aspect-square"
                  key={sticker.productId}
                  src={sticker.objectUrl}
                  alt=""
                />
              ))}
            </div>
            <h2 className="text-2xl font-bold" id="sticker-modal-title">
              {stickerModalCopy.title}
            </h2>
            <p>{stickerModalCopy.detail}</p>
            <div className="grid gap-2">
              {purchasedStickers.map((sticker) => (
                <a
                  className="card card-border bg-base-100 flex-row items-center gap-3 p-3 transition-colors hover:border-primary hover:bg-primary/5"
                  download={sticker.filename}
                  href={sticker.objectUrl}
                  key={sticker.productId}
                >
                  <span className="rounded-lg bg-primary/10 p-2 text-primary">
                    <svg
                      aria-hidden="true"
                      className="size-5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      viewBox="0 0 24 24"
                    >
                      <path
                        d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{sticker.name} sticker</span>
                    <span className="block text-sm text-base-content/60">
                      SVG file{sticker.quantity > 1 ? ` · ×${sticker.quantity}` : ""}
                    </span>
                  </span>
                  <span className="btn btn-primary btn-sm">Download</span>
                </a>
              ))}
            </div>
            <TransactionDetails state={settledCheckoutState} />
            <div className="modal-action">
              <button className="btn" onClick={closeStickerModal} type="button">
                Close
              </button>
            </div>
          </section>
        </div>
      )}
    </ThemeScope>
  );
}

interface FrameworkCheckoutProps {
  readonly framework: CheckoutFramework;
  readonly orderId: string;
  readonly routeOrderId?: string;
  readonly onError: (error: unknown) => void;
  readonly onSettled: () => void;
  readonly onState: (state: CheckoutState) => void;
  readonly onStartOver: () => void;
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
        const [{ default: VueCheckout }, { createApp }] = await Promise.all([
          import("@openreceive/vue/checkout.vue"),
          import("vue"),
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

function isPrepareOrderResponse(value: unknown): value is PrepareOrderResponse {
  return typeof value === "object" && value !== null && "order_id" in value;
}

function readErrorMessage(value: unknown): string | undefined {
  return typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
    ? value.message
    : undefined;
}
