import * as React from "react";
import {
  copyInvoice as copyInvoiceHelper,
  createCheckoutController,
  createCheckoutState,
  createCheckoutStatusModel,
  openWallet as openWalletHelper,
  status as deriveStatus,
  type CheckoutController,
  type CheckoutSnapshot,
  type CheckoutState,
} from "@openreceive/browser/internal";
import { useOpenReceiveTransientValue } from "./hooks.ts";
import { getCheckoutLogContext } from "./utils.ts";
import { resolveCheckoutStatusRefreshUrl } from "./view-model.ts";
import type { CheckoutProviderProps, UseCheckoutOptions, UseCheckoutResult } from "./types.ts";

export function useCheckout(options: UseCheckoutOptions): UseCheckoutResult {
  // The hook drives a concrete checkout snapshot. Create mode (passing only an orderId) is
  // handled by the <Checkout> component wrapper, which creates the checkout and hands the
  // resulting snapshot to this hook — so the hook/logic below stays untouched.
  const checkout = options.checkout;
  if (checkout === undefined) {
    throw new Error(
      "useCheckout requires a checkout snapshot. Pass orderId to <Checkout> for create mode.",
    );
  }
  const [copied, showCopied] = useOpenReceiveTransientValue<boolean>(false);
  const [latestSnapshot, setLatestSnapshot] = React.useState<CheckoutSnapshot>(checkout);
  // Reset ONLY when the snapshot's identity changes. Keying on object identity
  // would discard polled state (merged swap invoices, payment_methods,
  // paid_at) whenever the parent re-renders with a rebuilt-but-equivalent
  // snapshot object.
  const incomingIdentity = `${checkout.checkout_id} ${checkout.order_id}`;
  const checkoutRef = React.useRef(checkout);
  checkoutRef.current = checkout;
  // biome-ignore lint/correctness/useExhaustiveDependencies: incomingIdentity is the deliberate reset key; the snapshot is read from a ref.
  React.useEffect(() => {
    setLatestSnapshot(checkoutRef.current);
  }, [incomingIdentity]);
  // `latestSnapshot` is already memoized above, so no extra useMemo is needed.
  const snapshot: CheckoutSnapshot = latestSnapshot;
  const [state, setState] = React.useState<CheckoutState>(() =>
    createCheckoutState(snapshot, {
      logger: options.logger,
    }),
  );
  const controllerRef = React.useRef<CheckoutController | null>(null);
  const onStateRef = React.useRef(options.onState);
  onStateRef.current = options.onState;
  const onSettledRef = React.useRef(options.onSettled);
  onSettledRef.current = options.onSettled;
  // Hosts commonly pass inline logger/onError. Those must not recreate the poll
  // controller — after settlement, onState often setStates the parent, which would
  // mint a new onError every render and loop: recreate → reloadState → onState → …
  const loggerRef = React.useRef(options.logger);
  loggerRef.current = options.logger;
  const onErrorRef = React.useRef(options.onError);
  onErrorRef.current = options.onError;
  const onCopyRef = React.useRef(options.onCopy);
  onCopyRef.current = options.onCopy;
  const onOpenWalletRef = React.useRef(options.onOpenWallet);
  onOpenWalletRef.current = options.onOpenWallet;
  const settledAnnouncementRef = React.useRef<{
    readonly orderId: string;
    readonly fired: boolean;
  }>({
    orderId: snapshot.order_id,
    fired: false,
  });
  const logContext = React.useMemo(() => getCheckoutLogContext(state), [state]);
  // Hosts pass inline refreshStatus as readily as inline logger/onError; keeping the
  // function itself in the dependency list below tore down and recreated the controller
  // on every parent render, and each recreation re-polls immediately. Only whether a
  // refresher is configured may change the controller.
  const refreshStatus = options.polling === false ? undefined : options.refreshStatus;
  const refreshStatusRef = React.useRef(refreshStatus);
  refreshStatusRef.current = refreshStatus;
  const polls = refreshStatus !== undefined;
  const orderUrl = resolveCheckoutStatusRefreshUrl({
    orderUrl: options.orderUrl,
    polling: options.polling,
  });
  // The controller owns the poll/countdown timers and pushes every poll result
  // back out through onSnapshot -> setLatestSnapshot. Seed it from the current
  // snapshot via a ref (as with onStateRef below) and recreate it only when the
  // checkout it watches changes identity. Keying this effect on the mutable
  // snapshot instead would tear the controller down on each result it produced,
  // recreating it and immediately re-polling in a tight loop.
  const snapshotRef = React.useRef(snapshot);
  snapshotRef.current = snapshot;
  const checkoutIdentity = `${snapshot.checkout_id} ${snapshot.order_id}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: checkoutIdentity is an intentional recreate trigger — the effect seeds from snapshotRef, not from checkoutIdentity directly. logger/onError/refreshStatus are read from refs so inline host callbacks cannot restart polling.
  React.useEffect(() => {
    const controller = createCheckoutController({
      snapshot: snapshotRef.current,
      ...(polls
        ? {
            refreshStatus: async (orderId: string) =>
              (await refreshStatusRef.current?.(orderId)) ?? null,
          }
        : {}),
      ...(orderUrl === undefined ? {} : { orderUrl }),
      pollIntervalMs: options.pollIntervalMs,
      // Omit logger when unset so @openreceive/browser attaches its default console sink.
      // Pass `false` through to disable; wrap custom sinks so inline host callbacks stay stable.
      ...(loggerRef.current === false
        ? { logger: false as const }
        : loggerRef.current !== undefined
          ? {
              logger: (entry) => {
                const current = loggerRef.current;
                if (typeof current === "function") current(entry);
              },
            }
          : {}),
      onError: (error) => {
        onErrorRef.current?.(error);
      },
      clipboard: options.clipboard,
      open: options.open,
      onState: (nextState) => {
        setState(nextState);
        onStateRef.current?.(nextState);
      },
      onSnapshot: setLatestSnapshot,
    });
    controllerRef.current = controller;
    controller.start();
    // Refresh once immediately so the order object (and its payment_methods)
    // is available without waiting for the first poll interval.
    void controller.reloadState().catch(() => undefined);

    return () => {
      controller.stop();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [checkoutIdentity, polls, orderUrl, options.pollIntervalMs]);
  const publicStatus = deriveStatus(state);
  const richStatus = createCheckoutStatusModel(state);

  React.useEffect(() => {
    const announced = settledAnnouncementRef.current;
    if (announced.orderId !== snapshot.order_id) {
      settledAnnouncementRef.current = {
        orderId: snapshot.order_id,
        fired: false,
      };
    }
  }, [snapshot.order_id]);

  React.useEffect(() => {
    const announced = settledAnnouncementRef.current;
    if (publicStatus !== "settled" || announced.fired) return;
    settledAnnouncementRef.current = {
      orderId: snapshot.order_id,
      fired: true,
    };
    // UI hint only; server-side fulfillment must use the backend settlement hook.
    onSettledRef.current?.();
  }, [publicStatus, snapshot.order_id]);

  const copyInvoice = React.useCallback(async () => {
    try {
      const controller = controllerRef.current;
      if (controller === null) {
        await copyInvoiceHelper({
          invoice: state.invoice,
          clipboard: options.clipboard,
          logger: options.logger,
          logContext,
        });
      } else {
        await controller.copyInvoice();
      }
      showCopied(true);
      onCopyRef.current?.();
    } catch (error) {
      onErrorRef.current?.(error);
      throw error;
    }
  }, [logContext, state.invoice, options.clipboard, options.logger, showCopied]);

  const openWallet = React.useCallback(() => {
    try {
      const controller = controllerRef.current;
      const uri =
        controller === null
          ? openWalletHelper({
              invoice: state.invoice,
              open: options.open,
              logger: options.logger,
              logContext,
            })
          : controller.openWallet();
      onOpenWalletRef.current?.(uri);
      return uri;
    } catch (error) {
      onErrorRef.current?.(error);
      throw error;
    }
  }, [logContext, state.invoice, options.open, options.logger]);

  const reloadState = React.useCallback(async () => {
    try {
      const next = await controllerRef.current?.reloadState();
      if (next !== undefined) setState(next);
    } catch (error) {
      onErrorRef.current?.(error);
      throw error;
    }
  }, []);

  // After a failed poll the only recovery is another status read, so retry is
  // reloadState under the name a payer-facing "Try again" button wants.
  const retry = reloadState;

  const cancel = React.useCallback(() => {
    const next = controllerRef.current?.cancel();
    if (next !== undefined) setState(next);
  }, []);

  return {
    // The state IS the view model now: one derivation, one set of display
    // fields. `status` stays on top of it because the component's terminal
    // branches read the checkout's coarse status, not the attempt's phase.
    ...state,
    checkout: latestSnapshot,
    copied,
    status: publicStatus,
    expires_in_seconds: richStatus.expires_in_seconds,
    countdownLabel: richStatus.countdownLabel,
    countdownPrefix: richStatus.countdownPrefix,
    statusTitle: richStatus.title,
    statusDetail: richStatus.detail,
    waiting: richStatus.waiting,
    reloadState,
    retry,
    cancel,
    copyInvoice,
    openWallet,
  };
}

const CheckoutContext = React.createContext<UseCheckoutResult | null>(null);

export function useCheckoutContext(): UseCheckoutResult {
  const checkout = React.useContext(CheckoutContext);
  if (checkout === null) {
    throw new Error("useCheckoutContext must be used within CheckoutProvider.");
  }
  return checkout;
}

export function CheckoutProvider(props: CheckoutProviderProps): React.ReactElement {
  const { children, ...options } = props;
  const checkout = useCheckout(options);
  const content = typeof children === "function" ? children(checkout) : children;

  return React.createElement(CheckoutContext.Provider, { value: checkout }, content);
}
