import type {
  CheckoutState,
  GuestCheckoutResumeController,
} from "@openreceive/browser/internal";
import * as React from "react";

const DEFAULT_RESUME_MISS_MESSAGE =
  "This checkout link is no longer available. Start a new order.";

export interface UseCheckoutResumeOptions<TOrder = never> {
  /**
   * Current host order id while checkout is active. Used to fire `onSettled` once
   * per order and to ignore stale callbacks after start-over.
   */
  readonly orderId?: string | null;
  /**
   * Called once when settlement is observed for `orderId`. Receives the latest
   * {@link CheckoutState} captured via `onState` (may be null if settle raced ahead).
   */
  readonly onSettled?: (state: CheckoutState | null) => void;
  /**
   * Optional guest resume controller from `createGuestCheckoutResume`. When set with
   * `syncUrl` and/or `routeOrderId`, the hook loads the host order for resume.
   */
  readonly guest?: GuestCheckoutResumeController<TOrder>;
  /**
   * Explicit order id from the router (Next.js / file-based routes). When provided,
   * takes precedence over pathname parsing.
   */
  readonly routeOrderId?: string;
  /**
   * History API SPAs: parse `location.pathname` and listen to `popstate`.
   * Ignored when `routeOrderId` is used as the sole source (pass `routeOrderId` only).
   * Default `false`.
   */
  readonly syncUrl?: boolean;
  /** Called when a host order is loaded for resume. */
  readonly onResumed?: (order: TOrder) => void;
  /** Called when the resume order id is missing from storage and fetch. */
  readonly onResumeMiss?: (orderId: string) => void;
  /** Called when the URL / route leaves checkout (no order id to resume). */
  readonly onResumeClear?: () => void;
  readonly resumeMissMessage?: string;
}

export interface UseCheckoutResumeResult {
  readonly settledState: CheckoutState | null;
  readonly resuming: boolean;
  readonly resumeError: string | null;
  /** Pass to `<Checkout onState={...} />`. */
  readonly onState: (state: CheckoutState) => void;
  /** Pass to `<Checkout onSettled={...} />`. */
  readonly onSettled: () => void;
  /** Clear settled state, once-guard, and resume error (call on start-over / new order). */
  readonly reset: () => void;
  readonly clearResumeError: () => void;
}

/**
 * Settlement-capture + optional guest URL resume for host apps wrapping `<Checkout>`.
 *
 * Handles the once-per-order settled guard and latest-state ref that every React demo
 * previously copy-pasted. For the common case, prefer `<Checkout orderId onSummary={…} />`
 * (summary restore is automatic); add `syncUrl` only when you want History API URL sync.
 * Keep this hook when you need custom `createGuestCheckoutResume` storage keys or route
 * parsing.
 */
export function useCheckoutResume<TOrder = never>(
  options: UseCheckoutResumeOptions<TOrder> = {},
): UseCheckoutResumeResult {
  const {
    orderId = null,
    onSettled: onSettledCallback,
    guest,
    routeOrderId,
    syncUrl = false,
    onResumed,
    onResumeMiss,
    onResumeClear,
    resumeMissMessage = DEFAULT_RESUME_MISS_MESSAGE,
  } = options;

  const [settledState, setSettledState] = React.useState<CheckoutState | null>(null);
  const [resuming, setResuming] = React.useState(() => initialResuming(guest, routeOrderId, syncUrl));
  const [resumeError, setResumeError] = React.useState<string | null>(null);

  const completedOrderIdRef = React.useRef("");
  const latestStateRef = React.useRef<CheckoutState | null>(null);
  const orderIdRef = React.useRef(orderId);
  orderIdRef.current = orderId;

  const onSettledCallbackRef = React.useRef(onSettledCallback);
  onSettledCallbackRef.current = onSettledCallback;
  const onResumedRef = React.useRef(onResumed);
  onResumedRef.current = onResumed;
  const onResumeMissRef = React.useRef(onResumeMiss);
  onResumeMissRef.current = onResumeMiss;
  const onResumeClearRef = React.useRef(onResumeClear);
  onResumeClearRef.current = onResumeClear;

  const onState = React.useCallback((state: CheckoutState) => {
    latestStateRef.current = state;
    if (state.settled) {
      setSettledState(state);
    }
  }, []);

  const onSettled = React.useCallback(() => {
    const currentOrderId = orderIdRef.current;
    if (currentOrderId == null || currentOrderId.length === 0) return;
    if (completedOrderIdRef.current === currentOrderId) return;
    completedOrderIdRef.current = currentOrderId;
    const state = latestStateRef.current;
    setSettledState(state);
    onSettledCallbackRef.current?.(state);
  }, []);

  const reset = React.useCallback(() => {
    setSettledState(null);
    latestStateRef.current = null;
    completedOrderIdRef.current = "";
    setResumeError(null);
    setResuming(false);
  }, []);

  const clearResumeError = React.useCallback(() => {
    setResumeError(null);
  }, []);

  React.useEffect(() => {
    if (guest === undefined) return;
    if (!syncUrl && routeOrderId === undefined) return;

    let cancelled = false;

    async function resumeFromOrderId(nextOrderId: string): Promise<void> {
      setResuming(true);
      setResumeError(null);
      const resumed = await guest!.loadOrderForResume(nextOrderId);
      if (cancelled) return;
      if (resumed === undefined) {
        onResumeMissRef.current?.(nextOrderId);
        setResumeError(resumeMissMessage);
        setResuming(false);
        return;
      }
      onResumedRef.current?.(resumed);
      setResuming(false);
    }

    function resolveOrderId(): string | undefined {
      if (routeOrderId !== undefined) {
        return routeOrderId.length > 0 ? routeOrderId : undefined;
      }
      if (!syncUrl || typeof globalThis.location === "undefined") return undefined;
      return guest!.parseOrderId(globalThis.location.pathname);
    }

    function onPathChange(): void {
      const nextOrderId = resolveOrderId();
      if (nextOrderId === undefined) {
        onResumeClearRef.current?.();
        setResuming(false);
        return;
      }
      void resumeFromOrderId(nextOrderId);
    }

    onPathChange();

    if (syncUrl && routeOrderId === undefined) {
      globalThis.addEventListener("popstate", onPathChange);
      return () => {
        cancelled = true;
        globalThis.removeEventListener("popstate", onPathChange);
      };
    }

    return () => {
      cancelled = true;
    };
  }, [guest, routeOrderId, syncUrl, resumeMissMessage]);

  return {
    settledState,
    resuming,
    resumeError,
    onState,
    onSettled,
    reset,
    clearResumeError,
  };
}

function initialResuming<TOrder>(
  guest: GuestCheckoutResumeController<TOrder> | undefined,
  routeOrderId: string | undefined,
  syncUrl: boolean,
): boolean {
  if (guest === undefined) return false;
  if (routeOrderId !== undefined) return routeOrderId.length > 0;
  if (!syncUrl || typeof globalThis.location === "undefined") return false;
  return guest.parseOrderId(globalThis.location.pathname) !== undefined;
}
