import {
  createOpenReceiveCheckoutShell,
  createOpenReceiveThemeToggleElement
} from "@openreceive/browser";
import {
  defineOpenReceiveElements
} from "@openreceive/elements";
import * as QRCode from "qrcode";
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
import "@openreceive/elements/styles.css";
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
  expires_at?: number;
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
const logOpenReceive = createHelloFruitBrowserLogger("static-html-small-api");

defineOpenReceiveElements({
  qrEncoder: QRCode,
  logger: logOpenReceive
});
renderThemeToggle();
renderProduct();
renderFruitGrid();

document.getElementById("create-invoice")?.addEventListener("click", () => {
  void createInvoice();
});

function renderThemeToggle(): void {
  const topbar = requireElement("topbar");
  topbar.replaceChildren(createOpenReceiveThemeToggleElement({
    document,
    rootSelector: ".page",
    checkoutSelector: "openreceive-checkout",
    defaultTheme: "light"
  }));
}

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
    price.textContent = formatHelloFruitFiat(fruit.fiat);

    button.append(image, label, price);
    grid.append(button);
  }
}

async function createInvoice(): Promise<void> {
  setError("");
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
        description: createHelloFruitInvoiceDescription(selectedFruit.name, {
          demoName: "static"
        }),
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
      throw new Error(body.message ?? helloFruitDemoLabels.createInvoiceError);
    }

    renderInvoice(body);
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  } finally {
    setButtonState("idle");
  }
}

function renderInvoice(nextInvoice: InvoiceResponse): void {
  const topbar = requireElement("topbar");
  const panel = requireElement("invoice-panel");
  const shell = createOpenReceiveCheckoutShell(nextInvoice, {
    document,
    root: document.querySelector(".page"),
    lookupUrl: "/openreceive/v1/invoices/lookup",
    rootSelector: ".page",
    defaultTheme: "light",
    onError: (event) => {
      const detail = (event as CustomEvent<{ error?: unknown }>).detail;
      setError(detail?.error instanceof Error ? detail.error.message : String(detail?.error));
    }
  });

  topbar.replaceChildren(shell.themeToggle);
  panel.replaceChildren(shell.checkout);
}

function setButtonState(state: "idle" | "creating"): void {
  const button = requireElement<HTMLButtonElement>("create-invoice");
  button.disabled = state === "creating";
  button.textContent = state === "creating"
    ? helloFruitDemoLabels.creatingInvoice
    : helloFruitDemoLabels.createInvoice;
}

function setError(message: string): void {
  requireElement("error").textContent = message;
}

function requireElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`missing element #${id}`);
  return element as T;
}
