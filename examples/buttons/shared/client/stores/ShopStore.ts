import { computed } from "mobx";
import { Model, model, modelAction, prop } from "mobx-keystone";
import {
  SHOP_ORDERS_PATH,
  type ShopBootstrap,
  type ShopCatalogEntry,
  type ShopOrderPayload,
  shopOrderPath,
} from "../../shop-types.ts";
import { getJson, postJson } from "../../http.ts";
import { RecentOrders } from "./RecentOrders.ts";
import { ShopCheckout } from "./ShopCheckout.ts";

export type ShopStage = "catalog" | "checkout" | "receipt";

/**
 * Which tab the panel is showing.
 *
 * Deliberately NOT a fourth `stage` value: the checkout must keep polling while
 * the payer reads the order history, and a fourth stage would unmount it.
 */
export type ShopTab = "shop" | "orders";

const PAID = "paid";

@model("or/ShopOrderItem")
export class ShopOrderItem extends Model({
  sku: prop<string>(""),
  name: prop<string>(""),
  quantity: prop<number>(1),
  unitPriceCents: prop<number>(0),
  // Written by the server only once the order is paid. The SPA renders a
  // download button from this and nothing else — the browser never decides that
  // an order was fulfilled.
  downloadPath: prop<string | null>(null),
}) {
  @computed
  get lineTotalCents() {
    return this.unitPriceCents * this.quantity;
  }
}

/**
 * The shop, as one store.
 *
 * The `@model("or/…")` string is a GLOBAL registry key. Registering the same
 * name twice throws at import time, which in a bundle means a blank page and
 * one console line — so one registry per page, and a page that mounted the shop
 * twice would collide.
 */
@model("or/ShopStore")
export class ShopStore extends Model({
  stage: prop<ShopStage>("catalog"),
  tab: prop<ShopTab>("shop"),
  maxPerSku: prop<number>(10),
  // sku -> quantity. The cart is a CLAIM; the price attached to it on the
  // server comes from the shop_products table and never from here. It lives in
  // memory only and is lost on refresh — persisting it is easy with a user row
  // and adds a write path to every quantity click, so it is out of scope.
  quantities: prop<Record<string, number>>(() => ({})),

  orderReference: prop<string>(""),
  orderState: prop<string>(""),
  orderDescription: prop<string>(""),
  orderTotalCents: prop<number>(0),
  orderItems: prop<ShopOrderItem[]>(() => []),

  // This visitor's PUBLIC uuid, from the bootstrap payload. The feed carries no
  // per-visitor field — that would make one public, cacheable response
  // per-visitor — so the "You" badge is drawn here by comparing the two.
  visitorRef: prop<string>(""),

  placingOrder: prop<boolean>(false),
  settling: prop<boolean>(false),
  errorMessage: prop<string>(""),

  // Child models are props with FACTORY defaults. A shared literal default
  // would be one object shared by every instance.
  checkout: prop<ShopCheckout>(() => new ShopCheckout({})),
  feed: prop<RecentOrders>(() => new RecentOrders({})),
}) {
  // A plain instance field, not a prop: fixed server data, assigned once at
  // hydration and never edited, so nothing needs to observe it. Making it a
  // prop would put the whole catalog into every snapshot for no benefit.
  catalog: ShopCatalogEntry[] = [];

  @modelAction
  hydrate(bootstrap: ShopBootstrap) {
    this.catalog = bootstrap.catalog ?? [];
    this.maxPerSku = bootstrap.max_per_sku ?? 10;
    this.visitorRef = bootstrap.visitor?.public_ref ?? "";
    this.checkout.prefix = bootstrap.openreceive_prefix || "/openreceive";
  }

  // --------------------------------------------------------------- the cart

  quantityOf(sku: string): number {
    return this.quantities[sku] ?? 0;
  }

  @computed
  get lines() {
    return this.catalog
      .map((entry) => ({ entry, quantity: this.quantityOf(entry.sku) }))
      .filter((line) => line.quantity > 0);
  }

  @computed
  get itemCount(): number {
    return this.lines.reduce((total, line) => total + line.quantity, 0);
  }

  @computed
  get totalCents(): number {
    return this.lines.reduce((total, line) => total + line.entry.price_cents * line.quantity, 0);
  }

  @modelAction
  setQuantity(sku: string, quantity: number) {
    const clamped = Math.max(0, Math.min(Math.trunc(quantity), this.maxPerSku));
    const next = { ...this.quantities };
    if (clamped === 0) delete next[sku];
    else next[sku] = clamped;
    this.quantities = next;
    this.errorMessage = "";
  }

  // Plain arrow methods, no decorator: orchestration that calls actions.
  add = (sku: string) => this.setQuantity(sku, this.quantityOf(sku) + 1);
  remove = (sku: string) => this.setQuantity(sku, this.quantityOf(sku) - 1);

  @modelAction
  clearCart() {
    this.quantities = {};
  }

  // ---------------------------------------------------------------- the tab

  setTab = (tab: ShopTab) => {
    this.applyTab(tab);
    if (tab === "orders") this.feed.start();
    else this.feed.stop();
  };

  @modelAction
  private applyTab(tab: ShopTab) {
    this.tab = tab;
  }

  // -------------------------------------------------------------- the order

  // One cart becomes one order becomes one reference, minted here and held for
  // the life of this checkout. Never re-minted on a retry: a fresh id per
  // attempt would leave the same cart payable twice.
  //
  // The shape of every async flow in these stores: a plain arrow, a loading
  // flag set before and cleared in `finally` so an exception cannot leave a
  // spinner running, and every state change a call to a small named action.
  placeOrder = async () => {
    if (this.itemCount === 0 || this.placingOrder) return;
    this.setPlacing(true);
    try {
      const order = await postJson<ShopOrderPayload>(SHOP_ORDERS_PATH, {
        items: this.lines.map((line) => ({ sku: line.entry.sku, quantity: line.quantity })),
      });
      this.applyOrder(order);
      // The stage flips and this store's job is done. Which checkout runs is
      // the HOST's choice — that is what ShopPanel's `renderCheckout` seam
      // means — so beginning the keystone checkout belongs to CheckoutStage,
      // the component that uses it, and not here. node-express plugs in the
      // packaged widget and never touches `this.checkout` at all.
      this.setStage("checkout");
    } catch (error) {
      this.setError(error instanceof Error ? error.message : String(error));
    } finally {
      this.setPlacing(false);
    }
  };

  // Settlement is the server's word, not the browser's: the checkout tells us
  // the payment landed, and then we re-read the order to see the downloads the
  // `on_paid` hook unlocked.
  refreshOrder = async (): Promise<boolean> => {
    if (!this.orderReference) return false;
    try {
      const order = await getJson<ShopOrderPayload>(shopOrderPath(this.orderReference));
      this.applyOrder(order);
      return order.state === PAID;
    } catch {
      return false;
    }
  };

  @modelAction
  applyOrder(order: ShopOrderPayload) {
    this.orderReference = order.reference;
    this.orderState = order.state;
    this.orderDescription = order.description;
    this.orderTotalCents = order.total_cents;
    this.orderItems = order.items.map(
      (item) =>
        new ShopOrderItem({
          sku: item.sku,
          name: item.name,
          quantity: item.quantity,
          unitPriceCents: item.unit_price_cents,
          downloadPath: item.download_path,
        }),
    );
  }

  // The checkout tells us the payment settled; the order row tells us the
  // download exists. They are written by the same transaction, but the browser
  // learns about them over two different routes, so this waits for ours.
  awaitFulfillment = async (): Promise<void> => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await this.refreshOrder()) {
        // The payer's own purchase should be at the top of the feed the moment
        // they look, rather than up to two minutes later.
        this.feed.refreshFromPush();
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1500));
    }
  };

  /**
   * Settlement reached us. THE ONE PATH, whatever told us about it: the
   * checkout's own poll noticing `settled`, or the host's realtime transport
   * pushing "order-paid".
   *
   * Idempotent and single-flight, because in practice BOTH will fire — the
   * push wins by a second or two and the poll arrives behind it. Re-reading is
   * the point either way: the browser never learns from a message that it was
   * fulfilled, it learns from the row.
   */
  confirmSettlement = async (): Promise<void> => {
    if (this.settling || this.stage === "receipt" || !this.orderReference) return;
    this.setSettling(true);
    try {
      await this.awaitFulfillment();
      if (this.orderPaid) this.showReceipt();
    } finally {
      this.setSettling(false);
    }
  };

  @computed
  get orderPaid(): boolean {
    return this.orderState === PAID;
  }

  imageFor(sku: string): string {
    return this.catalog.find((entry) => entry.sku === sku)?.image_url ?? "";
  }

  // ------------------------------------------------------------------ stages

  @modelAction
  setStage(stage: ShopStage) {
    this.stage = stage;
    this.errorMessage = "";
  }

  @modelAction
  private setPlacing(value: boolean) {
    this.placingOrder = value;
  }

  @modelAction
  private setSettling(value: boolean) {
    this.settling = value;
  }

  @modelAction
  setError(message: string) {
    this.errorMessage = message;
  }

  showReceipt = () => this.setStage("receipt");

  /** From the receipt: "see it in recent orders", one click. */
  showFeed = () => this.setTab("orders");

  // Back to the shop with a clean slate: the finished order keeps its own
  // reference, so starting again mints a new one rather than reusing it.
  startOver = () => {
    this.checkout.dispose();
    this.resetOrder();
    this.clearCart();
    this.setStage("catalog");
  };

  /** Everything this store started, stopped. Called on panel unmount. */
  dispose = () => {
    this.checkout.dispose();
    this.feed.stop();
  };

  @modelAction
  private resetOrder() {
    this.orderReference = "";
    this.orderState = "";
    this.orderDescription = "";
    this.orderTotalCents = 0;
    this.orderItems = [];
  }
}
