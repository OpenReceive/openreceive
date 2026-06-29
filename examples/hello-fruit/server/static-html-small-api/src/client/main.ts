import {
  createCheckoutShell,
  createOpenReceiveThemeToggleElement,
  type CheckoutSnapshot
} from "@openreceive/browser/internal";
import {
  defineOpenReceiveElements
} from "@openreceive/elements";
import {
  createHelloFruitBrowserLogger
} from "../../../../shared/demo-browser-logging.ts";
import {
  readHelloFruitCheckoutCurrencies
} from "../../../../shared/demo-currencies.ts";
import {
  formatHelloFruitBuyNowLabel,
  formatHelloFruitFiat,
  helloFruitDemoLabels
} from "../../../../shared/demo-formatting.ts";
import fruitsData from "../../../../shared/fruits.json" with { type: "json" };
import product from "../../../../shared/product.json" with { type: "json" };
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

interface CheckoutStateEventDetail {
  state?: {
    order_id?: string;
  };
}

interface DemoOrder {
  uuid: string;
  status: "pending_payment" | "paid";
  items: {
    product_id: string;
    name: string;
    quantity: number;
  }[];
  totalAmount: {
    currency: string;
    value: string;
  };
}

interface CreateOrderResponse {
  order: DemoOrder;
  checkout: CheckoutSnapshot;
}

const fruits = fruitsData.fruits as Fruit[];
const currencyOptions = readHelloFruitCheckoutCurrencies();
const firstFruit = fruits[0];
if (firstFruit === undefined) {
  throw new Error("Hello Fruit demo requires at least one fruit.");
}

let selectedFruit: Fruit = fruits[1] ?? firstFruit;
let selectedCurrency = "USD";
let cart: Record<string, number> = {};
let currentOrder: DemoOrder | undefined;
let purchasedFruit: Fruit | undefined;
let completedInvoiceId = "";
const logOpenReceive = createHelloFruitBrowserLogger("static-html-small-api");

defineOpenReceiveElements({
  logger: logOpenReceive
});
renderThemeToggle();
renderProduct();
renderCurrencyPicker();
renderFruitGrid();
renderCreateOrderControls();

document.getElementById("add-to-cart")?.addEventListener("click", () => {
  addSelectedFruitToCart();
});
document.getElementById("create-order")?.addEventListener("click", () => {
  void createOrder();
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
      renderCreateOrderControls();
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

function renderCurrencyPicker(): void {
  const panel = requireElement("currency-panel");
  const label = document.createElement("label");
  label.className = "currency-picker";
  const text = document.createElement("span");
  text.textContent = "Currency";
  const select = document.createElement("select");
  select.value = selectedCurrency;
  select.addEventListener("change", () => {
    selectedCurrency = select.value;
    renderCreateOrderControls();
  });

  for (const currency of currencyOptions) {
    const option = document.createElement("option");
    option.value = currency;
    option.textContent = currency;
    select.append(option);
  }

  label.append(text, select);
  panel.replaceChildren(label);
}

function renderCreateOrderControls(): void {
  const addButton = requireElement<HTMLButtonElement>("add-to-cart");
  addButton.textContent = selectedCurrency === selectedFruit.fiat.currency
    ? formatHelloFruitBuyNowLabel(selectedFruit.fiat)
    : `Add to cart (${selectedCurrency})`;
  renderCart();

  const orderButton = requireElement<HTMLButtonElement>("create-order");
  const cartQuantity = cartItems().reduce((total, item) => total + item.quantity, 0);
  orderButton.disabled = cartQuantity === 0;
  orderButton.textContent = helloFruitDemoLabels.createOrder;
}

function addSelectedFruitToCart(): void {
  cart = {
    ...cart,
    [selectedFruit.id]: Math.min((cart[selectedFruit.id] ?? 0) + 1, 9)
  };
  renderCreateOrderControls();
}

function removeFruitFromCart(fruitId: string): void {
  const next = { ...cart };
  delete next[fruitId];
  cart = next;
  renderCreateOrderControls();
}

function renderCart(): void {
  const panel = requireElement("cart-panel");
  panel.replaceChildren();

  const items = cartItems();
  if (items.length === 0) return;

  const section = document.createElement("section");
  section.className = "cart";
  section.setAttribute("aria-label", "Cart");

  const heading = document.createElement("div");
  heading.className = "cart-heading";
  const title = document.createElement("strong");
  title.textContent = "Cart";
  const count = document.createElement("span");
  const quantity = items.reduce((total, item) => total + item.quantity, 0);
  count.textContent = `${quantity} item${quantity === 1 ? "" : "s"}`;
  heading.append(title, count);
  section.append(heading);

  for (const item of items) {
    const row = document.createElement("div");
    row.className = "cart-row";
    const name = document.createElement("span");
    name.textContent = item.fruit.name;
    const amount = document.createElement("span");
    amount.textContent = `x${item.quantity}`;
    const remove = document.createElement("button");
    remove.className = "secondary";
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => removeFruitFromCart(item.fruit.id));
    row.append(name, amount, remove);
    section.append(row);
  }

  panel.append(section);
}

function renderOrder(order: DemoOrder): void {
  const panel = requireElement("cart-panel");
  panel.replaceChildren();

  const section = document.createElement("section");
  section.className = "cart";
  section.setAttribute("aria-label", "Order");

  const heading = document.createElement("div");
  heading.className = "cart-heading";
  const title = document.createElement("strong");
  title.textContent = "Order";
  const total = document.createElement("span");
  total.textContent = formatHelloFruitFiat(order.totalAmount);
  heading.append(title, total);
  section.append(heading);

  for (const item of order.items) {
    const row = document.createElement("div");
    row.className = "cart-row";
    const name = document.createElement("span");
    name.textContent = item.name;
    const quantity = document.createElement("span");
    quantity.textContent = `x${item.quantity}`;
    const state = document.createElement("span");
    state.textContent = order.status === "paid" ? "Paid" : "Pending";
    row.append(name, quantity, state);
    section.append(row);
  }

  panel.append(section);
}

function cartItems(): { fruit: Fruit; quantity: number }[] {
  return fruits
    .map((fruit) => ({ fruit, quantity: cart[fruit.id] ?? 0 }))
    .filter((item) => item.quantity > 0);
}

function setOrderButtonState(state: "idle" | "creating"): void {
  const button = requireElement<HTMLButtonElement>("create-order");
  button.disabled = state === "creating" || cartItems().length === 0;
  button.textContent = formatHelloFruitBuyNowLabel(selectedFruit.fiat);
  button.textContent = state === "creating"
    ? helloFruitDemoLabels.creatingOrder
    : helloFruitDemoLabels.createOrder;
}

async function createOrder(): Promise<void> {
  setError("");
  setOrderButtonState("creating");
  closeStickerModal();
  completedInvoiceId = "";

  try {
    const idempotencyKey = globalThis.crypto?.randomUUID?.() ??
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const response = await fetch("/create_order", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        idempotency_key: idempotencyKey,
        currency: selectedCurrency,
        cart: cartItems().map((item) => ({
          product_id: item.fruit.id,
          quantity: item.quantity
        }))
      })
    });
    const body = await response.json() as unknown;
    if (!response.ok || !isCreateOrderResponse(body)) {
      throw new Error(readErrorMessage(body) ?? helloFruitDemoLabels.createOrderError);
    }

    currentOrder = body.order;
    purchasedFruit = cartItems()[0]?.fruit;
    renderOrder(body.order);
    renderInvoice(body.checkout);
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  } finally {
    setOrderButtonState("idle");
  }
}

function renderInvoice(nextInvoice: CheckoutSnapshot): void {
  const topbar = requireElement("topbar");
  const panel = requireElement("checkout-panel");
  const shell = createCheckoutShell(nextInvoice, {
    document,
    root: document.querySelector(".page"),
    statusUrl: "/order_status",
    rootSelector: ".page",
    defaultTheme: "light",
    onError: (event) => {
      const detail = (event as CustomEvent<{ error?: unknown }>).detail;
      setError(detail?.error instanceof Error ? detail.error.message : String(detail?.error));
    },
    onSettled: (event) => {
      const state = (event as CustomEvent<CheckoutStateEventDetail>).detail?.state;
      if (
        state?.order_id !== undefined &&
        state.order_id !== completedInvoiceId &&
          purchasedFruit !== undefined
      ) {
        completedInvoiceId = state.order_id;
        if (currentOrder !== undefined) {
          currentOrder = { ...currentOrder, status: "paid" };
          renderOrder(currentOrder);
        }
        showStickerModal(purchasedFruit);
      }
    }
  });

  topbar.replaceChildren(shell.themeToggle);
  panel.replaceChildren(shell.checkout);
}

function setError(message: string): void {
  requireElement("error").textContent = message;
}

function showStickerModal(fruit: Fruit): void {
  closeStickerModal();

  const backdrop = document.createElement("div");
  backdrop.className = "sticker-modal-backdrop";
  backdrop.id = "sticker-modal-backdrop";

  const modal = document.createElement("section");
  modal.className = "sticker-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "sticker-modal-title");

  const image = document.createElement("img");
  image.src = `/${fruit.sticker}`;
  image.alt = "";

  const title = document.createElement("h2");
  title.id = "sticker-modal-title";
  title.textContent = "You just got a sticker";

  const detail = document.createElement("p");
  detail.textContent = `${fruit.name} is ready.`;

  const actions = document.createElement("div");
  actions.className = "sticker-modal-actions";

  const download = document.createElement("a");
  download.className = "primary sticker-download";
  download.href = `/${fruit.sticker}`;
  download.download = `${fruit.id}-sticker.svg`;
  download.textContent = "Download sticker";

  const close = document.createElement("button");
  close.className = "secondary";
  close.type = "button";
  close.textContent = "Close";
  close.addEventListener("click", closeStickerModal);

  actions.append(download, close);
  modal.append(image, title, detail, actions);
  backdrop.append(modal);
  document.body.append(backdrop);
}

function closeStickerModal(): void {
  document.getElementById("sticker-modal-backdrop")?.remove();
}

function requireElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`missing element #${id}`);
  return element as T;
}

function isCreateOrderResponse(value: unknown): value is CreateOrderResponse {
  return typeof value === "object" &&
    value !== null &&
    "order" in value &&
    "checkout" in value;
}

function readErrorMessage(value: unknown): string | undefined {
  return typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
    ? value.message
    : undefined;
}
