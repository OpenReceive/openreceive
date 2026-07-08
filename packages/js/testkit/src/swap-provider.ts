import type {
  OpenReceiveSwapAttentionReason,
  OpenReceiveSwapOrder,
  OpenReceiveSwapPayInAsset,
  OpenReceiveSwapProvider,
  OpenReceiveSwapProviderAsset,
  OpenReceiveSwapProviderState,
  OpenReceiveSwapQuote,
} from "@openreceive/node";

/**
 * An in-memory, fully scriptable {@link OpenReceiveSwapProvider} for building and
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

const DEFAULT_SUPPORTED_ASSETS: readonly OpenReceiveSwapPayInAsset[] = [
  "USDT_TRON",
  "USDT_SOL",
  "USDC_SOL",
  "SOL_SOL",
  "ETH_ETH",
  "USDT_ETH",
  "USDC_ETH",
];

/** The on-chain network each pay-in asset settles on (mirrors @openreceive/node assets). */
const ASSET_NETWORK: Readonly<Record<OpenReceiveSwapPayInAsset, "TRX" | "SOL" | "ETH">> = {
  USDT_TRON: "TRX",
  USDT_SOL: "SOL",
  USDC_SOL: "SOL",
  SOL_SOL: "SOL",
  ETH_ETH: "ETH",
  USDT_ETH: "ETH",
  USDC_ETH: "ETH",
};

const NETWORK_DEPOSIT_ADDRESS: Readonly<Record<"TRX" | "SOL" | "ETH", string>> = {
  TRX: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
  SOL: "So11111111111111111111111111111111111111112",
  ETH: "0x1111111111111111111111111111111111111111",
};

export interface TestkitSwapProviderOptions {
  /** Provider id/name. Must match the provider you register with; defaults to "fixedfloat". */
  readonly name?: string;
  /** Pay-in assets this provider supports. Defaults to all seven built-in assets. */
  readonly supportedAssets?: readonly OpenReceiveSwapPayInAsset[];
  /** Clock in unix seconds. Defaults to a fixed 1000 so tests are deterministic. */
  readonly now?: () => number;
  /** Shadow-invoice expiry the provider requests, in seconds. Defaults to 1620. */
  readonly invoiceExpirySeconds?: number;
  /** Deposit-window length used for provider_expires_at, in seconds. Defaults to 900. */
  readonly depositExpirySeconds?: number;
  /** Per-asset deposit amount the payer must send. Falls back to "1.05". */
  readonly payAmounts?: Partial<Record<OpenReceiveSwapPayInAsset, string>>;
}

/** Selector for scripting/forcing a swap: an asset string, or a specific stored attempt. */
export type TestkitSwapSelector =
  | OpenReceiveSwapPayInAsset
  | { readonly payInAsset?: OpenReceiveSwapPayInAsset; readonly providerOrderId?: string };

interface StoredSwap {
  order: OpenReceiveSwapOrder;
  steps: OpenReceiveSwapProviderState[];
  next: number;
}

export class TestkitSwapProvider implements OpenReceiveSwapProvider {
  readonly name: string;

  createCalls = 0;
  quoteCalls = 0;
  catalogCalls = 0;
  statusCalls = 0;
  readonly createSwapInputs: unknown[] = [];
  readonly quoteInputs: unknown[] = [];
  readonly refundCalls: { readonly providerOrderId: string; readonly refundAddress: string }[] = [];

  readonly #supported: Set<OpenReceiveSwapPayInAsset>;
  readonly #now: () => number;
  readonly #invoiceExpirySeconds: number;
  readonly #depositExpirySeconds: number;
  readonly #payAmounts: Partial<Record<OpenReceiveSwapPayInAsset, string>>;
  readonly #orders = new Map<string, StoredSwap>();
  readonly #pendingScripts = new Map<OpenReceiveSwapPayInAsset, OpenReceiveSwapProviderState[]>();
  #nextCreateError: Error | undefined;

  constructor(options: TestkitSwapProviderOptions = {}) {
    this.name = options.name ?? "fixedfloat";
    this.#supported = new Set(options.supportedAssets ?? DEFAULT_SUPPORTED_ASSETS);
    this.#now = options.now ?? (() => 1000);
    this.#invoiceExpirySeconds = options.invoiceExpirySeconds ?? 1620;
    this.#depositExpirySeconds = options.depositExpirySeconds ?? 900;
    this.#payAmounts = options.payAmounts ?? {};
  }

  async supportedPayInAssets(): Promise<Set<OpenReceiveSwapPayInAsset>> {
    return new Set(this.#supported);
  }

  async payInAssetCatalog(): Promise<readonly OpenReceiveSwapProviderAsset[]> {
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
    readonly payInAsset: OpenReceiveSwapPayInAsset;
    readonly invoiceAmountMsats: number;
  }): Promise<OpenReceiveSwapQuote> {
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
    readonly payInAsset: OpenReceiveSwapPayInAsset;
    readonly bolt11: string;
    readonly invoiceAmountMsats: number;
  }): Promise<OpenReceiveSwapOrder> {
    this.createCalls += 1;
    this.createSwapInputs.push(input);
    if (this.#nextCreateError !== undefined) {
      const error = this.#nextCreateError;
      this.#nextCreateError = undefined;
      throw error;
    }

    const network = ASSET_NETWORK[input.payInAsset];
    const providerOrderId = `testkit-swap-${this.createCalls}`;
    const order: OpenReceiveSwapOrder = {
      provider: this.name,
      provider_order_id: providerOrderId,
      provider_token: `testkit-token-${this.createCalls}`,
      pay_in_asset: input.payInAsset,
      deposit_address: NETWORK_DEPOSIT_ADDRESS[network],
      deposit_amount: this.#payAmountFor(input.payInAsset),
      expires_at: this.#now() + this.#depositExpirySeconds,
      state: "awaiting_deposit",
    };
    const pending = this.#pendingScripts.get(input.payInAsset);
    this.#orders.set(providerOrderId, {
      order,
      steps: pending === undefined ? [] : [...pending],
      next: 0,
    });
    return order;
  }

  async getStatus(order: OpenReceiveSwapOrder): Promise<OpenReceiveSwapOrder> {
    this.statusCalls += 1;
    const stored = this.#orders.get(order.provider_order_id);
    if (stored === undefined) return order;
    if (stored.next < stored.steps.length) {
      const nextState = stored.steps[stored.next];
      stored.next += 1;
      stored.order = applyState(stored.order, nextState);
    }
    return stored.order;
  }

  async requestRefund(order: OpenReceiveSwapOrder, refundAddress: string): Promise<void> {
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
  script(selector: TestkitSwapSelector, states: readonly OpenReceiveSwapProviderState[]): void {
    if (states.length === 0) {
      throw new RangeError("swap script must include at least one state");
    }
    const matched = this.#match(selector);
    for (const stored of matched) {
      stored.steps = [...states];
      stored.next = 0;
    }
    const payInAsset = selectorAsset(selector);
    if (payInAsset !== undefined) {
      this.#pendingScripts.set(payInAsset, [...states]);
    }
  }

  /** Force the next `getStatus` for the selected attempt(s) to report `refund_required`. */
  forceRefundRequired(selector: TestkitSwapSelector): void {
    this.#force(selector, "refund_required");
  }

  /** Force the selected attempt(s) into the `attention` state with a recorded reason. */
  forceAttention(
    selector: TestkitSwapSelector,
    reason: OpenReceiveSwapAttentionReason = "provider_reported_emergency",
  ): void {
    for (const stored of this.#match(selector)) {
      stored.steps = [];
      stored.next = 0;
      stored.order = { ...applyState(stored.order, "attention"), attention_reason: reason };
    }
  }

  /** Make the next `createSwap` call reject, simulating a provider order-creation failure. */
  forceCreateError(error: Error = new Error("testkit swap provider create failed")): void {
    this.#nextCreateError = error;
  }

  #force(selector: TestkitSwapSelector, state: OpenReceiveSwapProviderState): void {
    for (const stored of this.#match(selector)) {
      stored.steps = [];
      stored.next = 0;
      stored.order = applyState(stored.order, state);
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

  #payAmountFor(payInAsset: OpenReceiveSwapPayInAsset): string {
    return this.#payAmounts[payInAsset] ?? "1.05";
  }
}

export function createTestkitSwapProvider(
  options: TestkitSwapProviderOptions = {},
): TestkitSwapProvider {
  return new TestkitSwapProvider(options);
}

function selectorAsset(selector: TestkitSwapSelector): OpenReceiveSwapPayInAsset | undefined {
  return typeof selector === "string" ? selector : selector.payInAsset;
}

function applyState(
  order: OpenReceiveSwapOrder,
  state: OpenReceiveSwapProviderState,
): OpenReceiveSwapOrder {
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

const PROGRESS_ORDER: readonly OpenReceiveSwapProviderState[] = [
  "creating_provider_order",
  "awaiting_deposit",
  "confirming",
  "exchanging",
  "paying_invoice",
  "completed",
];

/** True once the payer's deposit has been detected (confirming or later progress state). */
function atOrAfter(
  state: OpenReceiveSwapProviderState,
  floor: OpenReceiveSwapProviderState,
): boolean {
  const stateIndex = PROGRESS_ORDER.indexOf(state);
  const floorIndex = PROGRESS_ORDER.indexOf(floor);
  return stateIndex >= 0 && floorIndex >= 0 && stateIndex >= floorIndex;
}
