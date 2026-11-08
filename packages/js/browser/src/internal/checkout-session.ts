// The create-mode flow both OpenReceive checkout renderers run: the deferred
// Lightning mint and the swap start, plus the five pieces of state a host needs
// to render them.
//
// It used to be written out once in @openreceive/elements (the element class)
// and once in @openreceive/react (CheckoutCreate + PaymentWizard). They had
// already drifted — React had no in-flight guard on the mint at all, and the
// element's swap-start recovery was not scoped to the asset being started.
// Both bugs are fixed here, in the one copy. See docs/internal/wrapper-parity.md.
//
// Two of those five fields gate a request: `mintingLightning` and
// `startingSwapAsset` are read in return-early conditions, so a second click, a
// poll-driven re-render or an attribute the element wrote itself cannot become
// a second POST. They cover only the IN-FLIGHT window. The already-completed
// window is guarded off state that outlives the request instead: ensureLightning
// reuses a bolt11 that still has time on the clock, and startSwap re-shows an
// asset's deposit instructions rather than starting a colliding second attempt.
// The other three fields decide nothing about requests — `wizardError` and
// `swapStartError` are the payer-facing strings the catch paths set, and
// `lightningRequested` is a render flag (create mode defers the QR until the
// payer asks for it).
//
// What is NOT here, deliberately: rendering, and how a new snapshot reaches the
// screen. The element publishes by writing its own attributes and rebuilding a
// shadow tree; React publishes with setState and hands a started swap attempt
// up to whichever component owns the snapshot. That difference is the whole
// reason there are two renderers, so it stays an injected callback rather than
// a branch in here.

import { recordOrEmpty } from "@openreceive/core";
import {
  findReusableLightningInvoice,
  mergeAttemptIntoSnapshot,
  mergeMintedCheckout,
} from "./checkout-merge.ts";
import { emitBrowserLog } from "./checkout-log.ts";
import { checkoutLabels } from "./labels.ts";
import { postJson, startSwapRequest } from "./swap-http.ts";
import type {
  BrowserLoggerOption,
  CheckoutInvoiceSnapshot,
  CheckoutPaymentMethod,
  CheckoutSnapshot,
} from "./ui.ts";

/**
 * The swap attempt the wizard is showing. It stays host state — the element's
 * breadcrumb, refund draft and deposit panel read it, and React's wizard keeps
 * it in `useState` — so the session reaches it through accessors instead of
 * owning a second copy that could disagree.
 */
export interface SwapSelection {
  started(): CheckoutInvoiceSnapshot | undefined;
  setStarted(invoice: CheckoutInvoiceSnapshot): void;
  dismissedInvoiceId(): string | null;
  setDismissedInvoiceId(invoiceId: string | null): void;
  setSelectedAsset(payInAsset: string | null): void;
}

/**
 * Everything {@link CheckoutSession.startSwap} needs, as ONE option.
 *
 * These three used to be three optional fields beside each other
 * (`swapSelection`, `swapPrefix`, `fetch`), which let a host supply two of them
 * and get silence: `startSwap` returned at its first `undefined` without a
 * throw, an `onError` or a state change, so the payer clicked Continue and the
 * screen did not move. They are only ever useful as a set, so they are one
 * field now and the mistake is no longer representable — a host either drives
 * swaps or it does not.
 */
export interface CheckoutSwapOptions {
  /** The swap attempt the wizard is showing, over the host's own state. */
  selection: SwapSelection;
  /**
   * The mount prefix swap routes are derived from. May still answer
   * `undefined` — a standalone wizard has no prefix until its host has one —
   * and a start attempted before then is reported through `onError` rather
   * than swallowed.
   */
  prefix(): string | undefined;
  /** Read at call time so a host that swaps `globalThis.fetch` is honoured. */
  fetch(): typeof globalThis.fetch | undefined;
  /**
   * Header name the page's `<meta name="csrf-token">` is sent under on the
   * quote and start calls. Read at call time like the two above; `undefined`
   * means the default, `X-CSRF-Token`.
   */
  csrfHeader?(): string | undefined;
  /**
   * Publish a freshly started swap attempt. The two hosts fold it into their
   * snapshot differently (the element re-keys its poll controller onto the
   * merged snapshot; React hands the attempt to whichever component owns the
   * snapshot), so the merge stays on the host side of this callback.
   */
  onStarted?(invoice: CheckoutInvoiceSnapshot): void;
}

export interface CheckoutSessionOptions {
  /**
   * The snapshot the host is rendering right now, read at call time — the
   * element's changes under it on every poll.
   */
  snapshot(): CheckoutSnapshot | undefined;
  /** The order being paid, read at call time (the element's is an attribute). */
  reference(): string | undefined;
  /** Endpoint is part of checkout identity; trailing slashes are equivalent. */
  prefix?(): string | undefined;
  /**
   * Mint a Lightning invoice for this reference (POST `${prefix}/checkouts`).
   * The host closes over its own prefix, metadata and fetch. Answer `undefined`
   * to say "this host cannot mint" — React's payment wizard is such a host: it
   * asks its parent for Lightning through `onRequestLightning` instead.
   */
  requestCheckout?(reference: string, signal?: AbortSignal): Promise<CheckoutSnapshot> | undefined;
  /** Publish a snapshot that now carries the Lightning attempt. */
  onSnapshot?(snapshot: CheckoutSnapshot): void;
  /**
   * Swap support, all of it or none of it. Omit for a Lightning-only host:
   * {@link CheckoutSession.startSwap} then reports through `onError` instead
   * of doing nothing.
   */
  swap?: CheckoutSwapOptions;
  logger?: BrowserLoggerOption;
  /** The host's error surface: a DOM `openreceive:error` event, or `onError`. */
  onError(error: unknown): void;
  /** Session state changed — re-render. */
  onChange(): void;
}

export interface CheckoutSession {
  /** Lightning mint failure, shown inline in the wizard by the element. */
  readonly wizardError: string | undefined;
  /** Swap-start failure, shown inline in the deposit slot with a retry button. */
  readonly swapStartError: string | undefined;
  /** Create mode: the Lightning QR is deferred until the payer asks for it. */
  readonly lightningRequested: boolean;
  /** True while a mint is in flight — the guard, and the spinner. */
  readonly mintingLightning: boolean;
  /** In-flight swap create; a second click must not mint a colliding attempt. */
  readonly startingSwapAsset: string | null;
  /**
   * Quotes observed for each pay-in asset, keyed by `pay_in_asset`. An entry
   * with `available: false` is why `startSwap` stopped before starting, and
   * carries the accepted range the host renders in its unavailable panel.
   */
  readonly swapQuotes: Readonly<Record<string, CheckoutPaymentMethod>>;
  /** Invalidate every outstanding action when identity changes. */
  syncIdentity(): void;
  reset(): void;
  dispose(): void;
  capture(): { readonly signal: AbortSignal; isCurrent(): boolean };
  ensureLightning(): Promise<void>;
  /**
   * Quote the pay-in asset, then start the swap when the quote confirms the
   * amount is in range. Both steps live HERE so the element and React behave
   * identically: an out-of-range amount is an unavailable quote in
   * {@link swapQuotes}, not a generic swap-start error.
   */
  startSwap(payInAsset: string): Promise<void>;
  /** A new order is being prepared: Lightning is deferred again. */
  resetLightningRequest(): void;
  /** The payer left the focused swap flow, so the failure they left goes too. */
  clearSwapStartError(): void;
}

const SWAP_START_FAILED = "Could not prepare the payment address. Please try again.";
const MISSING_SWAP_OPTIONS =
  "startSwap needs the session's `swap` options (selection, prefix, fetch) — this session was " +
  "created without them, so it cannot start a swap. See docs/guides/headless-checkout.md.";
const MISSING_SWAP_WIRING = "startSwap cannot start a swap: the session was given no";
const MINT_FAILED = "Could not create the Lightning invoice. Please try again.";

/**
 * A swap-quote body keyed by its pay-in asset. The route echoes the asset as
 * `pay_asset`; the checkout grid keys methods by `pay_in_asset`, so the alias
 * is resolved once, here.
 */
function normalizeSwapQuote(body: unknown): CheckoutPaymentMethod | undefined {
  const quote = recordOrEmpty(recordOrEmpty(body).quote ?? body);
  const payInAsset = quote.pay_in_asset ?? quote.pay_asset;
  return typeof payInAsset === "string"
    ? ({ ...quote, pay_in_asset: payInAsset } as unknown as CheckoutPaymentMethod)
    : undefined;
}

/**
 * Server sentences written for the payer, kept word for word. Every engine
 * (Node, Python, PHP, Ruby) sends these exact strings, and the shop plugins
 * add the one security-token refusal; a sentence missing here only costs the
 * payer its precision, never shows them developer text.
 */
const PAYER_WRITTEN_SERVER_MESSAGES: ReadonlySet<string> = new Set([
  // INTERNAL 503, retryable: the price feed could not price the order.
  "Exchange rates are temporarily unavailable — please try again in a moment.",
  // INTERNAL 502/503: the swap provider's own failures (http-golden 25, 26).
  "The swap provider refused this request.",
  "The swap provider is rate limited. Please try again shortly.",
  "The swap provider is temporarily unreachable. Please try again shortly.",
  // FORBIDDEN 403 from the PrestaShop and FOSSBilling endpoints: a stale page.
  "The page's security token is missing or old. Reload the page and try again.",
]);

/**
 * Where {@link payerErrorMessage} logs a reworded failure: the request that
 * failed (`checkout.prepare`, `checkout.create`, `swap.start`) and the
 * checkout's logger (omitted means the default console logger, `false` none).
 */
interface PayerErrorReport {
  readonly action: string;
  readonly logger?: BrowserLoggerOption;
}

/**
 * What a payer reads for a failed request.
 *
 * Most server text is written for the shop's developer — "Not authorized for
 * this action. The application's authorize hook denied it; …", "payment_hash
 * is required.", "The selected payment attempt is not a reusable pending
 * checkout." — and the wallet's for its operator ("Configured NWC relays are
 * unavailable."). The payer gets one sentence per kind of failure instead,
 * picked by the error's code and HTTP status:
 *
 * - `WALLET_UNAVAILABLE`, `TIMEOUT` (and a plugin's `UNAVAILABLE`), a
 *   retryable 5xx, a proxy's code-less 502/503/504: the payment service did
 *   not answer, try again.
 * - Any other 5xx: something went wrong, try again.
 * - `FORBIDDEN` / `UNAUTHORIZED` / 401 / 403: only the browser or account that
 *   placed the order can open it; reload if that is this one.
 * - `NOT_FOUND` / 404: the order could not be found.
 * - `CONFLICT` / 409: the payment changed; reload and try again.
 * - `RATE_LIMITED` / 429: the server's text, which is payer-facing by contract
 *   and host-configurable (docs/guides/rate-limiting.md).
 * - `INVALID_REQUEST` and anything else: something went wrong, try again.
 * - No code and no status (a network failure, a client-side check): `fallback`.
 *
 * The few sentences the engines write for the payer ("Exchange rates are
 * temporarily unavailable — …", the swap provider's) are kept as they are.
 * The original error is untouched: hosts get it through `onError` /
 * `openreceive-error`, and with `report` a reworded failure also logs one
 * `checkout.error.reworded` warning with the server's code, status and text.
 */
export function payerErrorMessage(
  error: unknown,
  fallback: string,
  report?: PayerErrorReport,
): string {
  const sentence = payerSentence(error, fallback);
  if (report !== undefined) logRewordedError(error, sentence, report);
  return sentence;
}

function payerSentence(error: unknown, fallback: string): string {
  const { code, status, retryable } = (error ?? {}) as {
    code?: unknown;
    status?: unknown;
    retryable?: unknown;
  };
  const errorCode = typeof code === "string" && code.length > 0 ? code : undefined;
  const httpStatus = typeof status === "number" ? status : undefined;
  const message = error instanceof Error ? error.message.trim() : "";
  if (
    errorCode === "WALLET_UNAVAILABLE" ||
    errorCode === "TIMEOUT" ||
    errorCode === "UNAVAILABLE"
  ) {
    return checkoutLabels.paymentServiceUnavailable;
  }
  // Not a server's answer at all: fetch could not reach it, or a check in this
  // browser refused first. The caller's sentence names what was being done.
  if (errorCode === undefined && httpStatus === undefined) {
    return fallback;
  }
  if (PAYER_WRITTEN_SERVER_MESSAGES.has(message)) return message;
  if (httpStatus !== undefined && httpStatus >= 500) {
    const gateway = errorCode === undefined && httpStatus >= 502 && httpStatus <= 504;
    return retryable === true || gateway
      ? checkoutLabels.paymentServiceUnavailable
      : checkoutLabels.paymentRequestFailed;
  }
  if (
    errorCode === "FORBIDDEN" ||
    errorCode === "UNAUTHORIZED" ||
    httpStatus === 401 ||
    httpStatus === 403
  ) {
    return checkoutLabels.paymentNotYours;
  }
  if (errorCode === "NOT_FOUND" || httpStatus === 404) return checkoutLabels.orderNotFound;
  if (errorCode === "CONFLICT" || httpStatus === 409) return checkoutLabels.paymentChanged;
  if (errorCode === "RATE_LIMITED" && message.length > 0) return message;
  return checkoutLabels.paymentRequestFailed;
}

/**
 * The developer's copy of a failure the payer read in other words. Without it
 * the authorize-hook hint, which used to be on the screen, reached a host that
 * wired no `onError` only through the network panel.
 */
function logRewordedError(error: unknown, sentence: string, report: PayerErrorReport): void {
  const message = error instanceof Error ? error.message : "";
  if (message.length === 0 || message.trim() === sentence) return;
  const { code, status } = error as { code?: unknown; status?: unknown };
  emitBrowserLog(
    report.logger,
    "warn",
    "checkout.error.reworded",
    "A failed checkout request was shown to the payer in other words; error_message is the original.",
    {
      action: report.action,
      ...(typeof status === "number" ? { status } : {}),
      ...(typeof code === "string" ? { error_code: code } : {}),
      error_message: message,
      payer_message: sentence,
    },
  );
}

export function createCheckoutSession(options: CheckoutSessionOptions): CheckoutSession {
  let wizardError: string | undefined;
  let swapStartError: string | undefined;
  let lightningRequested = false;
  let mintingLightning = false;
  let startingSwapAsset: string | null = null;
  let swapQuotes: Record<string, CheckoutPaymentMethod> = {};
  let generation = 0;
  let abort = new AbortController();
  const identityKey = () =>
    JSON.stringify([
      options.reference(),
      (options.prefix?.() ?? options.swap?.prefix() ?? "").replace(/\/+$/, ""),
    ]);
  let identity = identityKey();
  function invalidateActions(): void {
    abort.abort();
    abort = new AbortController();
    generation += 1;
    mintingLightning = false;
    startingSwapAsset = null;
  }
  function reset(): void {
    invalidateActions();
    identity = identityKey();
    wizardError = undefined;
    swapStartError = undefined;
    lightningRequested = false;
    mintingLightning = false;
    startingSwapAsset = null;
    swapQuotes = {};
  }
  function syncIdentity(): void {
    if (identityKey() !== identity) reset();
  }
  function capture() {
    syncIdentity();
    const captured = generation;
    return {
      signal: abort.signal,
      isCurrent: () => captured === generation && identityKey() === identity,
    };
  }

  async function ensureLightning(): Promise<void> {
    const action = capture();
    // A second click while the first mint is in flight would POST /checkouts
    // again; the loser's 409 then surfaced as a wizard error over a perfectly
    // good invoice. `startSwap` guards the same way.
    if (mintingLightning) return;
    const reference = options.reference();
    if (reference === undefined || reference.length === 0) return;
    const current = options.snapshot();
    if (current !== undefined) {
      // Reuse a bolt11 that still has enough time on the clock rather than
      // minting a second attempt for the same reference. Pinned on both hosts:
      // "re-selecting Bitcoin after the mint reuses the bolt11 …" in
      // tests/element-lifecycle.test.mjs and tests/react-checkout-behavior.test.mjs.
      const reusableLightning = findReusableLightningInvoice(current);
      if (reusableLightning !== undefined) {
        lightningRequested = true;
        options.onSnapshot?.(mergeAttemptIntoSnapshot(reusableLightning, current));
        // Same as every other state mutation here: `lightningRequested` is a
        // render flag, so the host has to be told to re-render for it.
        options.onChange();
        return;
      }
    }
    mintingLightning = true;
    wizardError = undefined;
    options.onChange();
    try {
      const pending = options.requestCheckout?.(reference, action.signal);
      if (pending === undefined) return;
      const checkout = await pending;
      if (!action.isCurrent()) return;
      lightningRequested = true;
      // The mint response does not carry the warmed method catalog, so the
      // merge keeps `payment_methods` and the sibling attempts from the
      // snapshot that was already on screen.
      options.onSnapshot?.(mergeMintedCheckout(checkout, options.snapshot()));
    } catch (error) {
      if (!action.isCurrent()) return;
      // Surface the mint failure inline instead of silently returning to the
      // method picker.
      wizardError = payerErrorMessage(error, MINT_FAILED, {
        action: "checkout.create",
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      });
      options.onError(error);
    } finally {
      if (action.isCurrent()) {
        mintingLightning = false;
        options.onChange();
      }
    }
  }

  async function startSwap(payInAsset: string): Promise<void> {
    const action = capture();
    // The same double-POST guard as the mint: a poll-driven re-render hands the
    // payer a fresh, enabled button while the first start is still in flight.
    if (startingSwapAsset !== null) return;
    const swap = options.swap;
    if (swap === undefined) {
      options.onError(new Error(MISSING_SWAP_OPTIONS));
      return;
    }
    const selection = swap.selection;
    const prefix = swap.prefix();
    const fetcher = swap.fetch();
    const csrfHeader = swap.csrfHeader?.();
    const reference = options.reference();
    // A start that cannot be made is a WIRING mistake, and silence about it is
    // what this used to be: the payer clicked Continue, nothing was requested,
    // and nothing said why. Report it on the host's own error surface.
    if (prefix === undefined || fetcher === undefined) {
      const missing = [
        ...(prefix === undefined ? ["swap.prefix()"] : []),
        ...(fetcher === undefined ? ["swap.fetch()"] : []),
      ];
      options.onError(new Error(`${MISSING_SWAP_WIRING} ${missing.join(" and ")}.`));
      return;
    }
    // Not an error, unlike the two above: no reference yet is a moment in the
    // lifecycle (the checkout has not been prepared), not a host that wired the
    // session wrong. It resolves itself on the next render.
    if (reference === undefined || reference.length === 0) return;
    // Already holding this asset's deposit instructions: show them again rather
    // than mint a colliding second attempt. Pinned on both hosts:
    // "re-selecting a started swap asset re-opens its panel without a second
    // start" in tests/element-lifecycle.test.mjs, and "the session refuses a
    // second start for an asset it already holds instructions for" in
    // tests/react-checkout-behavior.test.mjs.
    const alreadyStarted = selection.started();
    if (
      alreadyStarted?.swap?.pay_in_asset === payInAsset &&
      alreadyStarted.invoice_id !== selection.dismissedInvoiceId()
    ) {
      selection.setSelectedAsset(payInAsset);
      options.onChange();
      return;
    }
    startingSwapAsset = payInAsset;
    swapStartError = undefined;
    options.onChange();

    try {
      // Quote FIRST. An amount outside the provider's range is a normal answer,
      // not a failure: it becomes an unavailable entry in `swapQuotes` and the
      // host shows its accepted range, rather than a generic start error.
      const quote = await quoteSwapAsset(
        payInAsset,
        prefix,
        fetcher,
        reference,
        csrfHeader,
        action,
      );
      if (!action.isCurrent()) return;
      if (quote !== undefined && quote.available === false) return;
      const started = await startSwapRequest({
        signal: action.signal,
        fetch: fetcher,
        prefix,
        ...(csrfHeader === undefined ? {} : { csrfHeader }),
        reference,
        payInAsset,
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      });
      if (!action.isCurrent()) return;
      selection.setStarted(started);
      selection.setDismissedInvoiceId(null);
      // Publish the attempt we just got back, never a read-back of the
      // selection: a React host's setter does not land until its next render,
      // so reading it here would republish the PREVIOUS attempt.
      //
      // Publishing re-keys the status poll onto the swap attempt: without it the
      // poller kept the pre-swap snapshot (create mode never polled at all;
      // snapshot mode polled the old Lightning hash, which the handler 404s) and
      // a paid swap customer was told "Invoice expired".
      swap.onStarted?.(started);
      selection.setSelectedAsset(payInAsset);
      options.onChange();
    } catch (error) {
      if (!action.isCurrent()) return;
      // A start that lost a race to instructions which already landed for THIS
      // asset must not replace the deposit panel with the loser's error — the
      // status poll can fold a server-side idempotent attempt in mid-request.
      // Scoped to the asset, and to an attempt the payer has not dismissed:
      // unscoped, a failed USDT start silently reopened ETH's panel and ate the
      // error.
      const landed = selection.started();
      if (
        landed?.swap?.pay_in_asset === payInAsset &&
        landed.invoice_id !== selection.dismissedInvoiceId()
      ) {
        selection.setSelectedAsset(payInAsset);
        options.onChange();
        return;
      }
      // Inline error with retry — never an infinite "Preparing payment
      // address…" spinner (the retry button re-triggers this swap start).
      selection.setSelectedAsset(payInAsset);
      failSwapStart(error);
    } finally {
      if (action.isCurrent()) {
        startingSwapAsset = null;
        options.onChange();
      }
    }
  }

  /**
   * POST the swap quote for one pay-in asset and remember the answer.
   * `undefined` means the server sent a body this reader cannot key by asset,
   * which is treated as "no opinion" and lets the start proceed.
   */
  async function quoteSwapAsset(
    payInAsset: string,
    prefix: string,
    fetcher: typeof globalThis.fetch,
    reference: string,
    csrfHeader: string | undefined,
    action: ReturnType<typeof capture>,
  ): Promise<CheckoutPaymentMethod | undefined> {
    const body = await postJson({
      signal: action.signal,
      fetch: fetcher,
      prefix,
      ...(csrfHeader === undefined ? {} : { csrfHeader }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      body: { reference, action: "swap_quote", pay_in_asset: payInAsset },
    });
    if (!action.isCurrent()) return undefined;
    const quote = normalizeSwapQuote(body);
    if (quote === undefined) return undefined;
    swapQuotes = { ...swapQuotes, [quote.pay_in_asset]: quote };
    return quote;
  }

  function failSwapStart(error: unknown): void {
    swapStartError = payerErrorMessage(error, SWAP_START_FAILED, {
      action: "swap.start",
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
    options.onError(error);
    options.onChange();
  }

  return {
    get wizardError() {
      return wizardError;
    },
    get swapStartError() {
      return swapStartError;
    },
    get lightningRequested() {
      return lightningRequested;
    },
    get mintingLightning() {
      return mintingLightning;
    },
    get startingSwapAsset() {
      return startingSwapAsset;
    },
    get swapQuotes() {
      return swapQuotes;
    },
    syncIdentity,
    reset,
    dispose: reset,
    capture,
    ensureLightning,
    startSwap,
    resetLightningRequest() {
      reset();
    },
    clearSwapStartError() {
      // Leaving a panel also withdraws its pending quote/create/refund action.
      // A delayed success must not reselect the asset the payer just dismissed.
      invalidateActions();
      swapStartError = undefined;
    },
  };
}
