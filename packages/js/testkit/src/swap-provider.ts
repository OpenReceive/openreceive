import { unixSeconds } from "@openreceive/core";
import {
  type OpenReceiveSwapAddressNetwork,
  openReceiveSwapAddressNetworkForPayInAsset,
} from "@openreceive/core/swap-address";
import {
  OPENRECEIVE_SWAP_PAY_IN_ASSETS,
  type SwapAttentionReason,
  type SwapOrder,
  type SwapPayInAsset,
  type SwapProvider,
  type SwapProviderAsset,
  type SwapProviderState,
  type SwapQuote,
} from "@openreceive/node";

/**
 * An in-memory, fully scriptable {@link SwapProvider} for building and
 * testing automated-swap flows offline — no live FixedFloat keys and no real crypto.
 * Drive an attempt through its lifecycle with {@link TestkitSwapProvider.script}, or
 * jump straight to an edge case with `forceRefundRequired`, `forceAttention`, and
 * `forceCreateError`.
 *
 * ```ts
 * const swap = createTestkitSwapProvider();
 * const or = await createOpenReceive({
 *   client: createTestkitReceiveClient(),
 *   swap: { providers: [swap] },
 * });
 * swap.script("USDT_TRON", ["awaiting_deposit", "confirming", "exchanging", "completed"]);
 * // each getStatus poll advances one step, then holds on the last state
 * ```
 */

const NETWORK_DEPOSIT_ADDRESS: Readonly<Record<OpenReceiveSwapAddressNetwork, string>> = {
  TRX: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
  SOL: "So11111111111111111111111111111111111111112",
  ETH: "0x1111111111111111111111111111111111111111",
};

function depositAddressFor(payInAsset: SwapPayInAsset): string {
  const network = openReceiveSwapAddressNetworkForPayInAsset(payInAsset);
  if (network === undefined) {
    throw new Error(`testkit swap provider has no deposit address for ${payInAsset}`);
  }
  return NETWORK_DEPOSIT_ADDRESS[network];
}

export interface TestkitSwapProviderOptions {
  /** Provider id/name. Must match the provider you register with; defaults to "fixedfloat". */
  readonly name?: string;
  /** Pay-in assets this provider supports. Defaults to the full built-in catalog. */
  readonly supportedAssets?: readonly SwapPayInAsset[];
  /**
   * Clock in unix seconds. Defaults to the real clock, matching
   * TestkitReceiveClient: a fixed low value would mint every swap with a
   * provider_expires_at already in the past. Pass one for deterministic
   * timestamps.
   */
  readonly now?: () => number;
  /** Shadow-invoice expiry the provider requests, in seconds. Defaults to 1800. */
  readonly invoiceExpirySeconds?: number;
  /** Deposit-window length used for provider_expires_at, in seconds. Defaults to 900. */
  readonly depositExpirySeconds?: number;
  /** Per-asset deposit amount the payer must send. Falls back to "1.05". */
  readonly payAmounts?: Partial<Record<SwapPayInAsset, string>>;
}

/** Selector for scripting/forcing a swap: an asset string, or a specific stored attempt. */
export type TestkitSwapSelector =
  | SwapPayInAsset
  | { readonly payInAsset?: SwapPayInAsset; readonly providerOrderId?: string };

interface StoredSwap {
  order: SwapOrder;
  steps: SwapProviderState[];
  next: number;
  attentionReason?: SwapAttentionReason;
}

interface PendingSwapScript {
  readonly steps: readonly SwapProviderState[];
  readonly attentionReason?: SwapAttentionReason;
}

export class TestkitSwapProvider implements SwapProvider {
  readonly name: string;

  createCalls = 0;
  quoteCalls = 0;
  catalogCalls = 0;
  statusCalls = 0;
  readonly createSwapInputs: unknown[] = [];
  readonly quoteInputs: unknown[] = [];
  readonly refundCalls: { readonly providerOrderId: string; readonly refundAddress: string }[] = [];

  readonly #supported: Set<SwapPayInAsset>;
  readonly #now: () => number;
  readonly #invoiceExpirySeconds: number;
  readonly #depositExpirySeconds: number;
  readonly #payAmounts: Partial<Record<SwapPayInAsset, string>>;
  readonly #orders = new Map<string, StoredSwap>();
  readonly #pendingScripts = new Map<SwapPayInAsset, PendingSwapScript>();
  #nextCreateError: Error | undefined;

  constructor(options: TestkitSwapProviderOptions = {}) {
    this.name = options.name ?? "fixedfloat";
    this.#supported = new Set(options.supportedAssets ?? OPENRECEIVE_SWAP_PAY_IN_ASSETS);
    this.#now = options.now ?? unixSeconds;
    this.#invoiceExpirySeconds = options.invoiceExpirySeconds ?? 1800;
    this.#depositExpirySeconds = options.depositExpirySeconds ?? 900;
    this.#payAmounts = options.payAmounts ?? {};
  }

  async supportedPayInAssets(): Promise<Set<SwapPayInAsset>> {
    return new Set(this.#supported);
  }

  async payInAssetCatalog(): Promise<readonly SwapProviderAsset[]> {
    this.catalogCalls += 1;
    return Array.from(this.#supported, (payInAsset) => ({
      pay_asset: payInAsset,
      available: true,
      minimum_pay_amount: "1",
      maximum_pay_amount: "5000",
    }));
  }

  invoiceExpirySeconds(): number {
    return this.#invoiceExpirySeconds;
  }

  async quote(input: {
    readonly payInAsset: SwapPayInAsset;
    readonly invoiceAmountMsats: number;
  }): Promise<SwapQuote> {
    this.quoteCalls += 1;
    this.quoteInputs.push(input);
    return {
      pay_amount: this.#payAmountFor(input.payInAsset),
      pay_asset: input.payInAsset,
      available: true,
      provider: this.name,
      minimum_pay_amount: "1",
      maximum_pay_amount: "5000",
    };
  }

  async createSwap(input: {
    readonly payInAsset: SwapPayInAsset;
    readonly bolt11: string;
    readonly invoiceAmountMsats: number;
  }): Promise<SwapOrder> {
    this.createCalls += 1;
    this.createSwapInputs.push(input);
    if (this.#nextCreateError !== undefined) {
      const error = this.#nextCreateError;
      this.#nextCreateError = undefined;
      throw error;
    }

    const providerOrderId = `testkit-swap-${this.createCalls}`;
    const order: SwapOrder = {
      provider: this.name,
      provider_order_id: providerOrderId,
      provider_token: `testkit-token-${this.createCalls}`,
      pay_in_asset: input.payInAsset,
      deposit_address: depositAddressFor(input.payInAsset),
      deposit_amount: this.#payAmountFor(input.payInAsset),
      expires_at: this.#now() + this.#depositExpirySeconds,
      state: "awaiting_deposit",
    };
    const pending = this.#pendingScripts.get(input.payInAsset);
    this.#orders.set(providerOrderId, {
      order,
      steps: pending === undefined ? [] : [...pending.steps],
      next: 0,
      ...(pending?.attentionReason === undefined
        ? {}
        : { attentionReason: pending.attentionReason }),
    });
    return order;
  }

  async getStatus(order: SwapOrder): Promise<SwapOrder> {
    this.statusCalls += 1;
    const stored = this.#orders.get(order.provider_order_id);
    if (stored === undefined) return order;
    if (stored.next < stored.steps.length) {
      const nextState = stored.steps[stored.next];
      stored.next += 1;
      stored.order = applyState(stored.order, nextState);
      if (nextState === "attention" && stored.attentionReason !== undefined) {
        stored.order = { ...stored.order, attention_reason: stored.attentionReason };
      }
    }
    return stored.order;
  }

  async requestRefund(order: SwapOrder, refundAddress: string): Promise<void> {
    this.refundCalls.push({ providerOrderId: order.provider_order_id, refundAddress });
    const stored = this.#orders.get(order.provider_order_id);
    if (stored !== undefined) {
      stored.order = applyState(stored.order, "refund_pending");
    }
  }

  /**
   * Queue a sequence of provider states. Each `getStatus` poll advances one step and
   * then holds on the last state. Scripting an asset before a swap is started attaches
   * the sequence to the next attempt created for that asset.
   */
  script(selector: TestkitSwapSelector, states: readonly SwapProviderState[]): void {
    if (states.length === 0) {
      throw new RangeError("swap script must include at least one state");
    }
    const matched = this.#match(selector);
    for (const stored of matched) {
      stored.steps = [...states];
      stored.next = 0;
      delete stored.attentionReason;
    }
    const payInAsset = selectorAsset(selector);
    if (payInAsset !== undefined) {
      this.#pendingScripts.set(payInAsset, { steps: [...states] });
    }
  }

  /**
   * Force `refund_required`: existing selected attempts report it on their next
   * `getStatus`, and like {@link script} an asset selector also queues it for
   * attempts created later.
   */
  forceRefundRequired(selector: TestkitSwapSelector): void {
    this.#force(selector, "refund_required");
  }

  /**
   * Force the `attention` state with a recorded reason: existing selected
   * attempts move immediately, and like {@link script} an asset selector also
   * queues it for attempts created later.
   */
  forceAttention(
    selector: TestkitSwapSelector,
    reason: SwapAttentionReason = "provider_reported_emergency",
  ): void {
    this.#force(selector, "attention", reason);
  }

  /** Make the next `createSwap` call reject, simulating a provider order-creation failure. */
  forceCreateError(error: Error = new Error("testkit swap provider create failed")): void {
    this.#nextCreateError = error;
  }

  #force(
    selector: TestkitSwapSelector,
    state: SwapProviderState,
    attentionReason?: SwapAttentionReason,
  ): void {
    for (const stored of this.#match(selector)) {
      stored.steps = [];
      stored.next = 0;
      delete stored.attentionReason;
      stored.order = applyState(stored.order, state);
      if (attentionReason !== undefined) {
        stored.order = { ...stored.order, attention_reason: attentionReason };
      }
    }
    const payInAsset = selectorAsset(selector);
    if (payInAsset !== undefined) {
      this.#pendingScripts.set(payInAsset, {
        steps: [state],
        ...(attentionReason === undefined ? {} : { attentionReason }),
      });
    }
  }

  #match(selector: TestkitSwapSelector): StoredSwap[] {
    const asset = selectorAsset(selector);
    const providerOrderId = typeof selector === "object" ? selector.providerOrderId : undefined;
    return [...this.#orders.values()].filter((stored) => {
      if (providerOrderId !== undefined && stored.order.provider_order_id !== providerOrderId) {
        return false;
      }
      if (asset !== undefined && stored.order.pay_in_asset !== asset) return false;
      return true;
    });
  }

  #payAmountFor(payInAsset: SwapPayInAsset): string {
    return this.#payAmounts[payInAsset] ?? "1.05";
  }
}

export function createTestkitSwapProvider(
  options: TestkitSwapProviderOptions = {},
): TestkitSwapProvider {
  return new TestkitSwapProvider(options);
}

function selectorAsset(selector: TestkitSwapSelector): SwapPayInAsset | undefined {
  return typeof selector === "string" ? selector : selector.payInAsset;
}

function applyState(order: SwapOrder, state: SwapProviderState): SwapOrder {
  const attention = state === "attention";
  return {
    ...order,
    state,
    ...(atOrAfter(state, "confirming") ? { deposit_tx_id: "testkit-deposit-tx" } : {}),
    ...(state === "completed" ? { payout_tx_id: "testkit-payout-tx" } : {}),
    ...(state === "refunded" ? { refund_tx_id: "testkit-refund-tx" } : {}),
    ...(attention ? { attention: true } : {}),
  };
}

const PROGRESS_ORDER: readonly SwapProviderState[] = [
  "creating_provider_order",
  "awaiting_deposit",
  "confirming",
  "exchanging",
  "paying_invoice",
  "completed",
];

/** True once the payer's deposit has been detected (confirming or later progress state). */
function atOrAfter(state: SwapProviderState, floor: SwapProviderState): boolean {
  const stateIndex = PROGRESS_ORDER.indexOf(state);
  const floorIndex = PROGRESS_ORDER.indexOf(floor);
  return stateIndex >= 0 && floorIndex >= 0 && stateIndex >= floorIndex;
}
