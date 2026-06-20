import {
  OPENRECEIVE_MAX_AMOUNT_MSATS,
  OPENRECEIVE_MIN_AMOUNT_MSATS,
  OPENRECEIVE_NWC_METADATA_MAX_BYTES,
  type LookupInvoiceRequest,
  type LookupInvoiceResult,
  type MakeInvoiceRequest,
  type MakeInvoiceResult,
  type OpenReceiveReceiveNwcClient,
  type OpenReceiveTransactionState,
  type PaymentReceivedNotification,
  type WalletCapabilitySummary
} from "@openreceive/core";

export const TESTKIT_WALLET_PUBKEY = "f".repeat(64);
export const TESTKIT_RELAY = "wss://relay.test.openreceive.local";
export const TESTKIT_PREIMAGE = "1".repeat(64);

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
  #subscribers = new Set<PaymentReceivedHandler>();

  constructor(options: TestkitReceiveClientOptions = {}) {
    this.#now = options.now ?? (() => 1000);
    this.#defaultExpirySeconds = options.defaultExpirySeconds ?? 600;
    this.capabilitySummary = {
      walletPubkey: TESTKIT_WALLET_PUBKEY,
      relays: [TESTKIT_RELAY],
      methods: ["make_invoice", "lookup_invoice"],
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

  async lookupInvoice(request: LookupInvoiceRequest): Promise<LookupInvoiceResult> {
    const stored = this.#find(request);
    if (!stored) {
      throw new Error("testkit invoice not found");
    }

    return serializeLookupInvoice(stored);
  }

  settleInvoice(
    selector: LookupInvoiceRequest,
    options: { readonly settled_at?: number; readonly preimage?: string } = {}
  ): LookupInvoiceResult {
    const stored = this.#require(selector);
    const settledAt = options.settled_at ?? this.#now();
    stored.state = "settled";
    stored.settled_at = settledAt;
    stored.preimage = options.preimage ?? TESTKIT_PREIMAGE;

    const lookup = serializeLookupInvoice(stored);
    this.#notify(this.#notificationFor(stored, lookup));
    return lookup;
  }

  replayPaymentReceived(
    selector: LookupInvoiceRequest,
    count = 1
  ): readonly PaymentReceivedNotification[] {
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new RangeError("count must be a positive safe integer");
    }

    const stored = this.#require(selector);
    const lookup = serializeLookupInvoice(stored);
    const notification = this.#notificationFor(stored, lookup);
    const notifications: PaymentReceivedNotification[] = [];

    for (let index = 0; index < count; index += 1) {
      notifications.push(notification);
      this.#notify(notification);
    }

    return notifications;
  }

  expireInvoice(selector: LookupInvoiceRequest): LookupInvoiceResult {
    const stored = this.#require(selector);
    stored.state = "expired";
    return serializeLookupInvoice(stored);
  }

  failInvoice(selector: LookupInvoiceRequest): LookupInvoiceResult {
    const stored = this.#require(selector);
    stored.state = "failed";
    return serializeLookupInvoice(stored);
  }

  async subscribeToPaymentReceived(
    handler: PaymentReceivedHandler
  ): Promise<() => void> {
    this.#subscribers.add(handler);
    return () => {
      this.#subscribers.delete(handler);
    };
  }

  listInvoices(): readonly LookupInvoiceResult[] {
    return [...this.#byPaymentHash.values()].map(serializeLookupInvoice);
  }

  #store(invoice: TestkitStoredInvoice): TestkitStoredInvoice {
    this.#byPaymentHash.set(invoice.payment_hash, invoice);
    this.#byInvoice.set(invoice.invoice, invoice);
    return invoice;
  }

  #find(request: LookupInvoiceRequest): TestkitStoredInvoice | undefined {
    if (request.payment_hash !== undefined) {
      return this.#byPaymentHash.get(request.payment_hash);
    }
    if (request.invoice !== undefined) {
      return this.#byInvoice.get(request.invoice);
    }
    throw new Error("lookupInvoice requires payment_hash or invoice");
  }

  #require(request: LookupInvoiceRequest): TestkitStoredInvoice {
    const stored = this.#find(request);
    if (!stored) throw new Error("testkit invoice not found");
    return stored;
  }

  #notify(notification: PaymentReceivedNotification): void {
    for (const subscriber of this.#subscribers) {
      void subscriber(notification);
    }
  }

  #notificationFor(
    stored: TestkitStoredInvoice,
    lookup: LookupInvoiceResult
  ): PaymentReceivedNotification {
    return {
      payment_hash: stored.payment_hash,
      invoice: stored.invoice,
      amount_msats: stored.amount_msats,
      ...(stored.settled_at === undefined ? {} : { settled_at: stored.settled_at }),
      raw: lookup
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
  if (request.metadata !== undefined) {
    const bytes = Buffer.byteLength(JSON.stringify(request.metadata), "utf8");
    if (bytes > OPENRECEIVE_NWC_METADATA_MAX_BYTES) {
      throw new Error(`metadata must serialize below ${OPENRECEIVE_NWC_METADATA_MAX_BYTES} bytes`);
    }
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

function serializeLookupInvoice(stored: TestkitStoredInvoice): LookupInvoiceResult {
  return {
    ...serializeMakeInvoice(stored),
    state: stored.state,
    transaction_state: stored.state,
    ...(stored.settled_at === undefined ? {} : { settled_at: stored.settled_at }),
    ...(stored.preimage === undefined ? {} : { preimage: stored.preimage })
  };
}
