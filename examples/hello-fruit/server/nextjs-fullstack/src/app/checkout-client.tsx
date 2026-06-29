"use client";

import type { Checkout as OpenReceiveCheckout } from "@openreceive/browser";
import {
  Checkout,
  ThemeScope
} from "@openreceive/react";
import {
  useCallback,
  useMemo,
  useRef,
  useState
} from "react";
import type {
  HelloFruit,
  HelloFruitProduct
} from "../server/shared-data.ts";
import {
  createHelloFruitBrowserLogger
} from "../../../../shared/demo-browser-logging.ts";
import {
  readHelloFruitCheckoutCurrencies
} from "../../../../shared/demo-currencies.ts";
import {
  formatHelloFruitBuyNowLabel,
  formatHelloFruitFiat,
  helloFruitDemoLabels
} from "../../../../shared/demo-formatting.ts";

const logOpenReceive = createHelloFruitBrowserLogger("nextjs-fullstack");
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

interface CreateOrderResponse {
  readonly order: DemoOrder;
  readonly checkout: OpenReceiveCheckout;
}

export default function CheckoutClient({
  product,
  fruits
}: CheckoutClientProps) {
  const [fruitId, setFruitId] = useState(fruits[1]?.id ?? fruits[0]?.id ?? "");
  const [currency, setCurrency] = useState("USD");
  const [cart, setCart] = useState<Record<string, number>>({});
  const [order, setOrder] = useState<DemoOrder | undefined>();
  const [checkout, setCheckout] = useState<OpenReceiveCheckout | undefined>();
  const [purchasedFruit, setPurchasedFruit] = useState<HelloFruit | undefined>();
  const [stickerModalOpen, setStickerModalOpen] = useState(false);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const completedCheckoutRef = useRef("");

  const selectedFruit = useMemo(
    () => fruits.find((fruit) => fruit.id === fruitId) ?? fruits[0],
    [fruitId, fruits]
  );
  const createCheckoutLabel =
    selectedFruit === undefined
      ? helloFruitDemoLabels.createOrder
      : currency === selectedFruit.fiat.currency
        ? formatHelloFruitBuyNowLabel(selectedFruit.fiat)
        : `Add to cart (${currency})`;
  const cartItems = fruits
    .map((fruit) => ({ fruit, quantity: cart[fruit.id] ?? 0 }))
    .filter((item) => item.quantity > 0);
  const cartQuantity = cartItems.reduce((total, item) => total + item.quantity, 0);

  const onSettled = useCallback(() => {
    if (checkout !== undefined && completedCheckoutRef.current !== checkout.order_id) {
      completedCheckoutRef.current = checkout.order_id;
      setOrder((current) => current === undefined
        ? current
        : { ...current, status: "paid" });
      setStickerModalOpen(true);
    }
  }, [checkout]);

  function addSelectedFruitToCart() {
    if (selectedFruit === undefined) return;
    setCart((current) => ({
      ...current,
      [selectedFruit.id]: Math.min((current[selectedFruit.id] ?? 0) + 1, 9)
    }));
  }

  function removeFruitFromCart(fruitIdToRemove: string) {
    setCart((current) => {
      const next = { ...current };
      delete next[fruitIdToRemove];
      return next;
    });
  }

  async function createOrder() {
    if (cartItems.length === 0) return;
    const orderId = globalThis.crypto?.randomUUID?.() ??
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    setStatus("creating");
    setError("");
    setStickerModalOpen(false);
    completedCheckoutRef.current = "";

    try {
      const response = await fetch("/create_order", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          idempotency_key: orderId,
          currency,
          cart: cartItems.map((item) => ({
            product_id: item.fruit.id,
            quantity: item.quantity
          }))
        })
      });
      const body = await response.json() as unknown;
      if (!response.ok || !isCreateOrderResponse(body)) {
        throw new Error(readErrorMessage(body) ?? helloFruitDemoLabels.createOrderError);
      }

      setOrder(body.order);
      setCheckout(body.checkout);
      setPurchasedFruit(cartItems[0]?.fruit);
      setStatus("invoice_created");
    } catch (cause: unknown) {
      setStatus("failed");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function startOver() {
    setCart({});
    setOrder(undefined);
    setCheckout(undefined);
    setPurchasedFruit(undefined);
    setStickerModalOpen(false);
    setStatus("idle");
    setError("");
    completedCheckoutRef.current = "";
  }

  return (
    <ThemeScope
      as="section"
      className="checkout"
      themeToggle
      topbarClassName="topbar"
    >
      <div className="product">
        {selectedFruit === undefined ? null : (
          <img src={`/stickers/${selectedFruit.id}.svg`} alt="" />
        )}
        <div>
          <h1>{product.name}</h1>
          <p>{product.description}</p>
        </div>
      </div>

      <label className="currency-picker">
        <span>Currency</span>
        <select
          value={currency}
          onChange={(event) => setCurrency(event.target.value)}
        >
          {currencyOptions.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      </label>

      <div className="fruit-grid">
        {fruits.map((fruit) => (
          <button
            className={fruit.id === fruitId ? "selected" : ""}
            key={fruit.id}
            onClick={() => setFruitId(fruit.id)}
            type="button"
          >
            <img src={`/stickers/${fruit.id}.svg`} alt="" />
            <span>{fruit.name}</span>
            <small>{formatHelloFruitFiat(fruit.fiat)}</small>
          </button>
        ))}
      </div>

      <button
        className="primary"
        onClick={addSelectedFruitToCart}
        type="button"
      >
        {createCheckoutLabel}
      </button>

      {checkout !== undefined || cartItems.length === 0 ? null : (
        <section className="cart" aria-label="Cart">
          <div className="cart-heading">
            <strong>Cart</strong>
            <span>{cartQuantity} item{cartQuantity === 1 ? "" : "s"}</span>
          </div>
          {cartItems.map((item) => (
            <div className="cart-row" key={item.fruit.id}>
              <span>{item.fruit.name}</span>
              <span>x{item.quantity}</span>
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

      {checkout !== undefined || order === undefined ? null : (
        <section className="cart" aria-label="Order">
          <div className="cart-heading">
            <strong>Order</strong>
            <span>{formatHelloFruitFiat(order.total_amount)}</span>
          </div>
          {order.items.map((item) => (
            <div className="cart-row" key={item.product_id}>
              <span>{item.name}</span>
              <span>x{item.quantity}</span>
              <span>{order.status === "paid" ? "Paid" : "Pending"}</span>
            </div>
          ))}
        </section>
      )}

      {checkout === undefined ? (
        <button
          className="primary"
          disabled={status === "creating" || cartItems.length === 0}
          onClick={createOrder}
          type="button"
        >
          {status === "creating" ? helloFruitDemoLabels.creatingOrder : helloFruitDemoLabels.createOrder}
        </button>
      ) : (
        <button
          className="secondary"
          onClick={startOver}
          type="button"
        >
          Start over
        </button>
      )}

      {checkout === undefined ? null : (
        <div className="invoice">
          {order === undefined ? null : (
            <section className="cart" aria-label="Order">
              <div className="cart-heading">
                <strong>Order</strong>
                <span>{formatHelloFruitFiat(order.total_amount)}</span>
              </div>
              {order.items.map((item) => (
                <div className="cart-row" key={item.product_id}>
                  <span>{item.name}</span>
                  <span>x{item.quantity}</span>
                  <span>{order.status === "paid" ? "Paid" : "Pending"}</span>
                </div>
              ))}
            </section>
          )}
          <Checkout
            checkout={checkout}
            statusUrl="/order_status"
            logger={logOpenReceive}
            onError={(cause) => {
              setError(cause instanceof Error ? cause.message : String(cause));
            }}
            onSettled={onSettled}
            onStartOver={startOver}
            classNames={{
              root: "react-checkout",
              actions: "actions",
              invoice: "invoice-text"
            }}
          />
        </div>
      )}

      {error === "" ? null : <p className="error">{error}</p>}
      {purchasedFruit === undefined || !stickerModalOpen ? null : (
        <div className="sticker-modal-backdrop">
          <section
            aria-labelledby="sticker-modal-title"
            aria-modal="true"
            className="sticker-modal"
            role="dialog"
          >
            <img src={`/stickers/${purchasedFruit.id}.svg`} alt="" />
            <h2 id="sticker-modal-title">You just got a sticker</h2>
            <p>{purchasedFruit.name} is ready.</p>
            <div className="sticker-modal-actions">
              <a
                className="primary sticker-download"
                download={`${purchasedFruit.id}-sticker.svg`}
                href={`/stickers/${purchasedFruit.id}.svg`}
              >
                Download sticker
              </a>
              <button
                className="secondary"
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

function isCreateOrderResponse(value: unknown): value is CreateOrderResponse {
  return typeof value === "object" &&
    value !== null &&
    "order" in value &&
    "checkout" in value;
}

function readErrorMessage(value: unknown): string | undefined {
  return typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
    ? value.message
    : undefined;
}
