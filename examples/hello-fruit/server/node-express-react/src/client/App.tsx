import React, { useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  Invoice
} from "@openreceive/browser";
import {
  createInvoice as requestInvoice
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
  createHelloFruitInvoiceDescription,
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

function App(): React.ReactElement {
  const [fruitId, setFruitId] = useState(initialFruitId);
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [purchasedFruit, setPurchasedFruit] = useState<Fruit | null>(null);
  const [stickerModalOpen, setStickerModalOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const completedInvoiceRef = useRef("");
  const selectedFruit = fruits.find((fruit) => fruit.id === fruitId) ?? fruits[0];
  const createInvoiceLabel =
    selectedFruit === undefined
      ? helloFruitDemoLabels.createInvoice
      : formatHelloFruitBuyNowLabel(selectedFruit.fiat);

  const onPaid = useCallback(() => {
    if (invoice !== null && completedInvoiceRef.current !== invoice.invoice_id) {
      completedInvoiceRef.current = invoice.invoice_id;
      setStickerModalOpen(true);
    }
  }, [invoice]);

  async function createInvoice() {
    if (selectedFruit === undefined) return;
    const idempotencyKey = globalThis.crypto?.randomUUID?.() ??
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    setCreating(true);
    setError("");
    setStickerModalOpen(false);
    completedInvoiceRef.current = "";

    try {
      const body = await requestInvoice({
        orderUuid: `hello-fruit-${selectedFruit.id}-${idempotencyKey}`,
        fiat: selectedFruit.fiat,
        optionalInvoiceDescription: createHelloFruitInvoiceDescription(selectedFruit.name),
        expiry: product.invoice_expiry_seconds,
        fetch
      });

      setInvoice(body);
      setPurchasedFruit(selectedFruit);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  }

  function startOver() {
    setFruitId(initialFruitId);
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
              disabled={creating}
              onClick={createInvoice}
              type="button"
            >
              {creating ? helloFruitDemoLabels.creatingInvoice : createInvoiceLabel}
            </button>
          </>
        ) : (
          <button
            className="secondary reset-demo"
            onClick={startOver}
            type="button"
          >
            Start over
          </button>
        )}

        {invoice === null ? null : (
          <Checkout
            className="demo-checkout"
            invoice={invoice}
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
