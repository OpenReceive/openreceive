import type { SwapProviderState } from "./provider.ts";

/**
 * Coarse lifecycle bucket for a swap attempt's `provider_state`. Twelve provider
 * states collapse into these seven phases so a UI can branch on "what should the
 * payer see / do now" without hardcoding every state:
 *
 * - `preparing`        — the deposit address is still being created.
 * - `awaiting_deposit` — show the deposit address/amount; the payer must send funds.
 * - `processing`       — funds seen; the provider is confirming/converting/paying.
 * - `settling`         — provider reports done, but OpenReceive has NOT settled the
 *                        order yet. Never render this as "Paid": the wallet sweep is
 *                        the settlement authority (see automated-swaps.md).
 * - `refund`           — a refund is required, staged, or in flight.
 * - `attention`        — needs operator/support review (funds may be stuck).
 * - `terminal`         — the attempt is over and will not change (expired/refunded/failed).
 */
export type SwapPhase =
  | "preparing"
  | "awaiting_deposit"
  | "processing"
  | "settling"
  | "refund"
  | "attention"
  | "terminal";

export interface SwapStateInfo {
  /** The provider state this describes. */
  readonly state: SwapProviderState;
  /** Short, payer-facing status label, e.g. "Waiting for your payment". */
  readonly label: string;
  /** One-sentence payer-facing explanation of what is happening. */
  readonly detail: string;
  /** Coarse lifecycle bucket for UI branching. */
  readonly phase: SwapPhase;
  /**
   * Whether the attempt is over and will not transition again. Terminal states stop
   * being polled by the backend; a UI should stop refreshing this attempt.
   */
  readonly terminal: boolean;
}

/**
 * The canonical catalog of every swap `provider_state`, its payer-facing copy, its
 * coarse {@link SwapPhase}, and whether it is terminal. This is the single
 * source of truth the built-in checkout element and custom UIs should both read from.
 *
 * Settlement-safety invariant: `completed` is deliberately NON-terminal and lives in
 * the `settling` phase. Provider completion is not payment — OpenReceive only marks an
 * order paid when the wallet sweep sees a settled transaction.
 */
export const OPENRECEIVE_SWAP_STATES: Readonly<
  Record<SwapProviderState, SwapStateInfo>
> = {
  creating_provider_order: {
    state: "creating_provider_order",
    label: "Preparing payment address",
    detail: "Creating a payment address.",
    phase: "preparing",
    terminal: false,
  },
  awaiting_deposit: {
    state: "awaiting_deposit",
    label: "Waiting for your payment",
    detail: "Send exactly the amount shown below.",
    phase: "awaiting_deposit",
    terminal: false,
  },
  confirming: {
    state: "confirming",
    label: "Confirming payment",
    detail: "Your payment was detected and is confirming.",
    phase: "processing",
    terminal: false,
  },
  exchanging: {
    state: "exchanging",
    label: "Converting payment",
    detail: "Your payment is being converted.",
    phase: "processing",
    terminal: false,
  },
  paying_invoice: {
    state: "paying_invoice",
    label: "Finalizing checkout",
    detail: "The provider is sending the Lightning payment.",
    phase: "processing",
    terminal: false,
  },
  completed: {
    state: "completed",
    label: "Finalizing checkout",
    detail: "The provider is sending the Lightning payment.",
    phase: "settling",
    terminal: false,
  },
  expired: {
    state: "expired",
    label: "Expired",
    detail: "No payment was received before the payment window closed.",
    phase: "terminal",
    terminal: true,
  },
  refund_required: {
    state: "refund_required",
    label: "Refund needed",
    detail: "Enter an address you control to request a refund.",
    phase: "refund",
    terminal: false,
  },
  refund_pending: {
    state: "refund_pending",
    label: "Refund pending",
    detail: "Your refund request has been sent.",
    phase: "refund",
    terminal: false,
  },
  refunded: {
    state: "refunded",
    label: "Refunded",
    detail: "The provider reports the refund was sent.",
    phase: "terminal",
    terminal: true,
  },
  attention: {
    state: "attention",
    label: "Needs attention",
    detail: "This payment needs support review.",
    phase: "attention",
    terminal: true,
  },
  failed: {
    state: "failed",
    label: "Failed",
    detail: "This payment address can no longer be used.",
    phase: "terminal",
    terminal: true,
  },
};

/**
 * Describe a swap `provider_state`: payer-facing label + detail, its coarse lifecycle
 * `phase`, and whether it is `terminal`. Accepts an unknown string defensively (returns
 * a safe fallback) so a UI never throws on an unexpected value from an older payload.
 */
export function describeSwapState(state: string): SwapStateInfo {
  const info = (OPENRECEIVE_SWAP_STATES as Record<string, SwapStateInfo | undefined>)[
    state
  ];
  if (info !== undefined) return info;
  return {
    state: state as SwapProviderState,
    label: state,
    detail: state,
    phase: "attention",
    terminal: false,
  };
}
