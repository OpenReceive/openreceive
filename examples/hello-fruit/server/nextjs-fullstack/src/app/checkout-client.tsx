"use client";

import * as QRCode from "qrcode";
import {
  type OpenReceiveCheckoutState,
  type OpenReceiveCheckoutSnapshot,
} from "@openreceive/browser";
import {
  OpenReceiveCheckout,
  OpenReceiveThemeScope
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
  const [checkout, setCheckout] = useState<OpenReceiveCheckoutSnapshot | undefined>();
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

  const onCheckoutState = useCallback((state: OpenReceiveCheckoutState) => {
    if (
      state.workflow_state === "settlement_action_completed" &&
      completedInvoiceRef.current !== state.invoice_id
    ) {
      completedInvoiceRef.current = state.invoice_id;
      setStickerModalOpen(true);
    }
  }, []);

  async function createInvoice() {
    if (selectedFruit === undefined) return;

    setStatus("creating");
    setError("");
    setStickerModalOpen(false);
    completedInvoiceRef.current = "";

    try {
      const response = await fetch("/openreceive/v1/invoices", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `hello-fruit-nextjs-${selectedFruit.id}`
        },
        body: JSON.stringify({
          fiat: selectedFruit.fiat,
          description: createHelloFruitInvoiceDescription(selectedFruit.name, {
            demoName: "Next.js"
          }),
          expiry: product.invoice_expiry_seconds,
          metadata: {
            product_id: product.product_id,
            fruit: selectedFruit.id,
            fiat: selectedFruit.fiat,
            framework: "nextjs"
          }
        })
      });
      const body = await response.json();

      if (!response.ok) {
        setStatus("failed");
        setError(body.message ?? helloFruitDemoLabels.createInvoiceError);
        return;
      }

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
    <OpenReceiveThemeScope
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
          <OpenReceiveCheckout
            invoice_id={checkout.invoice_id}
            invoice={checkout.invoice}
            payment_hash={checkout.payment_hash}
            amount_msats={checkout.amount_msats}
            fiat_quote={checkout.fiat_quote}
            transaction_state={checkout.transaction_state}
            workflow_state={checkout.workflow_state}
            expires_at={checkout.expires_at}
            checkout={checkout.checkout}
            logger={logOpenReceive}
            lookupUrl="/openreceive/v1/invoices/lookup"
            qrEncoder={QRCode}
            onError={(cause) => {
              setError(cause instanceof Error ? cause.message : String(cause));
            }}
            onState={onCheckoutState}
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
    </OpenReceiveThemeScope>
  );
}
