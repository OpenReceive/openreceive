// React's wrapper over the shared create-mode session
// (`createOpenReceiveCheckoutSession` in @openreceive/browser/headless): the
// same deferred Lightning mint and swap start the custom element runs, with
// React's publishing (setState) and error surfacing (`onError`) injected.
//
// The session is created ONCE and kept in a ref, so its in-flight guards are
// plain fields rather than `useState`. That is the point: a second click in the
// same tick must see the first click's guard, and a `setState` flag cannot be
// there in time. React had no guard on the Lightning mint at all and
// double-POSTed `/checkouts`; the loser's 409 then surfaced as an error over a
// perfectly good invoice.
//
// Every option is read back through `optionsRef`, so the session built on the
// first render never holds a stale prop, and `rerender` is what turns a session
// field change back into React state.

import {
  createOpenReceiveCheckoutSession,
  type OpenReceiveCheckoutSession,
  type OpenReceiveCheckoutSessionOptions,
} from "@openreceive/browser/headless";
import * as React from "react";

/** `onChange` is React's to supply — it is the re-render. */
export type UseOpenReceiveCheckoutSessionOptions = Omit<
  OpenReceiveCheckoutSessionOptions,
  "onChange"
>;

export function useOpenReceiveCheckoutSession(
  options: UseOpenReceiveCheckoutSessionOptions,
): OpenReceiveCheckoutSession {
  const [, rerender] = React.useReducer((count: number) => count + 1, 0);
  const optionsRef = React.useRef(options);
  optionsRef.current = options;
  const sessionRef = React.useRef<OpenReceiveCheckoutSession | undefined>(undefined);
  if (sessionRef.current === undefined) {
    sessionRef.current = createOpenReceiveCheckoutSession({
      snapshot: () => optionsRef.current.snapshot(),
      orderId: () => optionsRef.current.orderId(),
      requestCheckout: (orderId) => optionsRef.current.requestCheckout?.(orderId),
      onSnapshot: (snapshot) => optionsRef.current.onSnapshot?.(snapshot),
      swapPrefix: () => optionsRef.current.swapPrefix?.(),
      fetch: () => optionsRef.current.fetch?.(),
      swapSelection: {
        started: () => optionsRef.current.swapSelection?.started(),
        setStarted: (invoice) => optionsRef.current.swapSelection?.setStarted(invoice),
        dismissedInvoiceId: () => optionsRef.current.swapSelection?.dismissedInvoiceId() ?? null,
        setDismissedInvoiceId: (invoiceId) =>
          optionsRef.current.swapSelection?.setDismissedInvoiceId(invoiceId),
        setSelectedAsset: (payInAsset) =>
          optionsRef.current.swapSelection?.setSelectedAsset(payInAsset),
      },
      onSwapStarted: (invoice) => optionsRef.current.onSwapStarted?.(invoice),
      get logger() {
        return optionsRef.current.logger;
      },
      onError: (error) => optionsRef.current.onError(error),
      onChange: rerender,
    });
  }
  return sessionRef.current;
}
