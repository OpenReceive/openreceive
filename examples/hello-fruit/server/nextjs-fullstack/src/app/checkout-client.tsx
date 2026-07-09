"use client";

import { Checkout, ThemeScope } from "@openreceive/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HelloFruit, HelloFruitProduct } from "../server/shared-data.ts";
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

const logOpenReceive = createHelloFruitBrowserLogger("nextjs-fullstack");
const logDemo = createHelloFruitDemoBrowserConsoleLogger("nextjs-fullstack");
const currencyOptions = readHelloFruitCheckoutCurrencies();

interface CheckoutClientProps {
  readonly product: HelloFruitProduct;
  readonly fruits: readonly HelloFruit[];
}

interface DemoOrder {
  readonly uuid: string;
  readonly status: "pending_payment" | "paid";
  readonly items: readonly {
    readonly product_id: string;
    readonly name: string;
    readonly quantity: number;
  }[];
  readonly total_amount: {
    readonly currency: string;
    readonly value: string;
  };
}

interface PrepareOrderResponse {
  readonly order: DemoOrder;
}

export default function CheckoutClient({ product, fruits }: CheckoutClientProps) {
  const [fruitId, setFruitId] = useState(fruits[1]?.id ?? fruits[0]?.id ?? "");
  const [currency, setCurrency] = useState("USD");
  const [rates, setRates] = useState<HelloFruitBtcFiatRates | undefined>();
  const [cart, setCart] = useState<Record<string, number>>({});
  const [order, setOrder] = useState<DemoOrder | undefined>();
  const [purchasedFruit, setPurchasedFruit] = useState<HelloFruit | undefined>();
  const [stickerModalOpen, setStickerModalOpen] = useState(false);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const completedCheckoutRef = useRef("");

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
    });
  }, [currency, fruitId, fruits.length]);

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

  const onSettled = useCallback(() => {
    if (order !== undefined && completedCheckoutRef.current !== order.uuid) {
      logDemo("checkout.settled", "Checkout settled callback received.", {
        orderId: order.uuid,
        purchasedFruitId: purchasedFruit?.id,
      });
      completedCheckoutRef.current = order.uuid;
      setOrder((current) => (current === undefined ? current : { ...current, status: "paid" }));
      setStickerModalOpen(true);
    }
  }, [order, purchasedFruit?.id]);

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
    completedCheckoutRef.current = "";

    try {
      logDemo("prepare_order.request", "Posting prepare order request.", {
        currency,
        cartLineCount: cartItems.length,
        cartQuantity,
        productIds: cartItems.map((item) => item.fruit.id),
      });
      // App route: build + persist the order. The <Checkout orderId> component below creates the
      // checkout against the mounted /openreceive/checkouts route and drives it end to end.
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
      setPurchasedFruit(cartItems[0]?.fruit);
      setStatus("invoice_created");
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
    setCart({});
    setOrder(undefined);
    setPurchasedFruit(undefined);
    setStickerModalOpen(false);
    setStatus("idle");
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
      as="section"
      className="checkout w-full max-w-5xl grid gap-4"
      themeToggle
      topbarClassName="topbar w-full max-w-5xl flex justify-end"
    >
      <div className="flex gap-4 items-center">
        {selectedFruit === undefined ? null : (
          <img className="w-24 aspect-square" src={`/stickers/${selectedFruit.id}.svg`} alt="" />
        )}
        <div>
          <h1 className="text-3xl font-bold">{product.name}</h1>
          <p className="text-base-content/70">{product.description}</p>
        </div>
      </div>

      <label className="form-control w-full">
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

      {order !== undefined || cartItems.length === 0 ? null : (
        <section className="card card-border bg-base-100 p-4 grid gap-2" aria-label="Cart">
          <div className="flex justify-between items-center">
            <strong>Cart</strong>
            <span>
              {cartQuantity} item{cartQuantity === 1 ? "" : "s"}
            </span>
          </div>
          {cartItems.map((item) => (
            <div className="flex justify-between items-center gap-2" key={item.fruit.id}>
              <span>{item.fruit.name}</span>
              <span>x{item.quantity}</span>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => removeFruitFromCart(item.fruit.id)}
                type="button"
              >
                Remove
              </button>
            </div>
          ))}
        </section>
      )}

      {order === undefined ? (
        <button
          className="btn"
          disabled={status === "creating" || cartItems.length === 0}
          onClick={createOrder}
          type="button"
        >
          {status === "creating"
            ? helloFruitDemoLabels.creatingOrder
            : helloFruitDemoLabels.createOrder}
        </button>
      ) : (
        <button className="btn btn-ghost" onClick={startOver} type="button">
          Start over
        </button>
      )}

      {order === undefined ? null : (
        <div className="grid gap-4">
          <section className="card card-border bg-base-100 p-4 grid gap-2" aria-label="Order">
            <div className="flex justify-between items-center">
              <strong>Order</strong>
              <span>{formatHelloFruitFiat(order.total_amount)}</span>
            </div>
            {order.items.map((item) => (
              <div className="flex justify-between items-center gap-2" key={item.product_id}>
                <span>{item.name}</span>
                <span>x{item.quantity}</span>
                <span>{order.status === "paid" ? "Paid" : "Pending"}</span>
              </div>
            ))}
          </section>
          {/* Self-contained: given just orderId (prefix defaults to /openreceive) it creates the
              checkout, polls, and drives swaps itself — the app writes no OpenReceive routes. */}
          <Checkout
            orderId={order.uuid}
            logger={logOpenReceive}
            onError={(cause) => {
              logDemo("checkout.error", "Checkout component reported an error.", {
                error: cause instanceof Error ? cause.message : String(cause),
              });
              setError(cause instanceof Error ? cause.message : String(cause));
            }}
            onSettled={onSettled}
            onStartOver={startOver}
            classNames={{
              root: "demo-checkout grid gap-4 md:grid-cols-[256px_minmax(0,1fr)] md:items-start",
              actions: "flex flex-wrap gap-2",
              invoice: "textarea textarea-bordered w-full min-h-[86px]",
            }}
          />
        </div>
      )}

      {error === "" ? null : <p className="alert alert-error">{error}</p>}
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
