"use client";

import {
  type Invoice,
} from "@openreceive/browser";
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
  formatHelloFruitBuyNowLabel,
  formatHelloFruitFiat,
  helloFruitDemoLabels
} from "../../../../shared/demo-formatting.ts";

const logOpenReceive = createHelloFruitBrowserLogger("nextjs-fullstack");

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
  readonly totalFiat: {
    readonly currency: string;
    readonly value: string;
  };
}

interface CreateOrderResponse {
  readonly order: DemoOrder;
  readonly invoice: Invoice;
}

export default function CheckoutClient({
  product,
  fruits
}: CheckoutClientProps) {
  const [fruitId, setFruitId] = useState(fruits[1]?.id ?? fruits[0]?.id ?? "");
  const [cart, setCart] = useState<Record<string, number>>({});
  const [order, setOrder] = useState<DemoOrder | undefined>();
  const [checkout, setCheckout] = useState<Invoice | undefined>();
  const [purchasedFruit, setPurchasedFruit] = useState<HelloFruit | undefined>();
  const [stickerModalOpen, setStickerModalOpen] = useState(false);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const completedInvoiceRef = useRef("");

  const selectedFruit = useMemo(
    () => fruits.find((fruit) => fruit.id === fruitId) ?? fruits[0],
    [fruitId, fruits]
  );
  const createInvoiceLabel =
    selectedFruit === undefined
      ? helloFruitDemoLabels.createOrder
      : formatHelloFruitBuyNowLabel(selectedFruit.fiat);
  const cartItems = fruits
    .map((fruit) => ({ fruit, quantity: cart[fruit.id] ?? 0 }))
    .filter((item) => item.quantity > 0);
  const cartQuantity = cartItems.reduce((total, item) => total + item.quantity, 0);

  const onPaid = useCallback(() => {
    if (checkout !== undefined && completedInvoiceRef.current !== checkout.invoice_id) {
      completedInvoiceRef.current = checkout.invoice_id;
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
    const orderUuid = globalThis.crypto?.randomUUID?.() ??
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    setStatus("creating");
    setError("");
    setStickerModalOpen(false);
    completedInvoiceRef.current = "";

    try {
      const response = await fetch("/create_order", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          idempotency_key: orderUuid,
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
      setCheckout(body.invoice);
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
    completedInvoiceRef.current = "";
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
        {createInvoiceLabel}
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
            <span>{formatHelloFruitFiat(order.totalFiat)}</span>
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
                <span>{formatHelloFruitFiat(order.totalFiat)}</span>
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
            invoice={checkout}
            lookupUrl="/order_status"
            logger={logOpenReceive}
            onError={(cause) => {
              setError(cause instanceof Error ? cause.message : String(cause));
            }}
            onPaid={onPaid}
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
    "invoice" in value;
}

function readErrorMessage(value: unknown): string | undefined {
  return typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
    ? value.message
    : undefined;
}
