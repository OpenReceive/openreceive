import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  OpenReceiveCheckoutSnapshot
} from "@openreceive/browser";
import {
  OpenReceiveCheckout,
  OpenReceiveThemeScope
} from "@openreceive/react";
import "@openreceive/react/styles.css";
import {
  createHelloFruitBrowserLogger
} from "../../../../shared/demo-browser-logging.ts";
import {
  createHelloFruitInvoiceDescription,
  formatHelloFruitFiat,
  helloFruitDemoLabels
} from "../../../../shared/demo-formatting.ts";
import fruitsData from "../../../../shared/fruits.json";
import product from "../../../../shared/product.json";
import "./styles.css";

const logOpenReceive = createHelloFruitBrowserLogger("node-express-react");
const fruits = fruitsData.fruits;

function App(): React.ReactElement {
  const [fruitId, setFruitId] = useState(fruits[1]?.id ?? fruits[0]?.id ?? "");
  const [invoice, setInvoice] = useState<OpenReceiveCheckoutSnapshot | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const selectedFruit = fruits.find((fruit) => fruit.id === fruitId) ?? fruits[0];

  async function createInvoice() {
    if (selectedFruit === undefined) return;

    setCreating(true);
    setError("");

    try {
      const response = await fetch("/openreceive/v1/invoices", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `hello-fruit-${selectedFruit.id}`
        },
        body: JSON.stringify({
          fiat: selectedFruit.fiat,
          description: createHelloFruitInvoiceDescription(selectedFruit.name),
          expiry: product.invoice_expiry_seconds,
          metadata: {
            product_id: product.product_id,
            fruit: selectedFruit.id,
            fiat: selectedFruit.fiat
          }
        })
      });
      const body = await response.json();

      if (!response.ok) {
        setError(body.message ?? helloFruitDemoLabels.createInvoiceError);
        return;
      }

      setInvoice(body);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  }

  return (
    <OpenReceiveThemeScope
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
          {creating ? helloFruitDemoLabels.creatingInvoice : helloFruitDemoLabels.createInvoice}
        </button>

        {invoice === null ? null : (
          <OpenReceiveCheckout
            amount_msats={invoice.amount_msats}
            checkout={invoice.checkout}
            className="demo-checkout"
            invoice={invoice.invoice}
            invoice_id={invoice.invoice_id}
            logger={logOpenReceive}
            lookupUrl="/openreceive/v1/invoices/lookup"
            onError={(cause) => {
              setError(cause instanceof Error ? cause.message : String(cause));
            }}
            payment_hash={invoice.payment_hash}
            transaction_state={invoice.transaction_state}
            workflow_state={invoice.workflow_state}
            expires_at={invoice.expires_at}
          />
        )}

        {error === "" ? null : <p className="error">{error}</p>}
      </section>
    </OpenReceiveThemeScope>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
