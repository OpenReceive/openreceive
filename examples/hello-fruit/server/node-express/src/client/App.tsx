import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Checkout as OpenReceiveCheckout } from "@openreceive/browser";
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

interface CreateOrderResponse {
  readonly order: DemoOrder;
  readonly checkout: OpenReceiveCheckout;
}

function App(): React.ReactElement {
  const [framework, setFramework] = useState<CheckoutFramework>("react");
  const [fruitId, setFruitId] = useState(initialFruitId);
  const [currency, setCurrency] = useState("USD");
  const [rates, setRates] = useState<HelloFruitBtcFiatRates | undefined>(undefined);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [order, setOrder] = useState<DemoOrder | null>(null);
  const [checkout, setCheckout] = useState<OpenReceiveCheckout | null>(null);
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
    if (checkout !== null && completedCheckoutRef.current !== checkout.order_id) {
      logDemo("checkout.settled", "Checkout settled callback received.", {
        orderId: checkout.order_id,
        purchasedItemCount: purchasedItems.length,
      });
      completedCheckoutRef.current = checkout.order_id;
      setOrder((current) => (current === null ? current : { ...current, status: "paid" }));
      setStickerModalOpen(true);
    }
  }, [checkout, purchasedItems.length]);

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
      logDemo("create_order.skipped", "Create order clicked with an empty cart.");
      return;
    }
    const startedAt = Date.now();

    setCreating(true);
    setError("");
    setStickerModalOpen(false);
    completedCheckoutRef.current = "";

    try {
      logDemo("create_order.request", "Posting create order request.", {
        currency,
        cartLineCount: cartItems.length,
        cartQuantity: cartQuantity,
        productIds: cartItems.map((item) => item.fruit.id),
      });
      const response = await fetch("/create_order", {
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
      logDemo("create_order.response", "Received create order response.", {
        ok: response.ok,
        status: response.status,
        elapsedMs: Date.now() - startedAt,
        hasCheckout: isCreateOrderResponse(body),
      });
      if (!response.ok || !isCreateOrderResponse(body)) {
        throw new Error(readErrorMessage(body) ?? helloFruitDemoLabels.createOrderError);
      }

      logDemo("create_order.ready", "Checkout payload accepted by browser app.", {
        orderId: body.order.uuid,
        checkoutOrderId: body.checkout.order_id,
        orderStatus: body.order.status,
        itemCount: body.order.items.length,
        total: body.order.total_amount,
      });
      setOrder(body.order);
      setCheckout({
        ...body.checkout,
        fiat: body.order.total_amount,
      });
      setPurchasedItems(body.order.items);
    } catch (cause: unknown) {
      logDemo("create_order.error", "Create order failed in the browser.", {
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
      hadCheckout: checkout !== null,
      hadOrder: order !== null,
    });
    setFruitId(initialFruitId);
    setCart({});
    setOrder(null);
    setCheckout(null);
    setPurchasedItems([]);
    setStickerModalOpen(false);
    setCreating(false);
    setError("");
    completedCheckoutRef.current = "";
  }

  return (
    <ThemeScope as="main" className="page" themeToggle topbarClassName="topbar">
      <section className="checkout">
        <div className="framework-tabs" role="tablist" aria-label="Checkout framework">
          {checkoutFrameworks.map((item) => (
            <button
              aria-selected={framework === item.id}
              className={framework === item.id ? "selected" : ""}
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

        <div className="product">
          <img src={`/${selectedFruit?.sticker}`} alt="" />
          <div>
            <h1>{product.name}</h1>
            <p>{product.description}</p>
          </div>
        </div>

        <label className="currency-picker">
          <span>Currency</span>
          <select
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

        {checkout === null ? (
          <>
            <div className="fruit-grid">
              {fruits.map((fruit) => (
                <button
                  className={fruit.id === fruitId ? "selected" : ""}
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
                  <img src={`/${fruit.sticker}`} alt="" />
                  <span>{fruit.name}</span>
                  <small>{formatHelloFruitDisplayPrice(fruit.fiat, currency, rates)}</small>
                </button>
              ))}
            </div>

            <button className="primary" onClick={addSelectedFruitToCart} type="button">
              {createCheckoutLabel}
            </button>

            {cartItems.length === 0 ? null : (
              <section className="cart" aria-label="Cart">
                <div className="cart-heading">
                  <strong>Cart</strong>
                  <span>
                    {cartQuantity} item{cartQuantity === 1 ? "" : "s"}
                  </span>
                </div>
                {cartItems.map((item) => (
                  <div className="cart-row" key={item.fruit.id}>
                    <span>{item.fruit.name}</span>
                    <span>
                      {formatHelloFruitDisplayPrice(item.fruit.fiat, currency, rates)} x
                      {item.quantity}
                    </span>
                    <button
                      className="secondary"
                      onClick={() => removeFruitFromCart(item.fruit.id)}
                      type="button"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </section>
            )}

            <button
              className="primary"
              disabled={creating || cartItems.length === 0}
              onClick={createOrder}
              type="button"
            >
              {creating ? helloFruitDemoLabels.creatingOrder : helloFruitDemoLabels.createOrder}
            </button>
          </>
        ) : (
          <>
            {order === null ? null : (
              <section className="cart" aria-label="Order">
                <div className="cart-heading">
                  <strong>Order</strong>
                  <span>{formatHelloFruitFiat(order.total_amount)}</span>
                </div>
                {order.items.map((item) => (
                  <div className="cart-row" key={item.product_id}>
                    <span>{item.name}</span>
                    <span>x{item.quantity}</span>
                    <span>
                      {`${formatHelloFruitFiat(item.line_amount)} (${
                        order.status === "paid" ? "Paid" : "Pending"
                      })`}
                    </span>
                  </div>
                ))}
              </section>
            )}
            <button
              className="secondary reset-demo"
              disabled={creating}
              onClick={startOver}
              type="button"
            >
              Start over
            </button>
          </>
        )}

        {checkout === null ? null : (
          <FrameworkCheckout
            framework={framework}
            checkout={checkout}
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
        )}

        {error === "" ? null : <p className="error">{error}</p>}
      </section>
      {purchasedItems.length === 0 || !stickerModalOpen ? null : (
        <div className="sticker-modal-backdrop">
          <section
            aria-labelledby="sticker-modal-title"
            aria-modal="true"
            className="sticker-modal"
            role="dialog"
          >
            <div className="sticker-preview-grid">
              {purchasedItems.map((item) => (
                <img key={item.product_id} src={`/${item.sticker}`} alt="" />
              ))}
            </div>
            <h2 id="sticker-modal-title">
              {purchasedStickerQuantity === 1
                ? "You just got a sticker"
                : "Your stickers are ready"}
            </h2>
            <p>
              {purchasedStickerQuantity === 1
                ? `${purchasedItems[0]?.name ?? "Sticker"} is ready.`
                : `${purchasedStickerQuantity} stickers are ready.`}
            </p>
            <div className="sticker-downloads">
              {purchasedItems.map((item) => (
                <a
                  className="secondary sticker-download"
                  download={`${item.product_id}-sticker.svg`}
                  href={`/${item.sticker}`}
                  key={item.product_id}
                >
                  <span>Download {item.name}</span>
                  <small>x{item.quantity}</small>
                </a>
              ))}
            </div>
            <div className="sticker-modal-actions">
              <button className="primary" onClick={() => setStickerModalOpen(false)} type="button">
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
  readonly checkout: OpenReceiveCheckout;
  readonly onError: (error: unknown) => void;
  readonly onSettled: () => void;
  readonly onStartOver: () => void;
}

function FrameworkCheckout({
  framework,
  checkout,
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
      orderUrl: "/order",
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
        orderId: checkout.order_id,
      });
      if (framework === "vue") {
        const [{ default: VueCheckout }, { createApp }] = await Promise.all([
          import("@openreceive/vue/checkout.vue"),
          import("vue"),
        ]);
        if (canceled) return;

        const app = createApp(VueCheckout, {
          checkout,
          orderUrl: options.orderUrl,
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
          orderId: checkout.order_id,
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
        component.setInput("checkout", checkout);
        component.setInput("orderUrl", options.orderUrl);
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
          orderId: checkout.order_id,
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
            checkout,
            orderUrl: options.orderUrl,
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
          orderId: checkout.order_id,
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
        orderId: checkout.order_id,
      });
      canceled = true;
      cleanup();
      host.replaceChildren();
    };
  }, [framework, checkout, onError, onSettled, onStartOver]);

  if (framework === "react") {
    return (
      <Checkout
        className="demo-checkout"
        checkout={checkout}
        orderUrl="/order"
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

function isCreateOrderResponse(value: unknown): value is CreateOrderResponse {
  return typeof value === "object" && value !== null && "order" in value && "checkout" in value;
}

function readErrorMessage(value: unknown): string | undefined {
  return typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
    ? value.message
    : undefined;
}
