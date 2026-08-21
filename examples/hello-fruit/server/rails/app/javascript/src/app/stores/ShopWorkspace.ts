import { computed } from "mobx";
import {
  _async,
  _await,
  type Frozen,
  frozen,
  Model,
  model,
  modelAction,
  modelFlow,
  prop,
  registerRootStore,
} from "mobx-keystone";
import { createContext } from "react";
import {
  enterHelloFruitCheckout,
  forgetHelloFruitOrder,
  leaveHelloFruitCheckout,
  parseHelloFruitCheckoutOrderId,
  rememberHelloFruitOrder,
} from "../../../../../../../shared/demo-checkout-resume.ts";
import { launchHelloFruitConfetti } from "../../../../../../../shared/demo-confetti.ts";
import {
  fetchHelloFruitPurchasedStickers,
  revokeHelloFruitStickers,
  type HelloFruitPurchasedSticker,
  waitForHelloFruitPaidSummary,
} from "../../../../../../../shared/demo-delivery-client.ts";
import { helloFruitDemoLabels } from "../../../../../../../shared/demo-formatting.ts";
import { isHelloFruitDemoOrder } from "../../../../../../../shared/demo-order.ts";
import type { HelloFruitBtcFiatRates } from "../../../../../../../shared/demo-pricing.ts";
import { getJsonFromRails, sendToRailsController } from "../../helpers/requests.ts";
import { ORDERS_URL, RATES_URL, setOpenReceivePrefix } from "../helpers/constants.ts";
import { logDemo } from "../helpers/logging.ts";
import type {
  HelloFruitDemoOrder,
  HelloFruitFruitPayload,
  HelloFruitProductInfo,
  ShopBootstrap,
} from "../helpers/types.ts";
import { CheckoutFlow } from "./CheckoutFlow.ts";

export interface StickerModalState {
  readonly orderId: string;
  /** Every line on the order — carts hold more than one sticker. */
  readonly stickers: readonly HelloFruitPurchasedSticker[];
}

/**
 * Root store for the Hello Fruit shop. Hydrated once from the ERB page's
 * `#__app_bootstrap` JSON blob; everything shared lives here — components use
 * `useContext(ShopWorkspaceContext)` and observe.
 */
@model("helloFruit/ShopWorkspace")
export class ShopWorkspace extends Model({
  hydrated: prop<boolean>(false),
  fruits: prop<Frozen<readonly HelloFruitFruitPayload[]>>(() => frozen([])),
  productInfo: prop<Frozen<HelloFruitProductInfo>>(() =>
    frozen({ name: "Hello Fruit", description: "" }),
  ),
  currencyOptions: prop<Frozen<readonly string[]>>(() => frozen(["USD"])),
  rates: prop<Frozen<HelloFruitBtcFiatRates | null>>(() => frozen(null)),
  selectedFruitId: prop<string>(""),
  selectedCurrency: prop<string>("USD"),
  cart: prop<Record<string, number>>(() => ({})),
  order: prop<Frozen<HelloFruitDemoOrder> | null>(null),
  creatingOrder: prop<boolean>(false),
  checkout: prop<CheckoutFlow | null>(null),
  errorMessage: prop<string>(""),
  stickerModal: prop<Frozen<StickerModalState> | null>(null),
}) {
  /** Order ids whose fulfillment reveal already ran (mirrors completedOrderId). */
  private revealedOrderIds = new Set<string>();

  @computed
  get selectedFruit(): HelloFruitFruitPayload | undefined {
    return this.fruits.data.find((fruit) => fruit.id === this.selectedFruitId);
  }

  @computed
  get cartItems(): readonly { fruit: HelloFruitFruitPayload; quantity: number }[] {
    return this.fruits.data
      .map((fruit) => ({ fruit, quantity: this.cart[fruit.id] ?? 0 }))
      .filter((item) => item.quantity > 0);
  }

  @computed
  get cartQuantity(): number {
    return this.cartItems.reduce((total, item) => total + item.quantity, 0);
  }

  @computed
  get mode(): "shop" | "pay" {
    return this.order === null ? "shop" : "pay";
  }

  // ---- hydration & routing ----------------------------------------------------

  @modelAction
  hydrateFromPage(): void {
    const element = document.getElementById("__app_bootstrap");
    if (element?.textContent) {
      const bootstrap = JSON.parse(element.textContent) as ShopBootstrap;
      setOpenReceivePrefix(bootstrap.openreceive_prefix);
      this.fruits = frozen(bootstrap.fruits);
      this.productInfo = frozen(bootstrap.product);
      this.currencyOptions = frozen(bootstrap.currencies);
      const preferred = bootstrap.fruits[1] ?? bootstrap.fruits[0];
      if (preferred !== undefined) this.selectedFruitId = preferred.id;
      if (bootstrap.order !== null) {
        this.enterOrder(bootstrap.order, { rememberUrl: false });
      }
    }
    this.hydrated = true;
    logDemo("app.hydrated", "Workspace hydrated from page bootstrap.", {
      fruitCount: this.fruits.data.length,
      resumedOrderId: this.order?.data.uuid,
    });
  }

  /** popstate / direct navigation: reconcile store state with the URL. */
  @modelFlow
  resumeFromUrl = _async(function* (this: ShopWorkspace) {
    const orderId = parseHelloFruitCheckoutOrderId(globalThis.location.pathname);
    if (orderId === undefined) {
      if (this.order !== null) this.startOver({ preserveUrl: true });
      return;
    }
    if (this.order?.data.uuid === orderId) return;
    logDemo("checkout.resume", "Resuming checkout from URL.", { orderId });
    this.clearError();
    const result = yield* _await(getJsonFromRails(`${ORDERS_URL}/${encodeURIComponent(orderId)}`));
    if (parseHelloFruitCheckoutOrderId(globalThis.location.pathname) !== orderId) return;
    if (!isHelloFruitDemoOrder(result)) {
      logDemo("checkout.resume_miss", "Checkout resume order not found.", { orderId });
      leaveHelloFruitCheckout();
      this.startOver({ preserveUrl: true });
      this.showError("This checkout link is no longer available. Start a new order.");
      return;
    }
    this.enterOrder(result, { rememberUrl: false });
  });

  // ---- shop actions -------------------------------------------------------------

  @modelAction
  selectFruit(fruitId: string): void {
    this.selectedFruitId = fruitId;
    logDemo("fruit.select", "Fruit selected.", { fruitId });
  }

  @modelAction
  setCurrency(currency: string): void {
    logDemo("currency.change", "Currency changed.", { from: this.selectedCurrency, to: currency });
    this.selectedCurrency = currency;
  }

  @modelAction
  addSelectedFruitToCart(): void {
    const fruit = this.selectedFruit;
    if (fruit === undefined) return;
    this.cart[fruit.id] = Math.min((this.cart[fruit.id] ?? 0) + 1, 9);
    logDemo("cart.add", "Adding selected fruit to cart.", {
      fruitId: fruit.id,
      quantity: this.cart[fruit.id],
    });
  }

  @modelAction
  removeFruitFromCart(fruitId: string): void {
    logDemo("cart.remove", "Removing fruit from cart.", { fruitId });
    delete this.cart[fruitId];
  }

  @modelAction
  showError(message: string): void {
    if (message !== "") logDemo("error.show", "Showing browser error message.", { message });
    this.errorMessage = message;
  }

  @modelAction
  clearError(): void {
    this.errorMessage = "";
  }

  /** Clear the soft "still being prepared" conflict once checkout progresses. */
  @modelAction
  clearPreparingConflictError(): void {
    if (this.errorMessage.includes("still being prepared")) this.errorMessage = "";
  }

  @modelAction
  enterOrder(order: HelloFruitDemoOrder, options: { readonly rememberUrl: boolean }): void {
    this.order = frozen(order);
    this.checkout = new CheckoutFlow({ orderId: order.uuid });
    if (options.rememberUrl) {
      rememberHelloFruitOrder(order);
      enterHelloFruitCheckout(order.uuid);
    }
    void this.checkout.prepare();
    if (order.status === "paid" && !this.revealedOrderIds.has(order.uuid)) {
      void this.revealDelivery(order.uuid);
    }
  }

  @modelAction
  startOver(options: { readonly preserveUrl?: boolean } = {}): void {
    logDemo("checkout.start_over", "Resetting demo to shop mode.");
    forgetHelloFruitOrder(this.order?.data.uuid);
    if (options.preserveUrl !== true) leaveHelloFruitCheckout();
    this.order = null;
    this.checkout = null;
    this.cart = {};
    this.closeStickerModal();
    this.clearError();
  }

  // ---- server round-trips --------------------------------------------------------

  @modelFlow
  createOrder = _async(function* (this: ShopWorkspace) {
    this.clearError();
    this.creatingOrder = true;
    this.closeStickerModal();
    try {
      const items = this.cartItems;
      logDemo("prepare_order.request", "Posting prepare order request.", {
        currency: this.selectedCurrency,
        cartLineCount: items.length,
        cartQuantity: this.cartQuantity,
      });
      const response = yield* _await(
        sendToRailsController(
          {
            currency: this.selectedCurrency,
            cart: items.map((item) => ({ product_id: item.fruit.id, quantity: item.quantity })),
          },
          ORDERS_URL,
        ),
      );
      const summary = (response as { summary?: unknown }).summary;
      if (response.success === false || !isHelloFruitDemoOrder(summary)) {
        this.showError(
          typeof response.message === "string" && response.message.length > 0
            ? response.message
            : helloFruitDemoLabels.createOrderError,
        );
        return;
      }
      logDemo("prepare_order.ready", "Order accepted by browser app.", {
        orderId: summary.uuid,
        total: summary.total_amount,
      });
      this.enterOrder(summary, { rememberUrl: true });
    } finally {
      this.creatingOrder = false;
    }
  });

  @modelFlow
  loadRates = _async(function* (this: ShopWorkspace) {
    const body = yield* _await(getJsonFromRails(RATES_URL));
    if (body.success === false || body.rates === undefined) {
      logDemo("rates.error", "Failed to load display exchange rates.", { message: body.message });
      return;
    }
    this.rates = frozen(body.rates as HelloFruitBtcFiatRates);
    logDemo("rates.loaded", "Loaded display exchange rates.");
  });

  /** CheckoutFlow announces settlement here (poll or cable push). */
  onCheckoutSettled(orderId: string): void {
    launchHelloFruitConfetti();
    logDemo("checkout.settled", "Checkout settled — waiting for server fulfillment.", { orderId });
    void this.revealDelivery(orderId);
  }

  /**
   * Poll the host summary until on_paid fulfillment lands (onSettled fires
   * before the server transaction is necessarily visible), then fetch the
   * sticker and show the modal.
   */
  @modelFlow
  revealDelivery = _async(function* (this: ShopWorkspace, orderId: string) {
    if (this.revealedOrderIds.has(orderId)) return;
    this.revealedOrderIds.add(orderId);
    try {
      const paid = yield* _await(waitForHelloFruitPaidSummary({ orderId }));
      if (this.order?.data.uuid !== orderId) return;
      this.setOrder(paid);
      logDemo("fulfillment.summary_paid", "Server marked order paid; loading delivery.", {
        orderId,
        itemCount: paid.items.length,
      });
      const stickers = yield* _await(fetchHelloFruitPurchasedStickers(paid));
      if (stickers.length === 0) return;
      this.openStickerModal({ orderId, stickers });
    } catch (cause) {
      this.revealedOrderIds.delete(orderId);
      this.showError(cause instanceof Error ? cause.message : String(cause));
    }
  });

  @modelAction
  setOrder(order: HelloFruitDemoOrder): void {
    this.order = frozen(order);
  }

  /** Cable sink: the worker/on_paid broadcast an order update. */
  @modelAction
  applyOrderUpdate(order: HelloFruitDemoOrder): void {
    if (this.order?.data.uuid !== order.uuid) return;
    this.order = frozen(order);
    if (order.status === "paid") {
      // Refresh the checkout pane immediately instead of waiting a poll interval.
      this.checkout?.wakeFromServerPush();
      if (!this.revealedOrderIds.has(order.uuid)) void this.revealDelivery(order.uuid);
    }
  }

  @modelAction
  private openStickerModal(state: StickerModalState): void {
    this.closeStickerModal();
    logDemo("sticker_modal.show", "Showing sticker download modal.", {
      productIds: state.stickers.map((sticker) => sticker.productId),
    });
    this.stickerModal = frozen(state);
  }

  @modelAction
  closeStickerModal(): void {
    const current = this.stickerModal?.data;
    if (current !== undefined) {
      logDemo("sticker_modal.close", "Closing sticker download modal.");
      revokeHelloFruitStickers(current.stickers);
    }
    this.stickerModal = null;
  }
}

const createdWorkspace = new ShopWorkspace({});
registerRootStore(createdWorkspace);

/** The default context value IS the singleton — components never render a Provider. */
export const ShopWorkspaceContext = createContext<ShopWorkspace>(createdWorkspace);
