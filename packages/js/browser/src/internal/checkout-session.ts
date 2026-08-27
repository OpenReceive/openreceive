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
  /**
   * Mint a Lightning invoice for this reference (POST `${prefix}/checkouts`).
   * The host closes over its own prefix, metadata and fetch. Answer `undefined`
   * to say "this host cannot mint" — React's payment wizard is such a host: it
   * asks its parent for Lightning through `onRequestLightning` instead.
   */
  requestCheckout?(reference: string): Promise<CheckoutSnapshot> | undefined;
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

/** The server's payer-facing text travels on the thrown error; keep it. */
function payerFacingMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

export function createCheckoutSession(options: CheckoutSessionOptions): CheckoutSession {
  let wizardError: string | undefined;
  let swapStartError: string | undefined;
  let lightningRequested = false;
  let mintingLightning = false;
  let startingSwapAsset: string | null = null;
  let swapQuotes: Record<string, CheckoutPaymentMethod> = {};

  async function ensureLightning(): Promise<void> {
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
      const pending = options.requestCheckout?.(reference);
      if (pending === undefined) return;
      const checkout = await pending;
      lightningRequested = true;
      // The mint response does not carry the warmed method catalog, so the
      // merge keeps `payment_methods` and the sibling attempts from the
      // snapshot that was already on screen.
      options.onSnapshot?.(mergeMintedCheckout(checkout, options.snapshot()));
    } catch (error) {
      // Surface the mint failure inline instead of silently returning to the
      // method picker.
      wizardError = payerFacingMessage(error, MINT_FAILED);
      options.onError(error);
    } finally {
      mintingLightning = false;
      options.onChange();
    }
  }

  async function startSwap(payInAsset: string): Promise<void> {
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
      const quote = await quoteSwapAsset(payInAsset, prefix, fetcher, reference);
      if (quote !== undefined && quote.available === false) return;
      const started = await startSwapRequest({
        fetch: fetcher,
        prefix,
        reference,
        payInAsset,
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      });
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
      startingSwapAsset = null;
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
  ): Promise<CheckoutPaymentMethod | undefined> {
    const body = await postJson({
      fetch: fetcher,
      prefix,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      body: { reference, action: "swap_quote", pay_in_asset: payInAsset },
    });
    const quote = normalizeSwapQuote(body);
    if (quote === undefined) return undefined;
    swapQuotes = { ...swapQuotes, [quote.pay_in_asset]: quote };
    return quote;
  }

  function failSwapStart(error: unknown): void {
    swapStartError = payerFacingMessage(error, SWAP_START_FAILED);
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
    ensureLightning,
    startSwap,
    resetLightningRequest() {
      lightningRequested = false;
    },
    clearSwapStartError() {
      swapStartError = undefined;
    },
  };
}
