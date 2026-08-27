// React's wrapper over the shared create-mode session
// (`createCheckoutSession` in @openreceive/browser/headless): the
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
  createCheckoutSession,
  type CheckoutSession,
  type CheckoutSessionOptions,
} from "@openreceive/browser/headless";
import * as React from "react";

/** `onChange` is React's to supply — it is the re-render. */
export type UseOpenReceiveCheckoutSessionOptions = Omit<CheckoutSessionOptions, "onChange">;

export function useCheckoutSession(options: UseOpenReceiveCheckoutSessionOptions): CheckoutSession {
  const [, rerender] = React.useReducer((count: number) => count + 1, 0);
  const optionsRef = React.useRef(options);
  optionsRef.current = options;
  const sessionRef = React.useRef<CheckoutSession | undefined>(undefined);
  if (sessionRef.current === undefined) {
    sessionRef.current = createCheckoutSession({
      snapshot: () => optionsRef.current.snapshot(),
      reference: () => optionsRef.current.reference(),
      requestCheckout: (reference) => optionsRef.current.requestCheckout?.(reference),
      onSnapshot: (snapshot) => optionsRef.current.onSnapshot?.(snapshot),
      // The inner `swap` is always present because the session is built once,
      // on the first render, and the host may only gain swap options later.
      // Every accessor reads through `optionsRef`, so a host with no `swap`
      // makes `prefix()` answer undefined and the session reports the missing
      // wiring instead of silently doing nothing.
      swap: {
        selection: {
          started: () => optionsRef.current.swap?.selection.started(),
          setStarted: (invoice) => optionsRef.current.swap?.selection.setStarted(invoice),
          dismissedInvoiceId: () => optionsRef.current.swap?.selection.dismissedInvoiceId() ?? null,
          setDismissedInvoiceId: (invoiceId) =>
            optionsRef.current.swap?.selection.setDismissedInvoiceId(invoiceId),
          setSelectedAsset: (payInAsset) =>
            optionsRef.current.swap?.selection.setSelectedAsset(payInAsset),
        },
        prefix: () => optionsRef.current.swap?.prefix(),
        fetch: () => optionsRef.current.swap?.fetch(),
        onStarted: (invoice) => optionsRef.current.swap?.onStarted?.(invoice),
      },
      get logger() {
        return optionsRef.current.logger;
      },
      onError: (error) => optionsRef.current.onError(error),
      onChange: rerender,
    });
  }
  return sessionRef.current;
}
