"use client";

import type { CheckoutState } from "@openreceive/browser/internal";
import { Checkout, ThemeScope, TransactionDetails } from "@openreceive/react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { HelloFruit, HelloFruitProduct } from "../server/shared-data.ts";
import {
  createHelloFruitDemoBrowserConsoleLogger,
  createHelloFruitBrowserLogger,
} from "../../../../shared/demo-browser-logging.ts";
import {
  forgetHelloFruitOrder,
  helloFruitCheckoutPath,
  rememberHelloFruitOrder,
} from "../../../../shared/demo-checkout-resume.ts";
import type { HelloFruitDemoOrder } from "../../../../shared/demo-order.ts";
import { isHelloFruitDemoOrder } from "../../../../shared/demo-order.ts";
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

const logOpenReceive = createHelloFruitBrowserLogger("nextjs-fullstack");
const logDemo = createHelloFruitDemoBrowserConsoleLogger("nextjs-fullstack");
const currencyOptions = readHelloFruitCheckoutCurrencies();

interface CheckoutClientProps {
  readonly product: HelloFruitProduct;
  readonly fruits: readonly HelloFruit[];
  /** When set (from `/checkout/[orderId]`), restore that guest checkout instead of the shop. */
  readonly resumeOrderId?: string;
}

interface DemoOrder {
  readonly uuid: string;
  readonly status: "pending_payment" | "paid";
  readonly items: HelloFruitDemoOrder["items"];
  readonly total_amount: HelloFruitDemoOrder["total_amount"];
}

interface PrepareOrderResponse {
  readonly order_id: string;
  readonly summary?: DemoOrder;
}

export default function CheckoutClient({ product, fruits, resumeOrderId }: CheckoutClientProps) {
  const router = useRouter();
  const [fruitId, setFruitId] = useState(fruits[1]?.id ?? fruits[0]?.id ?? "");
  const [currency, setCurrency] = useState("USD");
  const [rates, setRates] = useState<HelloFruitBtcFiatRates | undefined>();
  const [cart, setCart] = useState<Record<string, number>>({});
  const [order, setOrder] = useState<DemoOrder | undefined>();
  const [purchasedFruit, setPurchasedFruit] = useState<HelloFruit | undefined>();
  const [stickerModalOpen, setStickerModalOpen] = useState(false);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const [settledCheckoutState, setSettledCheckoutState] = useState<CheckoutState | null>(null);
  const [resuming, setResuming] = useState(Boolean(resumeOrderId));
  const [resumeError, setResumeError] = useState<string | null>(null);
  const displayError = error === "" ? (resumeError ?? "") : error;

  function onCheckoutState(state: CheckoutState): void {
    if (state.settled) setSettledCheckoutState(state);
  }

  function onSettled(): void {
    logDemo("checkout.settled", "Checkout settled callback received.", {
      orderId: order?.uuid,
      purchasedFruitId: purchasedFruit?.id,
    });
    setOrder((current) => (current === undefined ? current : { ...current, status: "paid" }));
    setStickerModalOpen(true);
  }

  function resetCheckoutResume(): void {
    setSettledCheckoutState(null);
    setResumeError(null);
    setResuming(false);
  }

  function onSummary(summary: unknown): void {
    if (!isHelloFruitDemoOrder(summary)) return;
    logDemo("checkout.resume", "Resuming checkout from summary.", { orderId: summary.uuid });
    setOrder(summary);
    const firstItem = summary.items[0];
    setPurchasedFruit(
      firstItem === undefined
        ? undefined
        : fruits.find((fruit) => fruit.id === firstItem.product_id),
    );
    setStatus("invoice_created");
    setResuming(false);
    setResumeError(null);
  }

  function onResumeMiss(orderId: string): void {
    logDemo("checkout.resume_miss", "Checkout resume order not found.", { orderId });
    setOrder(undefined);
    setPurchasedFruit(undefined);
    setResuming(false);
    setResumeError("Order not found.");
    router.replace("/");
  }

  const selectedFruit = useMemo(
    () => fruits.find((fruit) => fruit.id === fruitId) ?? fruits[0],
    [fruitId, fruits],
  );
  const createCheckoutLabel =
    selectedFruit === undefined
      ? helloFruitDemoLabels.createOrder
      : formatHelloFruitBuyNowLabel(toHelloFruitDisplayAmount(selectedFruit.fiat, currency, rates));
  const cartItems = fruits
    .map((fruit) => ({ fruit, quantity: cart[fruit.id] ?? 0 }))
    .filter((item) => item.quantity > 0);
  const cartQuantity = cartItems.reduce((total, item) => total + item.quantity, 0);

  useEffect(() => {
    logDemo("app.ready", "Next.js checkout client mounted.", {
      fruitCount: fruits.length,
      currencyOptions,
      initialFruitId: fruitId,
      selectedCurrency: currency,
      resumeOrderId,
    });
  }, [currency, fruitId, fruits.length, resumeOrderId]);

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

    setStatus("creating");
    setError("");
    setStickerModalOpen(false);
    resetCheckoutResume();

    try {
      logDemo("prepare_order.request", "Posting prepare order request.", {
        currency,
        cartLineCount: cartItems.length,
        cartQuantity,
        productIds: cartItems.map((item) => item.fruit.id),
      });
      // App route: build + persist the order. The <Checkout orderId> component below creates the
      // checkout against the mounted /openreceive/checkouts route and drives it end to end.
      const response = await fetch("/openreceive/prepare", {
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
      const preparedOrder = body.summary;

      logDemo("prepare_order.ready", "Order accepted by browser app.", {
        orderId: preparedOrder.uuid,
        orderStatus: preparedOrder.status,
        itemCount: preparedOrder.items.length,
        total: preparedOrder.total_amount,
      });
      rememberHelloFruitOrder(preparedOrder);
      router.push(helloFruitCheckoutPath(preparedOrder.uuid));
    } catch (cause: unknown) {
      logDemo("prepare_order.error", "Prepare order failed in the browser.", {
        error: cause instanceof Error ? cause.message : String(cause),
        elapsedMs: Date.now() - startedAt,
      });
      setStatus("failed");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function startOver() {
    logDemo("app.reset", "Resetting the demo state.", {
      hadOrder: order !== undefined,
    });
    forgetHelloFruitOrder(order?.uuid);
    setCart({});
    setOrder(undefined);
    setPurchasedFruit(undefined);
    setStickerModalOpen(false);
    resetCheckoutResume();
    setStatus("idle");
    setError("");
    router.push("/");
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
      as="section"
      className="checkout w-full max-w-5xl grid gap-3"
      themeToggle
      topbarClassName="topbar w-full max-w-5xl flex justify-end"
    >
      <div className="flex gap-3 items-center">
        {selectedFruit === undefined ? null : (
          <img className="w-16 aspect-square" src={`/stickers/${selectedFruit.id}.svg`} alt="" />
        )}
        <div className="min-w-0">
          <h1 className="text-2xl font-bold leading-tight">{product.name}</h1>
          <p className="text-base-content/70 text-sm">{product.description}</p>
        </div>
      </div>

      {order === undefined && resumeOrderId === undefined ? (
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
                <img className="w-full aspect-square" src={`/stickers/${fruit.id}.svg`} alt="" />
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
                    <span>
                      {item.fruit.name} ×{item.quantity}
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
                disabled={status === "creating"}
                onClick={createOrder}
                type="button"
              >
                {status === "creating"
                  ? helloFruitDemoLabels.creatingOrder
                  : helloFruitDemoLabels.createOrder}
              </button>
            </>
          )}
        </>
      ) : (
        <div className="grid gap-3">
          {order === undefined ? (
            <p className="text-base-content/70 text-sm">
              {resuming ? "Restoring checkout…" : "Loading order…"}
            </p>
          ) : (
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
                    {order.status === "paid" ? "Paid" : "Awaiting payment"}
                  </span>
                </div>
              ))}
              <div className="card-actions pt-1">
                <button className="btn btn-sm btn-soft" onClick={startOver} type="button">
                  Start over
                </button>
              </div>
            </section>
          )}
          {/* Self-contained: orderId restores summary after refresh; app router owns the URL. */}
          <Checkout
            className="demo-checkout"
            orderId={(order?.uuid ?? resumeOrderId) as string}
            routeOrderId={resumeOrderId}
            logger={logOpenReceive}
            onError={(cause) => {
              logDemo("checkout.error", "Checkout component reported an error.", {
                error: cause instanceof Error ? cause.message : String(cause),
              });
              setError(cause instanceof Error ? cause.message : String(cause));
            }}
            onSettled={onSettled}
            onState={onCheckoutState}
            onStartOver={startOver}
            onSummary={onSummary}
            onResumeMiss={onResumeMiss}
          />
        </div>
      )}

      {displayError === "" ? null : <p className="alert alert-error">{displayError}</p>}
      {purchasedFruit === undefined || !stickerModalOpen ? null : (
        <div className="modal modal-open">
          <section
            aria-labelledby="sticker-modal-title"
            aria-modal="true"
            className="modal-box"
            role="dialog"
          >
            <img
              className="w-full max-w-[180px] aspect-square mx-auto"
              src={`/stickers/${purchasedFruit.id}.svg`}
              alt=""
            />
            <h2 className="text-2xl font-bold" id="sticker-modal-title">
              You just got a sticker
            </h2>
            <p>{purchasedFruit.name} is ready.</p>
            <TransactionDetails state={settledCheckoutState} />
            <div className="modal-action">
              <a
                className="btn"
                download={`${purchasedFruit.id}-sticker.svg`}
                href={`/stickers/${purchasedFruit.id}.svg`}
              >
                Download sticker
              </a>
              <button
                className="btn btn-ghost"
                onClick={() => setStickerModalOpen(false)}
                type="button"
              >
                Close
              </button>
            </div>
          </section>
        </div>
      )}
    </ThemeScope>
  );
}

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
