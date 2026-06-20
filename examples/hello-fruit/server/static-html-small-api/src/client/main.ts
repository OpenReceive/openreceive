import {
  defineOpenReceiveElements,
  parseOpenReceiveInvoiceEvent
} from "@openreceive/elements";
import * as QRCode from "qrcode";
import {
  createHelloFruitBrowserLogger
} from "../../../../shared/demo-browser-logging.ts";
import fruitsData from "../../../../shared/fruits.json";
import product from "../../../../shared/product.json";
import "./styles.css";

interface Fruit {
  id: string;
  name: string;
  sticker: string;
  fiat: {
    currency: string;
    value: string;
  };
}

interface InvoiceResponse {
  invoice_id: string;
  invoice: string;
  payment_hash: string;
  amount_msats: number;
  transaction_state: string;
  workflow_state: string;
  checkout?: {
    events_url?: string;
  };
}

const fruits = fruitsData.fruits as Fruit[];
const firstFruit = fruits[0];
if (firstFruit === undefined) {
  throw new Error("Hello Fruit demo requires at least one fruit.");
}

let selectedFruit: Fruit = fruits[1] ?? firstFruit;
let invoice: InvoiceResponse | undefined;
let pollTimer: number | undefined;
let events: EventSource | undefined;
const logOpenReceive = createHelloFruitBrowserLogger("static-html-small-api");

defineOpenReceiveElements({
  qrEncoder: QRCode,
  logger: logOpenReceive
});
renderProduct();
renderFruitGrid();

document.getElementById("create-invoice")?.addEventListener("click", () => {
  void createInvoice();
});

function renderProduct(): void {
  const sticker = requireElement<HTMLImageElement>("product-sticker");
  const title = requireElement("product-title");
  const description = requireElement("product-description");

  sticker.src = `/${selectedFruit.sticker}`;
  title.textContent = product.name;
  description.textContent = product.description;
}

function renderFruitGrid(): void {
  const grid = requireElement("fruit-grid");
  grid.replaceChildren();

  for (const fruit of fruits) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = fruit.id === selectedFruit.id ? "selected" : "";
    button.addEventListener("click", () => {
      selectedFruit = fruit;
      renderProduct();
      renderFruitGrid();
    });

    const image = document.createElement("img");
    image.src = `/${fruit.sticker}`;
    image.alt = "";

    const label = document.createElement("span");
    label.textContent = fruit.name;

    const price = document.createElement("small");
    price.textContent = formatFiat(fruit.fiat);

    button.append(image, label, price);
    grid.append(button);
  }
}

async function createInvoice(): Promise<void> {
  setError("");
  stopWatchingInvoice();
  setButtonState("creating");

  try {
    const response = await fetch("/openreceive/v1/invoices", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `hello-fruit-static-${selectedFruit.id}`
      },
      body: JSON.stringify({
        fiat: selectedFruit.fiat,
        description: `Fruit sticker from OpenReceive static demo: ${selectedFruit.name}`,
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
      throw new Error(body.message ?? "Could not create invoice.");
    }

    invoice = body;
    renderInvoice(body);
    watchInvoice(body);
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  } finally {
    setButtonState("idle");
  }
}

function renderInvoice(nextInvoice: InvoiceResponse): void {
  const panel = requireElement("invoice-panel");
  const checkout = document.createElement("openreceive-checkout");
  checkout.setAttribute("invoice", nextInvoice.invoice);
  checkout.setAttribute("payment-hash", nextInvoice.payment_hash);
  checkout.setAttribute("amount-msats", String(nextInvoice.amount_msats));
  checkout.setAttribute("transaction-state", nextInvoice.transaction_state);
  checkout.addEventListener("openreceive-error", (event) => {
    const detail = (event as CustomEvent<{ error?: unknown }>).detail;
    setError(detail?.error instanceof Error ? detail.error.message : String(detail?.error));
  });

  panel.replaceChildren(checkout);
}

function watchInvoice(nextInvoice: InvoiceResponse): void {
  // Passive SSE hints must match the current invoice (invoice_id and
  // payment_hash) before they may touch the UI; events never fulfill.
  const matchesCurrentInvoice = (data: unknown): boolean => {
    try {
      const parsed = parseOpenReceiveInvoiceEvent(data as string);
      if (parsed.invoice_id !== nextInvoice.invoice_id) return false;
      if (
        parsed.payment_hash !== undefined &&
        parsed.payment_hash !== nextInvoice.payment_hash
      ) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  };

  if (nextInvoice.checkout?.events_url !== undefined) {
    events = new EventSource(nextInvoice.checkout.events_url);
    events.addEventListener("invoice.settled", (event) => {
      if (!matchesCurrentInvoice((event as MessageEvent).data)) return;
      updateInvoiceState("settled");
    });
    events.addEventListener("invoice.expired", (event) => {
      if (!matchesCurrentInvoice((event as MessageEvent).data)) return;
      updateInvoiceState("expired");
    });
    events.onerror = () => events?.close();
  }

  pollTimer = window.setInterval(() => {
    void lookupInvoice();
  }, 3000);
}

async function lookupInvoice(): Promise<void> {
  if (invoice === undefined) return;

  try {
    const response = await fetch("/openreceive/v1/invoices/lookup", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        payment_hash: invoice.payment_hash
      })
    });
    const body = await response.json();

    if (!response.ok) {
      setError(body.message ?? "Could not look up invoice.");
      return;
    }

    updateInvoiceState(body.transaction_state ?? body.workflow_state ?? "pending");
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  }
}

function updateInvoiceState(state: string): void {
  const checkout = document.querySelector("openreceive-checkout");
  checkout?.setAttribute("transaction-state", state);

  if (state === "settled" || state === "expired" || state === "failed") {
    stopWatchingInvoice();
  }
}

function stopWatchingInvoice(): void {
  if (pollTimer !== undefined) {
    window.clearInterval(pollTimer);
    pollTimer = undefined;
  }
  events?.close();
  events = undefined;
}

function setButtonState(state: "idle" | "creating"): void {
  const button = requireElement<HTMLButtonElement>("create-invoice");
  button.disabled = state === "creating";
  button.textContent = state === "creating" ? "Creating..." : "Create invoice";
}

function setError(message: string): void {
  requireElement("error").textContent = message;
}

function formatFiat(fiat: Fruit["fiat"]): string {
  return fiat.currency === "USD" ? `$${fiat.value}` : `${fiat.value} ${fiat.currency}`;
}

function requireElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`missing element #${id}`);
  return element as T;
}
