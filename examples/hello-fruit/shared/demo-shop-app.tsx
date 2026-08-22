/**
 * The Hello Fruit host UI shared by the React-based demo clients
 * (node-express and nextjs-fullstack). Browser-safe: imports only client-safe
 * shared modules, so it may be bundled into any demo's client build.
 *
 * The host app owns routing and the checkout renderer; everything else — the
 * shop, cart, order summary, resume flow, fulfillment modal — is identical
 * across demos and lives here exactly once. Hosts plug in:
 *
 *  - `resumeOrderId` + `onEnterCheckout`/`onExitCheckout`: the host's router
 *    (History API in node-express, the Next.js app router in nextjs-fullstack).
 *  - `renderCheckout`: the checkout component the host mounts (plain
 *    `<Checkout>` for Next.js; the framework-tabbed embed for node-express).
 *  - `topContent`: optional host chrome rendered above the product header.
 */

import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CheckoutState } from "@openreceive/browser";
import { ThemeScope, TransactionDetails } from "@openreceive/react";
import {
  forgetHelloFruitOrder,
  loadHelloFruitOrderForResume,
  rememberHelloFruitOrder,
} from "./demo-checkout-resume.ts";
import { readHelloFruitCheckoutCurrencies } from "./demo-currencies.ts";
import {
  fetchHelloFruitPurchasedStickers,
  revokeHelloFruitStickers,
  type HelloFruitPurchasedSticker,
  waitForHelloFruitPaidSummary,
} from "./demo-delivery-client.ts";
import { launchHelloFruitConfetti } from "./demo-confetti.ts";
import {
  formatHelloFruitBuyNowLabel,
  formatHelloFruitFiat,
  helloFruitDemoLabels,
  helloFruitStickerModalCopy,
} from "./demo-formatting.ts";
import type { HelloFruitDemoOrder } from "./demo-order.ts";
import { isHelloFruitDemoOrder } from "./demo-order.ts";
import {
  formatHelloFruitDisplayPrice,
  parseHelloFruitBtcFiatRates,
  toHelloFruitDisplayAmount,
  type HelloFruitBtcFiatRates,
} from "./demo-pricing.ts";

const currencyOptions = readHelloFruitCheckoutCurrencies();

export interface HelloFruitShopFruit {
  readonly id: string;
  readonly name: string;
  readonly sticker: string;
  readonly fiat: {
    readonly currency: string;
    readonly value: string;
  };
}

export interface HelloFruitShopProduct {
  readonly name: string;
  readonly description: string;
}

/** What the host's checkout renderer receives. Mirrors `<Checkout>` props. */
export interface HelloFruitShopCheckoutSlotProps {
  readonly orderId: string;
  readonly routeOrderId?: string;
  readonly onError: (error: unknown) => void;
  readonly onSettled: () => void;
  readonly onState: (state: CheckoutState) => void;
  readonly onStartOver: () => void;
}

export type HelloFruitShopLogger = (
  event: string,
  message: string,
  fields?: Record<string, unknown>,
) => void;

export interface HelloFruitShopAppProps {
  readonly logDemo: HelloFruitShopLogger;
  readonly product: HelloFruitShopProduct;
  readonly fruits: readonly HelloFruitShopFruit[];
  /** Current checkout order id from the host's router; undefined on the shop. */
  readonly resumeOrderId?: string;
  /** Navigate into `/checkout/:orderId` after the host order is created. */
  readonly onEnterCheckout: (orderId: string) => void;
  /** Navigate back to the shop. `replace` is set when a resume link is dead. */
  readonly onExitCheckout: (options?: { readonly replace?: boolean }) => void;
  /** The checkout component this host mounts once an order exists. */
  readonly renderCheckout: (slot: HelloFruitShopCheckoutSlotProps) => React.ReactElement;
  /** Optional host chrome (e.g. framework tabs) above the product header. */
  readonly topContent?: React.ReactNode;
}

interface PrepareOrderResponse {
  readonly order_id: string;
  readonly summary?: HelloFruitDemoOrder;
}

export function HelloFruitShopApp(props: HelloFruitShopAppProps): React.ReactElement {
  const { logDemo, product, fruits, resumeOrderId, renderCheckout, topContent } = props;
  const initialFruitId = fruits[1]?.id ?? fruits[0]?.id ?? "";
  const [fruitId, setFruitId] = useState(initialFruitId);
  const [currency, setCurrency] = useState("USD");
  const [rates, setRates] = useState<HelloFruitBtcFiatRates | undefined>(undefined);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [order, setOrder] = useState<HelloFruitDemoOrder | undefined>(undefined);
  const [purchasedStickers, setPurchasedStickers] = useState<readonly HelloFruitPurchasedSticker[]>(
    [],
  );
  const [stickerModalOpen, setStickerModalOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [settledCheckoutState, setSettledCheckoutState] = useState<CheckoutState | null>(null);
  const [resuming, setResuming] = useState(() => Boolean(resumeOrderId));
  const [resumeError, setResumeError] = useState<string | null>(null);
  const displayError = error === "" ? (resumeError ?? "") : error;

  // Refs so the stable checkout-slot callbacks below always read fresh values
  // without remounting the host's embedded checkout on every render.
  const logDemoRef = useRef(logDemo);
  logDemoRef.current = logDemo;
  const orderRef = useRef(order);
  orderRef.current = order;
  const resumeOrderIdRef = useRef(resumeOrderId);
  resumeOrderIdRef.current = resumeOrderId;
  const onEnterCheckoutRef = useRef(props.onEnterCheckout);
  onEnterCheckoutRef.current = props.onEnterCheckout;
  const onExitCheckoutRef = useRef(props.onExitCheckout);
  onExitCheckoutRef.current = props.onExitCheckout;

  const onCheckoutState = useCallback((state: CheckoutState): void => {
    if (state.settled) setSettledCheckoutState(state);
    // Soft swap-preparing conflicts are not sticky once checkout is progressing again.
    setError((current) => (current.includes("still being prepared") ? "" : current));
  }, []);

  const closeStickerModal = useCallback((): void => {
    setStickerModalOpen(false);
    setPurchasedStickers((current) => {
      revokeHelloFruitStickers(current);
      return [];
    });
  }, []);

  /** onSettled is a display hint — wait for server onPaid to mark the summary paid. */
  const revealFulfilledDelivery = useCallback(async (orderId: string): Promise<void> => {
    const paid = await waitForHelloFruitPaidSummary({ orderId });
    logDemoRef.current("fulfillment.summary_paid", "Server marked order paid; loading delivery.", {
      orderId,
      itemCount: paid.items.length,
    });
    setOrder(paid);
    const stickers = await fetchHelloFruitPurchasedStickers(paid);
    setPurchasedStickers((current) => {
      revokeHelloFruitStickers(current);
      return stickers;
    });
    setStickerModalOpen(true);
  }, []);

  const onSettled = useCallback((): void => {
    const orderId = orderRef.current?.uuid ?? resumeOrderIdRef.current;
    launchHelloFruitConfetti();
    logDemoRef.current(
      "checkout.settled",
      "Checkout settled callback received — waiting for server fulfillment.",
      {
        orderId,
        purchasedItemCount: orderRef.current?.items.length ?? 0,
      },
    );
    if (orderId === undefined) return;
    void revealFulfilledDelivery(orderId).catch((cause: unknown) => {
      logDemoRef.current("fulfillment.error", "Failed to load server fulfillment.", {
        orderId,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [revealFulfilledDelivery]);

  const onCheckoutError = useCallback((cause: unknown): void => {
    logDemoRef.current("checkout.error", "Checkout component reported an error.", {
      error: cause instanceof Error ? cause.message : String(cause),
    });
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);

  const resetCheckoutResume = useCallback((): void => {
    setSettledCheckoutState(null);
    setResumeError(null);
    setResuming(false);
  }, []);

  // React to host route changes (e.g. back/forward): leaving checkout clears
  // the order; switching to a different order clears the stale one before the
  // resume effect below loads the new summary.
  useEffect(() => {
    if (resumeOrderId === undefined) {
      setOrder(undefined);
      setResuming(false);
      return;
    }
    setOrder((current) =>
      current !== undefined && current.uuid !== resumeOrderId ? undefined : current,
    );
  }, [resumeOrderId]);

  useEffect(() => {
    if (resumeOrderId === undefined || order?.uuid === resumeOrderId) return;
    let cancelled = false;
    setResuming(true);
    void loadHelloFruitOrderForResume(resumeOrderId).then((summary) => {
      if (cancelled) return;
      if (summary === undefined) {
        logDemoRef.current("checkout.resume_miss", "Checkout resume order not found.", {
          orderId: resumeOrderId,
        });
        setOrder(undefined);
        setResuming(false);
        setResumeError("Order not found.");
        onExitCheckoutRef.current({ replace: true });
        return;
      }
      logDemoRef.current("checkout.resume", "Resuming checkout from summary.", {
        orderId: summary.uuid,
      });
      setOrder(summary);
      setResuming(false);
      setResumeError(null);
      if (summary.status === "paid") {
        void revealFulfilledDelivery(summary.uuid).catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [resumeOrderId, order?.uuid, revealFulfilledDelivery]);

  const selectedFruit = fruits.find((fruit) => fruit.id === fruitId) ?? fruits[0];
  const createCheckoutLabel =
    selectedFruit === undefined
      ? helloFruitDemoLabels.createOrder
      : formatHelloFruitBuyNowLabel(toHelloFruitDisplayAmount(selectedFruit.fiat, currency, rates));
  const cartItems = fruits
    .map((fruit) => ({ fruit, quantity: cart[fruit.id] ?? 0 }))
    .filter((item) => item.quantity > 0);
  const cartQuantity = cartItems.reduce((total, item) => total + item.quantity, 0);
  const stickerModalCopy = helloFruitStickerModalCopy(purchasedStickers);

  // Mount-only readiness log.
  useEffect(() => {
    logDemoRef.current("app.ready", "Hello Fruit shop app mounted.", {
      fruitCount: fruits.length,
      currencyOptions,
      initialFruitId,
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/rates");
        if (!response.ok) throw new Error(`rates request failed: HTTP ${response.status}`);
        const body = (await response.json()) as { rates?: unknown };
        if (cancelled) return;
        // Parsed, never cast: these rates are read inside render, so an
        // unusable body must leave the state alone and the shop priced in its
        // USD catalog amounts.
        const rates = parseHelloFruitBtcFiatRates(body.rates);
        if (rates === undefined) {
          logDemoRef.current("rates.error", "Rates response carried no usable exchange rates.");
          return;
        }
        setRates(rates);
        logDemoRef.current("rates.loaded", "Loaded display exchange rates.", {
          rateCurrencies: Object.keys(rates.bitcoin),
        });
      } catch (cause: unknown) {
        logDemoRef.current("rates.error", "Failed to load display exchange rates.", {
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function addSelectedFruitToCart(): void {
    if (selectedFruit === undefined) return;
    const nextQuantity = Math.min((cart[selectedFruit.id] ?? 0) + 1, 9);
    logDemo("cart.add", "Adding selected fruit to cart.", {
      fruitId: selectedFruit.id,
      fruitName: selectedFruit.name,
      currency,
      quantity: nextQuantity,
    });
    setCart((current) => ({
      ...current,
      [selectedFruit.id]: Math.min((current[selectedFruit.id] ?? 0) + 1, 9),
    }));
  }

  function removeFruitFromCart(fruitIdToRemove: string): void {
    logDemo("cart.remove", "Removing fruit from cart.", {
      fruitId: fruitIdToRemove,
    });
    setCart((current) => {
      const next = { ...current };
      delete next[fruitIdToRemove];
      return next;
    });
  }

  async function createOrder(): Promise<void> {
    if (cartItems.length === 0) {
      logDemo("prepare_order.skipped", "Prepare order clicked with an empty cart.");
      return;
    }
    const startedAt = Date.now();

    setCreating(true);
    setError("");
    closeStickerModal();
    resetCheckoutResume();

    try {
      logDemo("prepare_order.request", "Posting prepare order request.", {
        currency,
        cartLineCount: cartItems.length,
        cartQuantity,
        productIds: cartItems.map((item) => item.fruit.id),
      });
      // The host creates its own order first. The checkout component then asks
      // the mounted OpenReceive route to mint at the amount resolved from that
      // host row.
      const response = await fetch("/orders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          currency,
          cart: cartItems.map((item) => ({
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
      if (!response.ok || !isPrepareOrderResponse(body) || !isHelloFruitDemoOrder(body.summary)) {
        throw new Error(readErrorMessage(body) ?? helloFruitDemoLabels.createOrderError);
      }

      const preparedOrder = body.summary;
      logDemo("prepare_order.ready", "Order accepted by browser app.", {
        orderId: preparedOrder.uuid,
        orderStatus: preparedOrder.status,
        itemCount: preparedOrder.items.length,
        total: preparedOrder.total_amount,
      });
      rememberHelloFruitOrder(preparedOrder);
      // The host routes into checkout; the summary is restored from the resume
      // storage written above, so both router styles share one code path.
      onEnterCheckoutRef.current(preparedOrder.uuid);
    } catch (cause: unknown) {
      logDemo("prepare_order.error", "Prepare order failed in the browser.", {
        error: cause instanceof Error ? cause.message : String(cause),
        elapsedMs: Date.now() - startedAt,
      });
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  }

  const startOver = useCallback((): void => {
    logDemoRef.current("app.reset", "Resetting the demo state.", {
      hadOrder: orderRef.current !== undefined,
    });
    forgetHelloFruitOrder(orderRef.current?.uuid);
    setFruitId(initialFruitId);
    setCart({});
    setOrder(undefined);
    closeStickerModal();
    resetCheckoutResume();
    setCreating(false);
    setError("");
    onExitCheckoutRef.current();
  }, [initialFruitId, closeStickerModal, resetCheckoutResume]);

  const fruitCardClass = (selected: boolean): string =>
    [
      "card card-border bg-base-100 p-3 grid gap-2 text-left cursor-pointer hover:border-primary",
      selected ? "border-primary ring-2 ring-primary/30" : "",
    ]
      .filter(Boolean)
      .join(" ");

  return (
    <ThemeScope
      as="main"
      className="page min-h-screen grid justify-items-center content-start p-4 md:p-8 gap-3"
      defaultTheme="light"
      themeToggle
      topbarClassName="topbar w-full max-w-5xl flex justify-end"
    >
      <section className="checkout w-full max-w-5xl grid gap-3">
        {topContent}

        <div className="flex gap-3 items-center">
          {selectedFruit === undefined ? null : (
            <img className="w-16 aspect-square" src={`/${selectedFruit.sticker}`} alt="" />
          )}
          <div className="min-w-0">
            <h1 className="text-2xl font-bold leading-tight">{product.name}</h1>
            <p className="text-base-content/70 text-sm">{product.description}</p>
          </div>
        </div>

        {order === undefined && resumeOrderId === undefined ? (
          <>
            <label className="form-control w-full max-w-xs">
              <span className="label-text mb-1">Currency</span>
              <select
                className="select select-bordered w-full"
                value={currency}
                onChange={(event) => {
                  logDemo("currency.change", "Currency changed.", {
                    from: currency,
                    to: event.target.value,
                  });
                  setCurrency(event.target.value);
                }}
              >
                {currencyOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {fruits.map((fruit) => (
                <button
                  className={fruitCardClass(fruit.id === fruitId)}
                  key={fruit.id}
                  onClick={() => {
                    logDemo("fruit.select", "Fruit selected.", {
                      fruitId: fruit.id,
                      fruitName: fruit.name,
                    });
                    setFruitId(fruit.id);
                  }}
                  type="button"
                >
                  <img className="w-full aspect-square" src={`/${fruit.sticker}`} alt="" />
                  <span>{fruit.name}</span>
                  <small className="text-base-content/70">
                    {formatHelloFruitDisplayPrice(fruit.fiat, currency, rates)}
                  </small>
                </button>
              ))}
            </div>

            <button className="btn btn-outline" onClick={addSelectedFruitToCart} type="button">
              {createCheckoutLabel}
            </button>

            {cartItems.length === 0 ? null : (
              <>
                <section
                  className="card card-border bg-base-100 px-3 py-2.5 grid gap-1.5"
                  aria-label="Cart"
                >
                  <div className="flex justify-between items-center text-sm">
                    <strong>Cart</strong>
                    <span>
                      {cartQuantity} item{cartQuantity === 1 ? "" : "s"}
                    </span>
                  </div>
                  {cartItems.map((item) => (
                    <div
                      className="flex justify-between items-center gap-2 text-sm"
                      key={item.fruit.id}
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <img className="w-6 h-6 shrink-0" src={`/${item.fruit.sticker}`} alt="" />
                        {item.fruit.name} ×{item.quantity}
                      </span>
                      <span className="text-base-content/70">
                        {formatHelloFruitDisplayPrice(item.fruit.fiat, currency, rates)}
                      </span>
                      <button
                        className="btn btn-ghost btn-xs"
                        onClick={() => removeFruitFromCart(item.fruit.id)}
                        type="button"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </section>

                <button
                  className="btn btn-outline"
                  disabled={creating}
                  onClick={createOrder}
                  type="button"
                >
                  {creating ? helloFruitDemoLabels.creatingOrder : helloFruitDemoLabels.createOrder}
                </button>
              </>
            )}
          </>
        ) : (
          <>
            {order === undefined ? (
              <p className="text-base-content/70 text-sm">
                {resuming ? "Restoring checkout…" : "Loading order…"}
              </p>
            ) : (
              <section
                className="card card-border bg-base-200 px-3 py-2.5 grid gap-1"
                aria-label="Order"
              >
                <div className="flex justify-between items-baseline gap-3">
                  <strong className="text-sm">Order</strong>
                  <span className="font-semibold">{formatHelloFruitFiat(order.total_amount)}</span>
                </div>
                {order.items.map((item) => (
                  <div
                    className="flex justify-between items-baseline gap-3 text-sm text-base-content/80"
                    key={item.product_id}
                  >
                    <span>
                      {item.name} ×{item.quantity}
                    </span>
                    <span className="text-base-content/60">
                      {formatHelloFruitFiat(item.line_amount)}
                      {order.status === "paid" ? " · Paid" : ""}
                    </span>
                  </div>
                ))}
                <div className="card-actions pt-1">
                  <button
                    className="btn btn-sm btn-outline"
                    disabled={creating}
                    onClick={startOver}
                    type="button"
                  >
                    Start over
                  </button>
                </div>
              </section>
            )}

            {renderCheckout({
              orderId: (order?.uuid ?? resumeOrderId) as string,
              ...(resumeOrderId === undefined ? {} : { routeOrderId: resumeOrderId }),
              onError: onCheckoutError,
              onSettled,
              onState: onCheckoutState,
              onStartOver: startOver,
            })}
          </>
        )}

        {displayError === "" ? null : <p className="alert alert-error">{displayError}</p>}
      </section>
      {purchasedStickers.length === 0 || !stickerModalOpen ? null : (
        <div className="modal modal-open">
          <section
            aria-labelledby="sticker-modal-title"
            aria-modal="true"
            className="modal-box"
            role="dialog"
          >
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 justify-items-center">
              {purchasedStickers.map((sticker) => (
                <img
                  className="w-full max-w-[180px] aspect-square"
                  key={sticker.productId}
                  src={sticker.objectUrl}
                  alt=""
                />
              ))}
            </div>
            <h2 className="text-2xl font-bold" id="sticker-modal-title">
              {stickerModalCopy.title}
            </h2>
            <p>{stickerModalCopy.detail}</p>
            <div className="grid gap-2">
              {purchasedStickers.map((sticker) => (
                <a
                  className="card card-border bg-base-100 flex-row items-center gap-3 p-3 transition-colors hover:border-primary hover:bg-primary/5"
                  download={sticker.filename}
                  href={sticker.objectUrl}
                  key={sticker.productId}
                >
                  <span className="rounded-lg bg-primary/10 p-2 text-primary">
                    <svg
                      aria-hidden="true"
                      className="size-5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      viewBox="0 0 24 24"
                    >
                      <path
                        d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{sticker.name} sticker</span>
                    <span className="block text-sm text-base-content/60">
                      SVG file{sticker.quantity > 1 ? ` · ×${sticker.quantity}` : ""}
                    </span>
                  </span>
                  <span className="btn btn-primary btn-sm">Download</span>
                </a>
              ))}
            </div>
            <TransactionDetails state={settledCheckoutState} />
            <div className="modal-action">
              <button className="btn" onClick={closeStickerModal} type="button">
                Close
              </button>
            </div>
          </section>
        </div>
      )}
    </ThemeScope>
  );
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
