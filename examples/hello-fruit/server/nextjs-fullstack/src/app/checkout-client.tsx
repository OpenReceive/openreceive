"use client";

import {
  applyOpenReceiveInvoiceEvent,
  createOpenReceiveCheckoutState,
  parseOpenReceiveInvoiceEvent,
  type OpenReceiveCheckoutState
} from "@openreceive/browser";
import {
  OpenReceiveCheckout
} from "@openreceive/react";
import {
  useEffect,
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
  const [checkout, setCheckout] = useState<OpenReceiveCheckoutState | undefined>();
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");

  const selectedFruit = useMemo(
    () => fruits.find((fruit) => fruit.id === fruitId) ?? fruits[0],
    [fruitId, fruits]
  );

  useEffect(() => {
    if (checkout === undefined) return;
    let stopped = false;
    let events: EventSource | undefined;

    if (checkout.events_url !== undefined) {
      events = new EventSource(checkout.events_url);
      for (const eventName of [
        "invoice.verifying",
        "invoice.settled",
        "invoice.expired",
        "invoice.failed",
        "invoice.fulfilled"
      ]) {
        events.addEventListener(eventName, (event) => {
          setCheckout((current) =>
            current === undefined
              ? current
              : applyOpenReceiveInvoiceEvent(
                current,
                parseOpenReceiveInvoiceEvent((event as MessageEvent).data),
                { eventName, logger: logOpenReceive }
              )
          );
        });
      }
      events.onerror = () => events?.close();
    }

    const pollTimer = window.setInterval(async () => {
      if (stopped) return;

      try {
        const response = await fetch("/openreceive/v1/invoices/lookup", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            payment_hash: checkout.payment_hash
          })
        });
        const body = await response.json();

        if (!response.ok) {
          setError(body.message ?? "Could not look up invoice.");
          return;
        }

        setCheckout(createOpenReceiveCheckoutState(body, {
          logger: logOpenReceive,
          now: Math.floor(Date.now() / 1000)
        }));
        if (
          body.transaction_state === "settled" ||
          body.transaction_state === "expired" ||
          body.transaction_state === "failed"
        ) {
          stopped = true;
          events?.close();
          window.clearInterval(pollTimer);
        }
      } catch (cause: unknown) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }, 3000);

    return () => {
      stopped = true;
      events?.close();
      window.clearInterval(pollTimer);
    };
  }, [checkout?.invoice_id, checkout?.payment_hash, checkout?.events_url]);

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
          amount_msats: product.amount_msats,
          description: `Fruit sticker from OpenReceive Next.js demo: ${selectedFruit.name}`,
          expiry: product.invoice_expiry_seconds,
          metadata: {
            product_id: product.product_id,
            fruit: selectedFruit.id,
            framework: "nextjs"
          }
        })
      });
      const body = await response.json();

      if (!response.ok) {
        setStatus("failed");
        setError(body.message ?? "Could not create invoice.");
        return;
      }

      setCheckout(createOpenReceiveCheckoutState(body, {
        logger: logOpenReceive,
        now: Math.floor(Date.now() / 1000)
      }));
      setStatus("invoice_created");
    } catch (cause: unknown) {
      setStatus("failed");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const displayStatus = checkout?.phase ?? status;

  return (
    <section className="checkout">
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
          </button>
        ))}
      </div>

      <button className="primary" onClick={createInvoice} type="button">
        Create invoice
      </button>

      {checkout === undefined ? null : (
        <div className="invoice">
          <OpenReceiveCheckout
            invoice={checkout.invoice}
            payment_hash={checkout.payment_hash}
            amount_msats={checkout.amount_msats}
            transaction_state={checkout.transaction_state}
            logger={logOpenReceive}
            classNames={{
              root: "react-checkout",
              actions: "actions",
              invoice: "invoice-text"
            }}
          />
          <p className="status">Status: {displayStatus}</p>
        </div>
      )}

      {error === "" ? null : <p className="error">{error}</p>}
    </section>
  );
}
