import {
  OPENRECEIVE_MAX_AMOUNT_MSATS,
  OPENRECEIVE_MIN_AMOUNT_MSATS,
  OPENRECEIVE_NWC_METADATA_MAX_BYTES,
  type ListTransactionsRequest,
  type ListTransactionsResult,
  type MakeInvoiceRequest,
  type MakeInvoiceResult,
  type NwcTransaction,
  type OpenReceiveReceiveNwcClient,
  type OpenReceiveTransactionState,
  type PaymentReceivedNotification,
  type WalletCapabilitySummary
} from "@openreceive/core";

export const TESTKIT_WALLET_PUBKEY = "f".repeat(64);
export const TESTKIT_RELAY = "wss://relay.test.openreceive.local";
export const TESTKIT_PREIMAGE = "1".repeat(64);

const HEX_64 = /^[0-9a-fA-F]{64}$/;

export interface TestkitInvoiceFixture extends MakeInvoiceResult {
  readonly state?: OpenReceiveTransactionState;
  readonly settled_at?: number;
  readonly preimage?: string;
}

export interface TestkitReceiveClientOptions {
  readonly now?: () => number;
  readonly defaultExpirySeconds?: number;
  readonly initialInvoices?: readonly TestkitInvoiceFixture[];
  readonly capabilitySummary?: Partial<WalletCapabilitySummary>;
}

export interface TestkitInvoiceSelector {
  readonly payment_hash?: string;
  readonly invoice?: string;
}

export type TestkitTransactionScriptStep =
  | {
      readonly state: OpenReceiveTransactionState;
      readonly settled_at?: number;
      readonly preimage?: string;
    }
  | {
      readonly result: NwcTransaction;
    }
  | {
      readonly error: Error | string;
    };

interface TestkitStoredInvoice {
  invoice: string;
  payment_hash: string;
  amount_msats: bigint;
  created_at: number;
  expires_at: number;
  state: OpenReceiveTransactionState;
  settled_at?: number;
  preimage?: string;
}

interface TestkitTransactionScript {
  readonly steps: TestkitTransactionScriptStep[];
  next: number;
}

type PaymentReceivedHandler = (
  notification: PaymentReceivedNotification
) => Promise<void> | void;

export class TestkitReceiveClient implements OpenReceiveReceiveNwcClient {
  readonly capabilitySummary: WalletCapabilitySummary;

  #now: () => number;
  #defaultExpirySeconds: number;
  #counter = 0;
  #byPaymentHash = new Map<string, TestkitStoredInvoice>();
  #byInvoice = new Map<string, TestkitStoredInvoice>();
  #transactionScripts = new Map<TestkitStoredInvoice, TestkitTransactionScript>();
  #subscribers = new Set<PaymentReceivedHandler>();

  constructor(options: TestkitReceiveClientOptions = {}) {
    this.#now = options.now ?? (() => 1000);
    this.#defaultExpirySeconds = options.defaultExpirySeconds ?? 600;
    this.capabilitySummary = {
      walletPubkey: TESTKIT_WALLET_PUBKEY,
      relays: [TESTKIT_RELAY],
      methods: ["make_invoice", "list_transactions"],
      notifications: ["payment_received"],
      encryption: "nip04",
      spendCapabilityAdvertised: false,
      receiveCheckoutReady: true,
      warnings: [],
      ...options.capabilitySummary
    };

    for (const invoice of options.initialInvoices ?? []) {
      this.#store({
        invoice: invoice.invoice,
        payment_hash: invoice.payment_hash,
        amount_msats: invoice.amount_msats,
        created_at: invoice.created_at ?? this.#now(),
        expires_at:
          invoice.expires_at ??
          (invoice.created_at ?? this.#now()) + this.#defaultExpirySeconds,
        state: invoice.state ?? "pending",
        ...(invoice.settled_at === undefined ? {} : { settled_at: invoice.settled_at }),
        ...(invoice.preimage === undefined ? {} : { preimage: invoice.preimage })
      });
    }
  }

  async preflight(): Promise<WalletCapabilitySummary> {
    return this.capabilitySummary;
  }

  async makeInvoice(request: MakeInvoiceRequest): Promise<MakeInvoiceResult> {
    validateMakeInvoiceRequest(request);
    this.#counter += 1;

    const createdAt = this.#now();
    const expiresAt = createdAt + (request.expiry ?? this.#defaultExpirySeconds);
    const paymentHash = deterministicHex(this.#counter);
    const invoice = `lnbcopenreceive${this.#counter.toString().padStart(6, "0")}`;
    const stored = this.#store({
      invoice,
      payment_hash: paymentHash,
      amount_msats: request.amount_msats,
      created_at: createdAt,
      expires_at: expiresAt,
      state: "pending"
    });

    return serializeMakeInvoice(stored);
  }

  async listTransactions(request: ListTransactionsRequest = {}): Promise<ListTransactionsResult> {
    validateListTransactionsRequest(request);
    if (request.type === "outgoing") {
      return { transactions: [] };
    }

    const from = request.from ?? 0;
    const until = request.until ?? Number.MAX_SAFE_INTEGER;
    const limit = request.limit ?? Number.MAX_SAFE_INTEGER;
    const offset = request.offset ?? 0;
    const includeUnpaid = request.unpaid ?? false;
    const eligible = [...this.#byPaymentHash.values()]
      .filter((stored) => stored.created_at >= from && stored.created_at <= until)
      .filter((stored) => includeUnpaid || stored.state === "settled")
      .sort((left, right) =>
        left.created_at === right.created_at
          ? right.payment_hash.localeCompare(left.payment_hash)
          : right.created_at - left.created_at
      )
      .slice(offset, offset + limit);

    return {
      transactions: eligible.map((stored) => this.#serializeTransaction(stored))
    };
  }

  scriptTransactionSequence(
    selector: TestkitInvoiceSelector,
    steps: readonly TestkitTransactionScriptStep[]
  ): void {
    if (steps.length === 0) {
      throw new RangeError("transaction script must include at least one step");
    }

    const stored = this.#require(selector);
    this.#transactionScripts.set(stored, {
      steps: [...steps],
      next: 0
    });
  }

  clearTransactionSequence(selector: TestkitInvoiceSelector): void {
    this.#transactionScripts.delete(this.#require(selector));
  }

  settleInvoice(
    selector: TestkitInvoiceSelector,
    options: { readonly settled_at?: number; readonly preimage?: string } = {}
  ): NwcTransaction {
    const stored = this.#require(selector);
    const settledAt = options.settled_at ?? this.#now();
    stored.state = "settled";
    stored.settled_at = settledAt;
    stored.preimage = options.preimage ?? TESTKIT_PREIMAGE;

    const transaction = serializeTransaction(stored);
    this.#notify(this.#notificationFor(stored, transaction));
    return transaction;
  }

  replayPaymentReceived(
    selector: TestkitInvoiceSelector,
    count = 1
  ): readonly PaymentReceivedNotification[] {
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new RangeError("count must be a positive safe integer");
    }

    const stored = this.#require(selector);
    const transaction = serializeTransaction(stored);
    const notification = this.#notificationFor(stored, transaction);
    const notifications: PaymentReceivedNotification[] = [];

    for (let index = 0; index < count; index += 1) {
      notifications.push(notification);
      this.#notify(notification);
    }

    return notifications;
  }

  expireInvoice(selector: TestkitInvoiceSelector): NwcTransaction {
    const stored = this.#require(selector);
    stored.state = "expired";
    return serializeTransaction(stored);
  }

  failInvoice(selector: TestkitInvoiceSelector): NwcTransaction {
    const stored = this.#require(selector);
    stored.state = "failed";
    return serializeTransaction(stored);
  }

  async subscribeToPaymentReceived(
    handler: PaymentReceivedHandler
  ): Promise<() => void> {
    this.#subscribers.add(handler);
    return () => {
      this.#subscribers.delete(handler);
    };
  }

  listInvoices(): readonly NwcTransaction[] {
    return [...this.#byPaymentHash.values()].map(serializeTransaction);
  }

  #store(invoice: TestkitStoredInvoice): TestkitStoredInvoice {
    this.#byPaymentHash.set(invoice.payment_hash, invoice);
    this.#byInvoice.set(invoice.invoice, invoice);
    return invoice;
  }

  #find(request: TestkitInvoiceSelector): TestkitStoredInvoice | undefined {
    if (request.payment_hash !== undefined) {
      return this.#byPaymentHash.get(request.payment_hash);
    }
    if (request.invoice !== undefined) {
      return this.#byInvoice.get(request.invoice);
    }
    throw new Error("invoice selector requires payment_hash or invoice");
  }

  #require(request: TestkitInvoiceSelector): TestkitStoredInvoice {
    const stored = this.#find(request);
    if (!stored) throw new Error("testkit invoice not found");
    return stored;
  }

  #notify(notification: PaymentReceivedNotification): void {
    for (const subscriber of this.#subscribers) {
      void subscriber(notification);
    }
  }

  #nextScriptedTransaction(
    stored: TestkitStoredInvoice
  ): NwcTransaction | undefined {
    const script = this.#transactionScripts.get(stored);
    if (script === undefined || script.next >= script.steps.length) {
      return undefined;
    }

    const step = script.steps[script.next];
    script.next += 1;

    if (step === undefined) return undefined;
    if ("error" in step) {
      throw step.error instanceof Error ? step.error : new Error(step.error);
    }
    if ("result" in step) return step.result;

    stored.state = step.state;
    if (step.settled_at === undefined) {
      delete stored.settled_at;
    } else {
      stored.settled_at = step.settled_at;
    }
    if (step.preimage === undefined) {
      delete stored.preimage;
    } else {
      stored.preimage = step.preimage;
    }

    return serializeTransaction(stored);
  }

  #serializeTransaction(stored: TestkitStoredInvoice): NwcTransaction {
    const scripted = this.#nextScriptedTransaction(stored);
    if (scripted !== undefined) return scripted;
    return serializeTransaction(stored);
  }

  #notificationFor(
    stored: TestkitStoredInvoice,
    transaction: NwcTransaction
  ): PaymentReceivedNotification {
    return {
      payment_hash: stored.payment_hash,
      invoice: stored.invoice,
      amount_msats: stored.amount_msats,
      ...(stored.settled_at === undefined ? {} : { settled_at: stored.settled_at }),
      raw: transaction
    };
  }
}

export function createTestkitReceiveClient(
  options: TestkitReceiveClientOptions = {}
): TestkitReceiveClient {
  return new TestkitReceiveClient(options);
}

function validateMakeInvoiceRequest(request: MakeInvoiceRequest): void {
  if (request.amount_msats < OPENRECEIVE_MIN_AMOUNT_MSATS) {
    throw new Error("amount_msats must be at least 1000");
  }
  if (request.amount_msats > OPENRECEIVE_MAX_AMOUNT_MSATS) {
    throw new Error("amount_msats exceeds JSON safe integer boundary");
  }
  if (
    request.description !== undefined &&
    request.description_hash !== undefined
  ) {
    throw new Error("Exactly one of description or description_hash may be present");
  }
  if (request.description_hash !== undefined && !HEX_64.test(request.description_hash)) {
    throw new Error("description_hash must be 64 hex characters");
  }
  if (request.metadata !== undefined) {
    const bytes = Buffer.byteLength(JSON.stringify(request.metadata), "utf8");
    if (bytes > OPENRECEIVE_NWC_METADATA_MAX_BYTES) {
      throw new Error(`metadata must serialize below ${OPENRECEIVE_NWC_METADATA_MAX_BYTES} bytes`);
    }
  }
}

function validateListTransactionsRequest(request: ListTransactionsRequest): void {
  validateOptionalNonNegativeInteger(request.from, "from");
  validateOptionalNonNegativeInteger(request.until, "until");
  validateOptionalNonNegativeInteger(request.offset, "offset");
  if (request.limit !== undefined && (!Number.isSafeInteger(request.limit) || request.limit <= 0)) {
    throw new Error("limit must be a positive safe integer");
  }
  if (request.from !== undefined && request.until !== undefined && request.from > request.until) {
    throw new Error("from must be less than or equal to until");
  }
  if (request.type !== undefined && request.type !== "incoming" && request.type !== "outgoing") {
    throw new Error("type must be incoming or outgoing");
  }
}

function validateOptionalNonNegativeInteger(
  value: number | undefined,
  field: string
): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
}

function deterministicHex(counter: number): string {
  return counter.toString(16).padStart(64, "0");
}

function serializeMakeInvoice(stored: TestkitStoredInvoice): MakeInvoiceResult {
  return {
    invoice: stored.invoice,
    payment_hash: stored.payment_hash,
    amount_msats: stored.amount_msats,
    created_at: stored.created_at,
    expires_at: stored.expires_at
  };
}

function serializeTransaction(stored: TestkitStoredInvoice): NwcTransaction {
  return {
    type: "incoming",
    ...serializeMakeInvoice(stored),
    state: stored.state,
    transaction_state: stored.state,
    ...(stored.settled_at === undefined ? {} : { settled_at: stored.settled_at }),
    ...(stored.preimage === undefined ? {} : { preimage: stored.preimage })
  };
}
