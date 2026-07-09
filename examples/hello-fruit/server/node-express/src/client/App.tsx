import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Checkout, ThemeScope } from "@openreceive/react";
import "@openreceive/angular/styles.css";
import "@openreceive/react/styles.css";
import "@openreceive/vue/styles.css";
import "@openreceive/svelte/styles.css";
import {
  createHelloFruitDemoBrowserConsoleLogger,
  createHelloFruitBrowserLogger,
} from "../../../../shared/demo-browser-logging.ts";
import { readHelloFruitCheckoutCurrencies } from "../../../../shared/demo-currencies.ts";
import {
  formatHelloFruitBuyNowLabel,
  formatHelloFruitFiat,
  helloFruitDemoLabels,
} from "../../../../shared/demo-formatting.ts";
import {
  formatHelloFruitDisplayPrice,
  toHelloFruitDisplayAmount,
  type HelloFruitBtcFiatRates,
} from "../../../../shared/demo-pricing.ts";
import fruitsData from "../../../../shared/fruits.json" with { type: "json" };
import product from "../../../../shared/product.json" with { type: "json" };
import "./styles.css";

const logOpenReceive = createHelloFruitBrowserLogger("node-express");
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
  readonly order: DemoOrder;
}

function App(): React.ReactElement {
  const [framework, setFramework] = useState<CheckoutFramework>("react");
  const [fruitId, setFruitId] = useState(initialFruitId);
  const [currency, setCurrency] = useState("USD");
  const [rates, setRates] = useState<HelloFruitBtcFiatRates | undefined>(undefined);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [order, setOrder] = useState<DemoOrder | null>(null);
  const [purchasedItems, setPurchasedItems] = useState<readonly DemoOrderItem[]>([]);
  const [stickerModalOpen, setStickerModalOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const completedCheckoutRef = useRef("");
  const selectedFruit = fruits.find((fruit) => fruit.id === fruitId) ?? fruits[0];
  const createCheckoutLabel =
    selectedFruit === undefined
      ? helloFruitDemoLabels.createOrder
      : formatHelloFruitBuyNowLabel(toHelloFruitDisplayAmount(selectedFruit.fiat, currency, rates));
  const cartItems = fruits
    .map((fruit) => ({ fruit, quantity: cart[fruit.id] ?? 0 }))
    .filter((item) => item.quantity > 0);
  const cartQuantity = cartItems.reduce((total, item) => total + item.quantity, 0);
  const purchasedStickerQuantity = purchasedItems.reduce((total, item) => total + item.quantity, 0);

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

  const onSettled = useCallback(() => {
    if (order !== null && completedCheckoutRef.current !== order.uuid) {
      logDemo("checkout.settled", "Checkout settled callback received.", {
        orderId: order.uuid,
        purchasedItemCount: purchasedItems.length,
      });
      completedCheckoutRef.current = order.uuid;
      setOrder((current) => (current === null ? current : { ...current, status: "paid" }));
      setStickerModalOpen(true);
    }
  }, [order, purchasedItems.length]);

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
    setStickerModalOpen(false);
    completedCheckoutRef.current = "";

    try {
      logDemo("prepare_order.request", "Posting prepare order request.", {
        currency,
        cartLineCount: cartItems.length,
        cartQuantity: cartQuantity,
        productIds: cartItems.map((item) => item.fruit.id),
      });
      // App route: build + persist the order. The <Checkout orderId> component below then creates
      // the checkout against the mounted /openreceive/checkouts route and drives it end to end.
      const response = await fetch("/prepare_order", {
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
      if (!response.ok || !isPrepareOrderResponse(body)) {
        throw new Error(readErrorMessage(body) ?? helloFruitDemoLabels.createOrderError);
      }

      logDemo("prepare_order.ready", "Order accepted by browser app.", {
        orderId: body.order.uuid,
        orderStatus: body.order.status,
        itemCount: body.order.items.length,
        total: body.order.total_amount,
      });
      setOrder(body.order);
      setPurchasedItems(body.order.items);
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
    setFruitId(initialFruitId);
    setCart({});
    setOrder(null);
    setPurchasedItems([]);
    setStickerModalOpen(false);
    setCreating(false);
    setError("");
    completedCheckoutRef.current = "";
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

        {order === null ? (
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

            <button className="btn" onClick={addSelectedFruitToCart} type="button">
              {createCheckoutLabel}
            </button>

            {cartItems.length === 0 ? null : (
              <>
                <section className="card card-border bg-base-100 px-3 py-2.5 grid gap-1.5" aria-label="Cart">
                  <div className="flex justify-between items-center text-sm">
                    <strong>Cart</strong>
                    <span>
                      {cartQuantity} item{cartQuantity === 1 ? "" : "s"}
                    </span>
                  </div>
                  {cartItems.map((item) => (
                    <div className="flex justify-between items-center gap-2 text-sm" key={item.fruit.id}>
                      <span className="flex items-center gap-2 min-w-0">
                        <img
                          className="w-6 h-6 shrink-0"
                          src={`/${item.fruit.sticker}`}
                          alt=""
                        />
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
                  className="btn"
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
            <section className="card card-border bg-base-200 px-3 py-2.5 grid gap-1" aria-label="Order">
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
                  className="btn btn-sm"
                  disabled={creating}
                  onClick={startOver}
                  type="button"
                >
                  Start over
                </button>
              </div>
            </section>

            <FrameworkCheckout
              framework={framework}
              orderId={order.uuid}
              onError={(cause) => {
                logDemo("checkout.error", "Checkout component reported an error.", {
                  framework,
                  error: cause instanceof Error ? cause.message : String(cause),
                });
                setError(cause instanceof Error ? cause.message : String(cause));
              }}
              onSettled={onSettled}
              onStartOver={startOver}
            />
          </>
        )}

        {error === "" ? null : <p className="alert alert-error">{error}</p>}
      </section>
      {purchasedItems.length === 0 || !stickerModalOpen ? null : (
        <div className="modal modal-open">
          <section
            aria-labelledby="sticker-modal-title"
            aria-modal="true"
            className="modal-box"
            role="dialog"
          >
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 justify-items-center">
              {purchasedItems.map((item) => (
                <img
                  className="w-full max-w-[180px] aspect-square"
                  key={item.product_id}
                  src={`/${item.sticker}`}
                  alt=""
                />
              ))}
            </div>
            <h2 className="text-2xl font-bold" id="sticker-modal-title">
              {purchasedStickerQuantity === 1
                ? "You just got a sticker"
                : "Your stickers are ready"}
            </h2>
            <p>
              {purchasedStickerQuantity === 1
                ? `${purchasedItems[0]?.name ?? "Sticker"} is ready.`
                : `${purchasedStickerQuantity} stickers are ready.`}
            </p>
            <div className="grid gap-2">
              {purchasedItems.map((item) => (
                <a
                  className="btn btn-soft justify-between"
                  download={`${item.product_id}-sticker.svg`}
                  href={`/${item.sticker}`}
                  key={item.product_id}
                >
                  <span>Download {item.name}</span>
                  <small>x{item.quantity}</small>
                </a>
              ))}
            </div>
            <div className="modal-action">
              <button className="btn" onClick={() => setStickerModalOpen(false)} type="button">
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
  readonly onError: (error: unknown) => void;
  readonly onSettled: () => void;
  readonly onStartOver: () => void;
}

// Each framework mounts its SELF-CONTAINED <Checkout orderId>: the component creates the checkout
// against the mounted router (prefix defaults to /openreceive), polls, and drives swaps itself, with
// the per-order token handled invisibly. The app never writes an invoice/status/swap route handler.
function FrameworkCheckout({
  framework,
  orderId,
  onError,
  onSettled,
  onStartOver,
}: FrameworkCheckoutProps): React.ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null || framework === "react") return;
    const mountTarget = host;
    let canceled = false;
    let cleanup: () => void = () => undefined;

    const options = {
      rootSelector: ".page",
      defaultTheme: "light" as const,
      onError: (event: Event) => {
        const detail = (event as CustomEvent<{ error?: unknown }>).detail;
        logDemo("checkout.embedded_error", "Embedded framework checkout reported an error.", {
          framework,
          error:
            detail?.error instanceof Error ? detail.error.message : String(detail?.error ?? event),
        });
        onError(detail?.error ?? event);
      },
      onSettled: onSettled,
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
          onSettled: options.onSettled,
          onStartOver,
          options: {
            rootSelector: options.rootSelector,
            defaultTheme: options.defaultTheme,
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
        component.setInput("onSettled", options.onSettled);
        component.setInput("onStartOver", onStartOver);
        component.setInput("options", {
          rootSelector: options.rootSelector,
          defaultTheme: options.defaultTheme,
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
            onSettled: options.onSettled,
            onStartOver,
            options: {
              rootSelector: options.rootSelector,
              defaultTheme: options.defaultTheme,
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
  }, [framework, orderId, onError, onSettled, onStartOver]);

  if (framework === "react") {
    return (
      <Checkout
        className="demo-checkout"
        orderId={orderId}
        logger={logOpenReceive}
        onError={onError}
        onSettled={onSettled}
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
  return typeof value === "object" && value !== null && "order" in value;
}

function readErrorMessage(value: unknown): string | undefined {
  return typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
    ? value.message
    : undefined;
}
