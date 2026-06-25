"use client";

import {
  createInvoice as requestInvoice,
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
  createHelloFruitInvoiceDescription,
  formatHelloFruitBuyNowLabel,
  formatHelloFruitFiat,
  helloFruitDemoLabels
} from "../../../../shared/demo-formatting.ts";

const logOpenReceive = createHelloFruitBrowserLogger("nextjs-fullstack");

interface CheckoutClientProps {
  readonly product: HelloFruitProduct;
  readonly fruits: readonly HelloFruit[];
}

export default function CheckoutClient({
  product,
  fruits
}: CheckoutClientProps) {
  const [fruitId, setFruitId] = useState(fruits[1]?.id ?? fruits[0]?.id ?? "");
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
      ? helloFruitDemoLabels.createInvoice
      : formatHelloFruitBuyNowLabel(selectedFruit.fiat);

  const onPaid = useCallback(() => {
    if (checkout !== undefined && completedInvoiceRef.current !== checkout.invoice_id) {
      completedInvoiceRef.current = checkout.invoice_id;
      setStickerModalOpen(true);
    }
  }, [checkout]);

  async function createInvoice() {
    if (selectedFruit === undefined) return;
    const orderUuid = globalThis.crypto?.randomUUID?.() ??
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    setStatus("creating");
    setError("");
    setStickerModalOpen(false);
    completedInvoiceRef.current = "";

    try {
      const body = await requestInvoice({
        orderUuid: `hello-fruit-nextjs-${selectedFruit.id}-${orderUuid}`,
        fiat: selectedFruit.fiat,
        optionalInvoiceDescription: createHelloFruitInvoiceDescription(selectedFruit.name, {
          demoName: "Next.js"
        }),
        expiry: product.invoice_expiry_seconds,
        fetch
      });

      setCheckout(body);
      setPurchasedFruit(selectedFruit);
      setStatus("invoice_created");
    } catch (cause: unknown) {
      setStatus("failed");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function startOver() {
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
        disabled={status === "creating"}
        onClick={createInvoice}
        type="button"
      >
        {status === "creating" ? helloFruitDemoLabels.creatingInvoice : createInvoiceLabel}
      </button>

      {checkout === undefined ? null : (
        <div className="invoice">
          <Checkout
            invoice={checkout}
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
