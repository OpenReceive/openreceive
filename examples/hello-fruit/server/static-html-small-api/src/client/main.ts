import {
  createOpenReceiveThemeToggleElement,
  OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES,
  OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS,
  OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME,
  requestOrderSummary,
  type CheckoutState,
} from "@openreceive/browser/internal";
import { defineOpenReceiveElements, createTransactionDetailsElement } from "@openreceive/elements";
import {
  createHelloFruitDemoBrowserConsoleLogger,
  createHelloFruitBrowserLogger,
} from "../../../../shared/demo-browser-logging.ts";
import {
  enterHelloFruitCheckout,
  forgetHelloFruitOrder,
  leaveHelloFruitCheckout,
  parseHelloFruitCheckoutOrderId,
  rememberHelloFruitOrder,
} from "../../../../shared/demo-checkout-resume.ts";
import {
  fetchHelloFruitDeliveryObjectUrl,
  waitForHelloFruitPaidSummary,
} from "../../../../shared/demo-delivery-client.ts";
import { isHelloFruitDemoOrder } from "../../../../shared/demo-order.ts";
import type { HelloFruitDemoOrder } from "../../../../shared/demo-order.ts";
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
  items: HelloFruitDemoOrder["items"];
  total_amount: HelloFruitDemoOrder["total_amount"];
}

interface PrepareOrderResponse {
  order_id: string;
  summary?: DemoOrder;
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
let deliveryObjectUrl: string | undefined;
let settledCheckoutState: CheckoutState | undefined;
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
void resumeCheckoutFromUrl();
globalThis.addEventListener("popstate", () => {
  void resumeCheckoutFromUrl();
});

document.getElementById("add-to-cart")?.addEventListener("click", () => {
  addSelectedFruitToCart();
});
document.getElementById("create-order")?.addEventListener("click", () => {
  void createOrder();
});

async function resumeCheckoutFromUrl(): Promise<void> {
  const orderId = parseHelloFruitCheckoutOrderId(globalThis.location.pathname);
  if (orderId === undefined) {
    if (currentOrder !== undefined) {
      startOver({ preserveUrl: true });
    }
    return;
  }
  if (currentOrder?.uuid === orderId) {
    renderOrder(currentOrder);
    renderCheckout(orderId);
    return;
  }
  logDemo("checkout.resume", "Resuming checkout from URL.", { orderId });
  setError("");
  const result = await requestOrderSummary({ orderId });
  if (parseHelloFruitCheckoutOrderId(globalThis.location.pathname) !== orderId) {
    return;
  }
  if (result === undefined || !("summary" in result) || !isHelloFruitDemoOrder(result.summary)) {
    logDemo("checkout.resume_miss", "Checkout resume order not found.", { orderId });
    leaveHelloFruitCheckout();
    startOver({ preserveUrl: true });
    setError("This checkout link is no longer available. Start a new order.");
    return;
  }
  const resumed = result.summary;
  currentOrder = resumed;
  purchasedFruit = fruits.find((fruit) => fruit.id === resumed.items[0]?.product_id);
  renderOrder(resumed);
  renderCheckout(resumed.uuid);
  if (resumed.status === "paid") {
    completedOrderId = resumed.uuid;
    void revealFulfilledDelivery(resumed.uuid).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }
}

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
    button.className = [
      "card card-border bg-base-100 p-3 grid gap-2 text-left cursor-pointer hover:border-primary",
      fruit.id === selectedFruit.id ? "border-primary ring-2 ring-primary/30" : "",
    ]
      .filter(Boolean)
      .join(" ");
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
    image.className = "w-full aspect-square";
    image.src = `/${fruit.sticker}`;
    image.alt = "";

    const label = document.createElement("span");
    label.textContent = fruit.name;

    const price = document.createElement("small");
    price.className = "text-base-content/70";
    price.textContent = formatHelloFruitDisplayPrice(fruit.fiat, selectedCurrency, displayRates);

    button.append(image, label, price);
    grid.append(button);
  }
}

function renderCurrencyPicker(): void {
  const panel = requireElement("currency-panel");
  const label = document.createElement("label");
  label.className = "form-control w-full max-w-xs";
  const text = document.createElement("span");
  text.className = "label-text mb-1";
  text.textContent = "Currency";
  const select = document.createElement("select");
  select.className = "select select-bordered w-full";
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

function setCheckoutMode(mode: "shop" | "pay"): void {
  requireElement("shop-panel").classList.toggle("hidden", mode !== "shop");
  requireElement("pay-panel").classList.toggle("hidden", mode !== "pay");
}

function startOver(options: { readonly preserveUrl?: boolean } = {}): void {
  logDemo("checkout.start_over", "Resetting static demo to shop mode.");
  forgetHelloFruitOrder(currentOrder?.uuid);
  if (options.preserveUrl !== true) {
    leaveHelloFruitCheckout();
  }
  currentOrder = undefined;
  purchasedFruit = undefined;
  completedOrderId = "";
  settledCheckoutState = undefined;
  cart = {};
  closeStickerModal();
  setError("");
  requireElement("order-panel").replaceChildren();
  requireElement("checkout-panel").replaceChildren();
  setCheckoutMode("shop");
  renderFruitGrid();
  renderCreateOrderControls();
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
  orderButton.classList.toggle("hidden", cartQuantity === 0);
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
  section.className = "card card-border bg-base-100 px-3 py-2.5 grid gap-1.5";
  section.setAttribute("aria-label", "Cart");

  const heading = document.createElement("div");
  heading.className = "flex justify-between items-center text-sm";
  const title = document.createElement("strong");
  title.textContent = "Cart";
  const count = document.createElement("span");
  const quantity = items.reduce((total, item) => total + item.quantity, 0);
  count.textContent = `${quantity} item${quantity === 1 ? "" : "s"}`;
  heading.append(title, count);
  section.append(heading);

  for (const item of items) {
    const row = document.createElement("div");
    row.className = "flex justify-between items-center gap-2 text-sm";
    const name = document.createElement("span");
    name.textContent = `${item.fruit.name} ×${item.quantity}`;
    const remove = document.createElement("button");
    remove.className = "btn btn-ghost btn-xs";
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => removeFruitFromCart(item.fruit.id));
    row.append(name, remove);
    section.append(row);
  }

  panel.append(section);
}

function renderOrder(order: DemoOrder): void {
  const panel = requireElement("order-panel");
  panel.replaceChildren();
  logDemo("order.render", "Rendering order summary.", {
    orderId: order.uuid,
    orderStatus: order.status,
    itemCount: order.items.length,
    total: order.total_amount,
  });

  const section = document.createElement("section");
  section.className = "card card-border bg-base-200 px-3 py-2.5 grid gap-1";
  section.setAttribute("aria-label", "Order");

  const heading = document.createElement("div");
  heading.className = "flex justify-between items-baseline gap-3";
  const title = document.createElement("strong");
  title.className = "text-sm";
  title.textContent = "Order";
  const total = document.createElement("span");
  total.className = "font-semibold";
  total.textContent = formatHelloFruitFiat(order.total_amount);
  heading.append(title, total);
  section.append(heading);

  for (const item of order.items) {
    const row = document.createElement("div");
    row.className = "flex justify-between items-baseline gap-3 text-sm text-base-content/80";
    const name = document.createElement("span");
    name.textContent = `${item.name} ×${item.quantity}`;
    const state = document.createElement("span");
    state.className = "text-base-content/60";
    state.textContent = order.status === "paid" ? "Paid" : "Awaiting payment";
    row.append(name, state);
    section.append(row);
  }

  const actions = document.createElement("div");
  actions.className = "card-actions pt-1";
  const startOverButton = document.createElement("button");
  startOverButton.className = "btn btn-sm btn-outline";
  startOverButton.type = "button";
  startOverButton.textContent = "Start over";
  startOverButton.addEventListener("click", () => {
    startOver();
  });
  actions.append(startOverButton);
  section.append(actions);

  panel.append(section);
  setCheckoutMode("pay");
}

function cartItems(): { fruit: Fruit; quantity: number }[] {
  return fruits
    .map((fruit) => ({ fruit, quantity: cart[fruit.id] ?? 0 }))
    .filter((item) => item.quantity > 0);
}

function setOrderButtonState(state: "idle" | "creating"): void {
  const button = requireElement<HTMLButtonElement>("create-order");
  const empty = cartItems().length === 0;
  button.disabled = state === "creating" || empty;
  button.classList.toggle("hidden", empty);
  button.textContent =
    state === "creating" ? helloFruitDemoLabels.creatingOrder : helloFruitDemoLabels.createOrder;
}

async function createOrder(): Promise<void> {
  setError("");
  setOrderButtonState("creating");
  closeStickerModal();
  completedOrderId = "";
  settledCheckoutState = undefined;

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
    const response = await fetch("/openreceive/prepare", {
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
    if (
      !response.ok ||
      !isPrepareOrderResponse(body) ||
      !isHelloFruitDemoOrder(body.summary)
    ) {
      throw new Error(readErrorMessage(body) ?? helloFruitDemoLabels.createOrderError);
    }

    const order = body.summary;
    currentOrder = order;
    purchasedFruit = items[0]?.fruit;
    logDemo("prepare_order.ready", "Order accepted by browser app.", {
      orderId: order.uuid,
      orderStatus: order.status,
      itemCount: order.items.length,
      total: order.total_amount,
    });
    rememberHelloFruitOrder(order);
    enterHelloFruitCheckout(order.uuid);
    renderOrder(order);
    renderCheckout(order.uuid);
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
  // Self-contained: order-id restores summary after refresh; host owns /checkout/:id.
  const checkoutElement = document.createElement(OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME);
  checkoutElement.setAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.orderId, orderId);
  checkoutElement.setAttribute(OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES.routeOrderId, orderId);

  checkoutElement.addEventListener(OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.summary, (event) => {
    const detail = (event as CustomEvent<{ summary?: unknown }>).detail;
    const summary = detail?.summary;
    if (!isHelloFruitDemoOrder(summary)) return;
    currentOrder = summary;
    purchasedFruit = fruits.find((fruit) => fruit.id === summary.items[0]?.product_id);
    renderOrder(summary);
    if (summary.status === "paid" && completedOrderId !== summary.uuid) {
      completedOrderId = summary.uuid;
      void revealFulfilledDelivery(summary.uuid).catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    }
  });

  checkoutElement.addEventListener(OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.error, (event) => {
    const detail = (event as CustomEvent<{ error?: unknown }>).detail;
    logDemo("checkout.error", "Checkout element reported an error.", {
      error: detail?.error instanceof Error ? detail.error.message : String(detail?.error),
    });
    setError(detail?.error instanceof Error ? detail.error.message : String(detail?.error));
  });

  checkoutElement.addEventListener(OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.state, (event) => {
    const detail = (event as CustomEvent<{ state?: CheckoutState }>).detail;
    if (detail?.state !== undefined) {
      settledCheckoutState = detail.state;
    }
    // Soft swap-preparing conflicts are not sticky once checkout is progressing again.
    const errorEl = requireElement("error");
    if (errorEl.textContent?.includes("still being prepared")) {
      setError("");
    }
  });

  checkoutElement.addEventListener(OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.settled, (event) => {
    if (currentOrder === undefined || completedOrderId === orderId || purchasedFruit === undefined) {
      return;
    }
    const detail = (event as CustomEvent<{ state?: CheckoutState }>).detail;
    if (detail?.state !== undefined) {
      settledCheckoutState = detail.state;
    }
    logDemo("checkout.settled", "Checkout settled callback received — waiting for server fulfillment.", {
      orderId,
      purchasedFruitId: purchasedFruit.id,
    });
    completedOrderId = orderId;
    void revealFulfilledDelivery(orderId).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  });

  checkoutElement.addEventListener(OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS.startOver, () => {
    startOver();
  });

  panel.replaceChildren(checkoutElement);
}

async function revealFulfilledDelivery(orderId: string): Promise<void> {
  const paid = await waitForHelloFruitPaidSummary({ orderId });
  const firstItem = paid.items[0];
  const fruit =
    firstItem === undefined
      ? undefined
      : fruits.find((entry) => entry.id === firstItem.product_id);
  logDemo("fulfillment.summary_paid", "Server marked order paid; loading delivery.", {
    orderId,
    productId: firstItem?.product_id,
  });
  currentOrder = paid;
  purchasedFruit = fruit;
  renderOrder(paid);
  if (fruit === undefined) return;
  await showStickerModal(orderId, fruit);
}

function setError(message: string): void {
  if (message !== "") {
    logDemo("error.show", "Showing browser error message.", {
      message,
    });
  }
  const errorEl = requireElement("error");
  errorEl.textContent = message;
  errorEl.classList.toggle("hidden", message === "");
}

async function showStickerModal(orderId: string, fruit: Fruit): Promise<void> {
  closeStickerModal();
  logDemo("sticker_modal.show", "Showing sticker download modal.", {
    fruitId: fruit.id,
    fruitName: fruit.name,
  });

  const objectUrl = await fetchHelloFruitDeliveryObjectUrl(orderId, fruit.id);
  deliveryObjectUrl = objectUrl;

  const backdrop = document.createElement("div");
  backdrop.className = "modal modal-open";
  backdrop.id = "sticker-modal-backdrop";

  const modal = document.createElement("section");
  modal.className = "modal-box";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "sticker-modal-title");

  const image = document.createElement("img");
  image.className = "w-full max-w-[180px] aspect-square mx-auto";
  image.src = objectUrl;
  image.alt = "";

  const title = document.createElement("h2");
  title.className = "text-2xl font-bold";
  title.id = "sticker-modal-title";
  title.textContent = "You just got a sticker";

  const detail = document.createElement("p");
  detail.textContent = `${fruit.name} is ready.`;

  const actions = document.createElement("div");
  actions.className = "modal-action";

  const download = document.createElement("a");
  download.className = "btn";
  download.href = objectUrl;
  download.download = `${fruit.id}-sticker.svg`;
  download.textContent = "Download sticker";

  const close = document.createElement("button");
  close.className = "btn btn-ghost";
  close.type = "button";
  close.textContent = "Close";
  close.addEventListener("click", closeStickerModal);

  actions.append(download, close);
  const transactionDetails = createTransactionDetailsElement(settledCheckoutState);
  if (transactionDetails === null) {
    modal.append(image, title, detail, actions);
  } else {
    modal.append(image, title, detail, transactionDetails, actions);
  }
  backdrop.append(modal);
  document.body.append(backdrop);
}

function closeStickerModal(): void {
  if (document.getElementById("sticker-modal-backdrop") !== null) {
    logDemo("sticker_modal.close", "Closing sticker download modal.");
  }
  document.getElementById("sticker-modal-backdrop")?.remove();
  if (deliveryObjectUrl !== undefined) {
    URL.revokeObjectURL(deliveryObjectUrl);
    deliveryObjectUrl = undefined;
  }
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
  return typeof value === "object" && value !== null && "order_id" in value;
}

function readErrorMessage(value: unknown): string | undefined {
  return typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
    ? value.message
    : undefined;
}
