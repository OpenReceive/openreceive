"use client";

import {
  type OpenReceiveCheckoutSnapshot,
} from "@openreceive/browser";
import {
  OpenReceiveCheckout,
  OpenReceiveThemeScope
} from "@openreceive/react";
import {
  useMemo,
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
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");

  const selectedFruit = useMemo(
    () => fruits.find((fruit) => fruit.id === fruitId) ?? fruits[0],
    [fruitId, fruits]
  );

  async function createInvoice() {
    if (selectedFruit === undefined) return;

    setStatus("creating");
    setError("");

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
      setStatus("invoice_created");
    } catch (cause: unknown) {
      setStatus("failed");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
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
        {status === "creating" ? helloFruitDemoLabels.creatingInvoice : helloFruitDemoLabels.createInvoice}
      </button>

      {checkout === undefined ? null : (
        <div className="invoice">
          <OpenReceiveCheckout
            invoice_id={checkout.invoice_id}
            invoice={checkout.invoice}
            payment_hash={checkout.payment_hash}
            amount_msats={checkout.amount_msats}
            transaction_state={checkout.transaction_state}
            workflow_state={checkout.workflow_state}
            expires_at={checkout.expires_at}
            checkout={checkout.checkout}
            logger={logOpenReceive}
            lookupUrl="/openreceive/v1/invoices/lookup"
            onError={(cause) => {
              setError(cause instanceof Error ? cause.message : String(cause));
            }}
            classNames={{
              root: "react-checkout",
              actions: "actions",
              invoice: "invoice-text"
            }}
          />
        </div>
      )}

      {error === "" ? null : <p className="error">{error}</p>}
    </OpenReceiveThemeScope>
  );
}
