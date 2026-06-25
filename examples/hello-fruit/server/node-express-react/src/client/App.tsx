import React, { useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  Invoice
} from "@openreceive/browser";
import {
  Checkout,
  ThemeScope
} from "@openreceive/react";
import "@openreceive/react/styles.css";
import {
  createHelloFruitBrowserLogger
} from "../../../../shared/demo-browser-logging.ts";
import {
  formatHelloFruitBuyNowLabel,
  formatHelloFruitFiat,
  helloFruitDemoLabels
} from "../../../../shared/demo-formatting.ts";
import fruitsData from "../../../../shared/fruits.json";
import product from "../../../../shared/product.json";
import "./styles.css";

const logOpenReceive = createHelloFruitBrowserLogger("node-express-react");
const fruits = fruitsData.fruits;
type Fruit = (typeof fruits)[number];
const initialFruitId = fruits[1]?.id ?? fruits[0]?.id ?? "";

interface DemoOrder {
  readonly uuid: string;
  readonly status: "pending_payment" | "paid";
  readonly items: readonly {
    readonly product_id: string;
    readonly name: string;
    readonly sticker: string;
    readonly quantity: number;
  }[];
  readonly total_fiat: {
    readonly currency: string;
    readonly value: string;
  };
}

interface CreateOrderResponse {
  readonly order: DemoOrder;
  readonly invoice: Invoice;
}

function App(): React.ReactElement {
  const [fruitId, setFruitId] = useState(initialFruitId);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [order, setOrder] = useState<DemoOrder | null>(null);
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [purchasedFruit, setPurchasedFruit] = useState<Fruit | null>(null);
  const [stickerModalOpen, setStickerModalOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const completedInvoiceRef = useRef("");
  const selectedFruit = fruits.find((fruit) => fruit.id === fruitId) ?? fruits[0];
  const createInvoiceLabel =
    selectedFruit === undefined
      ? helloFruitDemoLabels.createOrder
      : formatHelloFruitBuyNowLabel(selectedFruit.fiat);
  const cartItems = fruits
    .map((fruit) => ({ fruit, quantity: cart[fruit.id] ?? 0 }))
    .filter((item) => item.quantity > 0);
  const cartQuantity = cartItems.reduce((total, item) => total + item.quantity, 0);

  const onPaid = useCallback(() => {
    if (invoice !== null && completedInvoiceRef.current !== invoice.invoice_id) {
      completedInvoiceRef.current = invoice.invoice_id;
      setOrder((current) => current === null
        ? current
        : { ...current, status: "paid" });
      setStickerModalOpen(true);
    }
  }, [invoice]);

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
    const idempotencyKey = globalThis.crypto?.randomUUID?.() ??
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    setCreating(true);
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
          idempotency_key: idempotencyKey,
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
      setInvoice(body.invoice);
      setPurchasedFruit(cartItems[0]?.fruit ?? null);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  }

  function startOver() {
    setFruitId(initialFruitId);
    setCart({});
    setOrder(null);
    setInvoice(null);
    setPurchasedFruit(null);
    setStickerModalOpen(false);
    setCreating(false);
    setError("");
    completedInvoiceRef.current = "";
  }

  return (
    <ThemeScope
      as="main"
      className="page"
      themeToggle
      topbarClassName="topbar"
    >
      <section className="checkout">
        <div className="product">
          <img src={`/${selectedFruit?.sticker}`} alt="" />
          <div>
            <h1>{product.name}</h1>
            <p>{product.description}</p>
          </div>
        </div>

        {invoice === null ? (
          <>
            <div className="fruit-grid">
              {fruits.map((fruit) => (
                <button
                  className={fruit.id === fruitId ? "selected" : ""}
                  key={fruit.id}
                  onClick={() => setFruitId(fruit.id)}
                  type="button"
                >
                  <img src={`/${fruit.sticker}`} alt="" />
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

            {cartItems.length === 0 ? null : (
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
                  <span>{formatHelloFruitFiat(order.total_fiat)}</span>
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

        {invoice === null ? null : (
          <Checkout
            className="demo-checkout"
            invoice={invoice}
            lookupUrl="/order_status"
            logger={logOpenReceive}
            onError={(cause) => {
              setError(cause instanceof Error ? cause.message : String(cause));
            }}
            onPaid={onPaid}
            onStartOver={startOver}
          />
        )}

        {error === "" ? null : <p className="error">{error}</p>}
      </section>
      {purchasedFruit === null || !stickerModalOpen ? null : (
        <div className="sticker-modal-backdrop">
          <section
            aria-labelledby="sticker-modal-title"
            aria-modal="true"
            className="sticker-modal"
            role="dialog"
          >
            <img src={`/${purchasedFruit.sticker}`} alt="" />
            <h2 id="sticker-modal-title">You just got a sticker</h2>
            <p>{purchasedFruit.name} is ready.</p>
            <div className="sticker-modal-actions">
              <a
                className="primary sticker-download"
                download={`${purchasedFruit.id}-sticker.svg`}
                href={`/${purchasedFruit.sticker}`}
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

createRoot(document.getElementById("root") as HTMLElement).render(<App />);

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
