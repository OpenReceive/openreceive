import * as React from "react";
import {
  copyInvoice as copyInvoiceHelper,
  createCheckoutController,
  createCheckoutDisplayModel,
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
import {
  deriveCheckoutOrderStatus,
  resolveCheckoutStatusRefreshUrl,
  toCheckoutDisplayData,
  toCheckoutViewModel,
} from "./view-model.ts";
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
  React.useEffect(() => {
    setLatestSnapshot(checkout);
  }, [checkout]);
  const displayData = React.useMemo(() => toCheckoutDisplayData(latestSnapshot), [latestSnapshot]);
  const model = React.useMemo(
    () =>
      toCheckoutViewModel(
        createCheckoutDisplayModel(displayData),
        deriveCheckoutOrderStatus(latestSnapshot),
      ),
    [displayData, latestSnapshot],
  );
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
  const settledAnnouncementRef = React.useRef<{
    readonly orderId: string;
    readonly fired: boolean;
  }>({
    orderId: snapshot.order_id,
    fired: false,
  });
  const logContext = React.useMemo(() => getCheckoutLogContext(displayData), [displayData]);
  const refreshStatus = options.polling === false ? undefined : options.refreshStatus;
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: checkoutIdentity is an intentional recreate trigger — the effect seeds from snapshotRef, not from checkoutIdentity directly.
  React.useEffect(() => {
    const controller = createCheckoutController({
      snapshot: snapshotRef.current,
      ...(refreshStatus === undefined ? {} : { refreshStatus }),
      ...(orderUrl === undefined ? {} : { orderUrl }),
      pollIntervalMs: options.pollIntervalMs,
      logger: options.logger,
      onError: options.onError,
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
  }, [
    checkoutIdentity,
    refreshStatus,
    orderUrl,
    options.pollIntervalMs,
    options.logger,
    options.onError,
    options.clipboard,
    options.open,
  ]);
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
          invoice: displayData.invoice,
          clipboard: options.clipboard,
          logger: options.logger,
          logContext,
        });
      } else {
        await controller.copyInvoice();
      }
      showCopied(true);
    } catch (error) {
      options.onError?.(error);
      throw error;
    }
  }, [
    logContext,
    displayData.invoice,
    options.clipboard,
    options.logger,
    options.onError,
    showCopied,
  ]);

  const openWallet = React.useCallback(() => {
    try {
      const controller = controllerRef.current;
      return controller === null
        ? openWalletHelper({
            invoice: displayData.invoice,
            open: options.open,
            logger: options.logger,
            logContext,
          })
        : controller.openWallet();
    } catch (error) {
      options.onError?.(error);
      throw error;
    }
  }, [logContext, displayData.invoice, options.open, options.logger, options.onError]);

  const reloadState = React.useCallback(async () => {
    try {
      const next = await controllerRef.current?.reloadState();
      if (next !== undefined) setState(next);
    } catch (error) {
      options.onError?.(error);
      throw error;
    }
  }, [options.onError]);

  const retry = React.useCallback(async () => {
    try {
      const next = await controllerRef.current?.retry();
      if (next !== undefined) setState(next);
    } catch (error) {
      options.onError?.(error);
      throw error;
    }
  }, [options.onError]);

  const cancel = React.useCallback(() => {
    const next = controllerRef.current?.cancel();
    if (next !== undefined) setState(next);
  }, []);

  return {
    ...model,
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
