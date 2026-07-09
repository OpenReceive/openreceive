import {
  createOpenReceiveThemeToggleElement,
  OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS,
  OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME,
} from "@openreceive/browser/internal";
import { defineOpenReceiveElements } from "@openreceive/elements";
import {
  createHelloFruitDemoBrowserConsoleLogger,
  createHelloFruitBrowserLogger,
} from "../../../../shared/demo-browser-logging.ts";
import { readHelloFruitCheckoutCurrencies } from "../../../../shared/demo-currencies.ts";
import {
  formatHelloFruitBuyNowLabel,
  formatHelloFruitFiat,
  helloFruitDemoLabels,
} from "../../../../shared/demo-formatting.ts";
import {
  formatHelloFruitDisplayPrice,
  toHelloFruitDisplayAmount,
  type HelloFruitBtcFiatRates,
} from "../../../../shared/demo-pricing.ts";
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

interface DemoOrder {
  uuid: string;
  status: "pending_payment" | "paid";
  items: {
    product_id: string;
    name: string;
    quantity: number;
  }[];
  total_amount: {
    currency: string;
    value: string;
  };
}

interface PrepareOrderResponse {
  order: DemoOrder;
}

const fruits = fruitsData.fruits as Fruit[];
const currencyOptions = readHelloFruitCheckoutCurrencies();
const firstFruit = fruits[0];
if (firstFruit === undefined) {
  throw new Error("Hello Fruit demo requires at least one fruit.");
}

let selectedFruit: Fruit = fruits[1] ?? firstFruit;
let selectedCurrency = "USD";
let displayRates: HelloFruitBtcFiatRates | undefined;
let cart: Record<string, number> = {};
let currentOrder: DemoOrder | undefined;
let purchasedFruit: Fruit | undefined;
let completedOrderId = "";
const logOpenReceive = createHelloFruitBrowserLogger("static-html-small-api");
const logDemo = createHelloFruitDemoBrowserConsoleLogger("static-html-small-api");

defineOpenReceiveElements({
  logger: logOpenReceive,
});
logDemo("app.bootstrap", "Bootstrapping static HTML demo app.", {
  fruitCount: fruits.length,
  currencyOptions,
  selectedFruitId: selectedFruit.id,
  selectedCurrency,
});
renderThemeToggle();
renderProduct();
renderCurrencyPicker();
renderFruitGrid();
renderCreateOrderControls();
logDemo("app.ready", "Static HTML demo app mounted.");
void loadDisplayRates();

document.getElementById("add-to-cart")?.addEventListener("click", () => {
  addSelectedFruitToCart();
});
document.getElementById("create-order")?.addEventListener("click", () => {
  void createOrder();
});

function renderThemeToggle(): void {
  const topbar = requireElement("topbar");
  logDemo("theme_toggle.render", "Rendering OpenReceive theme toggle.");
  topbar.replaceChildren(
    createOpenReceiveThemeToggleElement({
      document,
      rootSelector: ".page",
      checkoutSelector: "openreceive-checkout",
      defaultTheme: "light",
    }),
  );
}

function renderProduct(): void {
  const sticker = requireElement<HTMLImageElement>("product-sticker");
  const title = requireElement("product-title");
  const description = requireElement("product-description");

  logDemo("product.render", "Rendering selected product.", {
    fruitId: selectedFruit.id,
    fruitName: selectedFruit.name,
  });
  sticker.src = `/${selectedFruit.sticker}`;
  title.textContent = product.name;
  description.textContent = product.description;
}

function renderFruitGrid(): void {
  const grid = requireElement("fruit-grid");
  grid.replaceChildren();
  logDemo("fruit_grid.render", "Rendering fruit picker.", {
    fruitCount: fruits.length,
    selectedFruitId: selectedFruit.id,
  });

  for (const fruit of fruits) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = fruit.id === selectedFruit.id ? "selected" : "";
    button.addEventListener("click", () => {
      logDemo("fruit.select", "Fruit selected.", {
        fruitId: fruit.id,
        fruitName: fruit.name,
      });
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
    price.textContent = formatHelloFruitDisplayPrice(fruit.fiat, selectedCurrency, displayRates);

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
    logDemo("currency.change", "Currency changed.", {
      from: selectedCurrency,
      to: select.value,
    });
    selectedCurrency = select.value;
    renderFruitGrid();
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
  addButton.textContent = formatHelloFruitBuyNowLabel(
    toHelloFruitDisplayAmount(selectedFruit.fiat, selectedCurrency, displayRates),
  );
  renderCart();

  const orderButton = requireElement<HTMLButtonElement>("create-order");
  const cartQuantity = cartItems().reduce((total, item) => total + item.quantity, 0);
  orderButton.disabled = cartQuantity === 0;
  orderButton.textContent = helloFruitDemoLabels.createOrder;
  logDemo("controls.render", "Rendered cart and order controls.", {
    selectedFruitId: selectedFruit.id,
    selectedCurrency,
    cartQuantity,
    canCreateOrder: cartQuantity > 0,
  });
}

function addSelectedFruitToCart(): void {
  const nextQuantity = Math.min((cart[selectedFruit.id] ?? 0) + 1, 9);
  logDemo("cart.add", "Adding selected fruit to cart.", {
    fruitId: selectedFruit.id,
    fruitName: selectedFruit.name,
    currency: selectedCurrency,
    quantity: nextQuantity,
  });
  cart = {
    ...cart,
    [selectedFruit.id]: Math.min((cart[selectedFruit.id] ?? 0) + 1, 9),
  };
  renderCreateOrderControls();
}

function removeFruitFromCart(fruitId: string): void {
  logDemo("cart.remove", "Removing fruit from cart.", {
    fruitId,
  });
  const next = { ...cart };
  delete next[fruitId];
  cart = next;
  renderCreateOrderControls();
}

function renderCart(): void {
  const panel = requireElement("cart-panel");
  panel.replaceChildren();

  const items = cartItems();
  if (items.length === 0) {
    logDemo("cart.render", "Cart is empty.");
    return;
  }
  logDemo("cart.render", "Rendering cart.", {
    cartLineCount: items.length,
    cartQuantity: items.reduce((total, item) => total + item.quantity, 0),
  });

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
  logDemo("order.render", "Rendering order summary.", {
    orderId: order.uuid,
    orderStatus: order.status,
    itemCount: order.items.length,
    total: order.total_amount,
  });

  const section = document.createElement("section");
  section.className = "cart";
  section.setAttribute("aria-label", "Order");

  const heading = document.createElement("div");
  heading.className = "cart-heading";
  const title = document.createElement("strong");
  title.textContent = "Order";
  const total = document.createElement("span");
  total.textContent = formatHelloFruitFiat(order.total_amount);
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
  button.textContent =
    state === "creating" ? helloFruitDemoLabels.creatingOrder : helloFruitDemoLabels.createOrder;
}

async function createOrder(): Promise<void> {
  setError("");
  setOrderButtonState("creating");
  closeStickerModal();
  completedOrderId = "";

  try {
    const startedAt = Date.now();
    const items = cartItems();
    logDemo("prepare_order.request", "Posting prepare order request.", {
      currency: selectedCurrency,
      cartLineCount: items.length,
      cartQuantity: items.reduce((total, item) => total + item.quantity, 0),
      productIds: items.map((item) => item.fruit.id),
    });
    // App route: build + persist the order. The <openreceive-checkout order-id> element below then
    // creates the checkout against the mounted /openreceive/checkouts route and drives it itself.
    const response = await fetch("/prepare_order", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        currency: selectedCurrency,
        cart: cartItems().map((item) => ({
          product_id: item.fruit.id,
          quantity: item.quantity,
        })),
      }),
    });
    const body = (await response.json()) as unknown;
    logDemo("prepare_order.response", "Received prepare order response.", {
      ok: response.ok,
      status: response.status,
      elapsedMs: Date.now() - startedAt,
      hasOrder: isPrepareOrderResponse(body),
    });
    if (!response.ok || !isPrepareOrderResponse(body)) {
      throw new Error(readErrorMessage(body) ?? helloFruitDemoLabels.createOrderError);
    }

    currentOrder = body.order;
    purchasedFruit = items[0]?.fruit;
    logDemo("prepare_order.ready", "Order accepted by browser app.", {
      orderId: body.order.uuid,
      orderStatus: body.order.status,
      itemCount: body.order.items.length,
      total: body.order.total_amount,
    });
    renderOrder(body.order);
    renderCheckout(body.order.uuid);
  } catch (error) {
    logDemo("prepare_order.error", "Prepare order failed in the browser.", {
      error: error instanceof Error ? error.message : String(error),
    });
    setError(error instanceof Error ? error.message : String(error));
  } finally {
    setOrderButtonState("idle");
  }
}

function renderCheckout(orderId: string): void {
  const panel = requireElement("checkout-panel");
  logDemo("checkout.render", "Rendering self-contained OpenReceive checkout element.", {
    orderId,
  });
  // The SELF-CONTAINED custom element: given just `order-id` (prefix defaults to /openreceive), it
  // creates the checkout, polls, and drives swaps itself. No hand-written invoice/status/swap routes.
  const checkoutElement = document.createElement(OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME);
  checkoutElement.setAttribute("order-id", orderId);

  checkoutElement.addEventListener(OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.error, (event) => {
    const detail = (event as CustomEvent<{ error?: unknown }>).detail;
    logDemo("checkout.error", "Checkout element reported an error.", {
      error: detail?.error instanceof Error ? detail.error.message : String(detail?.error),
    });
    setError(detail?.error instanceof Error ? detail.error.message : String(detail?.error));
  });

  checkoutElement.addEventListener(OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.settled, () => {
    if (currentOrder === undefined || completedOrderId === orderId || purchasedFruit === undefined) {
      return;
    }
    logDemo("checkout.settled", "Checkout settled callback received.", {
      orderId,
      purchasedFruitId: purchasedFruit.id,
    });
    completedOrderId = orderId;
    currentOrder = { ...currentOrder, status: "paid" };
    renderOrder(currentOrder);
    showStickerModal(purchasedFruit);
  });

  panel.replaceChildren(checkoutElement);
}

function setError(message: string): void {
  if (message !== "") {
    logDemo("error.show", "Showing browser error message.", {
      message,
    });
  }
  requireElement("error").textContent = message;
}

function showStickerModal(fruit: Fruit): void {
  closeStickerModal();
  logDemo("sticker_modal.show", "Showing sticker download modal.", {
    fruitId: fruit.id,
    fruitName: fruit.name,
  });

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
  if (document.getElementById("sticker-modal-backdrop") !== null) {
    logDemo("sticker_modal.close", "Closing sticker download modal.");
  }
  document.getElementById("sticker-modal-backdrop")?.remove();
}

async function loadDisplayRates(): Promise<void> {
  try {
    const response = await fetch("/rates");
    if (!response.ok) throw new Error(`rates request failed: HTTP ${response.status}`);
    const body = (await response.json()) as { rates?: HelloFruitBtcFiatRates };
    if (body.rates === undefined) return;
    displayRates = body.rates;
    logDemo("rates.loaded", "Loaded display exchange rates.", {
      rateCurrencies: Object.keys(body.rates.bitcoin),
    });
    if (currentOrder === undefined) {
      renderFruitGrid();
      renderCreateOrderControls();
    }
  } catch (cause: unknown) {
    logDemo("rates.error", "Failed to load display exchange rates.", {
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

function requireElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`missing element #${id}`);
  return element as T;
}

function isPrepareOrderResponse(value: unknown): value is PrepareOrderResponse {
  return typeof value === "object" && value !== null && "order" in value;
}

function readErrorMessage(value: unknown): string | undefined {
  return typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
    ? value.message
    : undefined;
}
