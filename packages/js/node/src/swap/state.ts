import {
  type GeneratedSwapPhase,
  OPENRECEIVE_SWAP_PROVIDER_STATES,
  OPENRECEIVE_SWAP_STATE_TABLE,
} from "../generated/swap-tables.ts";
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
 *
 * The state → phase/terminal table itself is kernel vocabulary
 * (spec/data/kernel-tables.json) generated into every engine; this module adds the
 * payer-facing copy, which only the JS checkout renders.
 */
export type SwapPhase = GeneratedSwapPhase;

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

/** Payer-facing copy per state. Keyed by the generated state union, so a new state cannot ship without copy. */
const SWAP_STATE_COPY: Readonly<
  Record<SwapProviderState, { readonly label: string; readonly detail: string }>
> = {
  creating_provider_order: {
    label: "Preparing payment address",
    detail: "Creating a payment address.",
  },
  awaiting_deposit: {
    label: "Waiting for your payment",
    detail: "Send exactly the amount shown below.",
  },
  confirming: {
    label: "Confirming payment",
    detail: "Your payment was detected and is confirming on-chain.",
  },
  exchanging: {
    label: "Converting payment",
    detail: "Your payment is confirmed and being converted. This usually finishes within a minute.",
  },
  paying_invoice: {
    label: "Finalizing checkout",
    detail: "The provider is sending the Lightning payment. This usually takes a few seconds.",
  },
  completed: {
    label: "Finalizing checkout",
    detail: "The provider is sending the Lightning payment. This usually takes a few seconds.",
  },
  expired: {
    label: "Expired",
    detail: "No payment was received before the payment window closed.",
  },
  refund_required: {
    label: "Refund needed",
    detail: "Enter an address you control to request a refund.",
  },
  refund_pending: {
    label: "Refund pending",
    detail: "Your refund request has been sent.",
  },
  refunded: {
    label: "Refunded",
    detail: "The provider reports the refund was sent.",
  },
  attention: {
    label: "Needs attention",
    detail: "This payment needs support review.",
  },
  failed: {
    label: "Failed",
    detail: "This payment address can no longer be used.",
  },
};

function swapStateInfo(state: SwapProviderState): SwapStateInfo {
  const { phase, terminal } = OPENRECEIVE_SWAP_STATE_TABLE[state];
  return { state, ...SWAP_STATE_COPY[state], phase, terminal };
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
export const OPENRECEIVE_SWAP_STATES: Readonly<Record<SwapProviderState, SwapStateInfo>> =
  Object.freeze(
    Object.fromEntries(
      OPENRECEIVE_SWAP_PROVIDER_STATES.map((state) => [state, swapStateInfo(state)]),
    ) as Record<SwapProviderState, SwapStateInfo>,
  );
