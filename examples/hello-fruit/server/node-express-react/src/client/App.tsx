import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  copyInvoice,
  createQrSvg,
  openWallet
} from "@openreceive/browser";
import fruitsData from "../../../../shared/fruits.json";
import product from "../../../../shared/product.json";
import "./styles.css";

interface InvoiceResponse {
  invoice_id: string;
  invoice: string;
  payment_hash: string;
  amount_msats: number;
  transaction_state: string;
  workflow_state: string;
  expires_at: number;
  checkout: {
    events_url: string;
  };
}

function App() {
  const fruits = fruitsData.fruits;
  const [fruitId, setFruitId] = useState(fruits[1]?.id ?? fruits[0]?.id);
  const [invoice, setInvoice] = useState<InvoiceResponse | null>(null);
  const [qrSvg, setQrSvg] = useState("");
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");

  const selectedFruit = useMemo(
    () => fruits.find((fruit) => fruit.id === fruitId) ?? fruits[0],
    [fruitId, fruits]
  );

  useEffect(() => {
    if (invoice === null) return;

    createQrSvg(invoice.invoice)
      .then(setQrSvg)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });

    const events = new EventSource(invoice.checkout.events_url);
    events.addEventListener("invoice.settled", () => {
      setStatus("settled");
      events.close();
    });
    events.addEventListener("invoice.expired", () => {
      setStatus("expired");
      events.close();
    });
    events.onerror = () => {
      events.close();
    };

    return () => events.close();
  }, [invoice]);

  async function createInvoice() {
    if (selectedFruit === undefined) return;

    setStatus("creating");
    setError("");

    const response = await fetch("/openreceive/v1/invoices", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `hello-fruit-${selectedFruit.id}`
      },
      body: JSON.stringify({
        amount_msats: product.amount_msats,
        description: `Fruit sticker from OpenReceive demo: ${selectedFruit.name}`,
        expiry: product.invoice_expiry_seconds,
        metadata: {
          product_id: product.product_id,
          fruit: selectedFruit.id
        }
      })
    });

    const body = await response.json();
    if (!response.ok) {
      setStatus("failed");
      setError(body.message ?? "Could not create invoice.");
      return;
    }

    setInvoice(body);
    setStatus("invoice_created");
  }

  return (
    <main className="page">
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
            </button>
          ))}
        </div>

        <button className="primary" onClick={createInvoice} type="button">
          Create invoice
        </button>

        {invoice && (
          <div className="invoice">
            <div
              className="qr"
              dangerouslySetInnerHTML={{ __html: qrSvg }}
            />
            <dl>
              <div>
                <dt>Invoice</dt>
                <dd>{invoice.invoice_id}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{status}</dd>
              </div>
            </dl>
            <div className="actions">
              <button
                onClick={() => copyInvoice({ invoice: invoice.invoice })}
                type="button"
              >
                Copy invoice
              </button>
              <button
                onClick={() => openWallet({ invoice: invoice.invoice })}
                type="button"
              >
                Open wallet
              </button>
            </div>
          </div>
        )}

        {error && <p className="error">{error}</p>}
      </section>
    </main>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
