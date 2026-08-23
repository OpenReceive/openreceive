/**
 * The receive-only NWC client OpenReceive drives a wallet with.
 *
 * Only the client itself lives here — the transport, the reply normalization,
 * and the error table are separate modules so each is testable without a relay:
 * - `./nwc/transport.ts` — wallet dispatch and the lazily loaded @getalby/sdk client.
 * - `./nwc/normalize.ts` — request building, validation, reply normalization.
 * - `./nwc/errors.ts` — preflight/validation errors and the wallet-error table.
 */

import {
  compact,
  formatOpenReceiveSpendCapabilityRefusedMessage,
  formatOpenReceiveSpendCapabilityWarningMessage,
  type ListTransactionsRequest,
  type ListTransactionsResult,
  type MakeInvoiceRequest,
  type MakeInvoiceResult,
  OpenReceiveError,
  type OpenReceiveReceiveNwcClient,
  type ParsedNwcConnection,
  parseNwcUri,
  type RedactedNwcConnection,
  type WalletCapabilitySummary,
} from "@openreceive/core";
import { normalizeNwcWalletError, WalletPreflightError } from "./nwc/errors.ts";
import {
  type NormalizedListTransactions,
  normalizeListTransactionsResult,
  normalizeMakeInvoiceResult,
  normalizeNwcNotification,
  spendMethodsIn,
  summarizeWalletCapabilities,
  toNip47ListTransactionsParams,
  toNip47MakeInvoiceParams,
  validateListTransactionsRequest,
  validateMakeInvoiceRequest,
} from "./nwc/normalize.ts";
import {
  type AlbyNwcCompatibleClient,
  callRequiredMethod,
  closeNwcNotificationSubscription,
  createDefaultAlbyNwcClient,
  delay,
} from "./nwc/transport.ts";

export type { WalletPreflightErrorCode } from "./nwc/errors.ts";
export {
  normalizeNwcWalletError,
  ReceiveCheckoutValidationError,
  WalletPreflightError,
} from "./nwc/errors.ts";
export type { NwcWalletNotification } from "./nwc/normalize.ts";
export { summarizeWalletCapabilities } from "./nwc/normalize.ts";
export type { AlbyNwcCompatibleClient } from "./nwc/transport.ts";

import type { NwcWalletNotification } from "./nwc/normalize.ts";

/** Default pause after a spend-capability warning so operators can read it. */
export const SPEND_CAPABILITY_WARNING_DELAY_MS = 5_000;

export type NwcWalletNotificationHandler = (notification: NwcWalletNotification) => void;

export type NwcNotificationUnsubscribe = () => Promise<void> | void;

export type AlbyNwcClientFactory = (
  connection: ParsedNwcConnection,
) => Promise<AlbyNwcCompatibleClient> | AlbyNwcCompatibleClient;

export type NwcEndpointLogLevel = "debug" | "info" | "warn" | "error";

export interface NwcEndpointLogEntry {
  readonly level: NwcEndpointLogLevel;
  readonly event: string;
  readonly message: string;
  readonly [key: string]: unknown;
}

/**
 * Server-side hook invoked every time the receive client hits an NWC wallet
 * endpoint (get_info / make_invoice / list_transactions). Structurally
 * compatible with the node service's Logger so the same sink can be
 * reused. The hook must never throw — failures are swallowed so diagnostics can
 * never change receive-checkout behavior.
 */
export type NwcEndpointLogger = (entry: NwcEndpointLogEntry) => void;

export interface AlbyNwcReceiveClientOptions {
  connectionString: string;
  client?: AlbyNwcCompatibleClient;
  clientFactory?: AlbyNwcClientFactory;
  requirePreflight?: boolean;
  logger?: NwcEndpointLogger;
  /**
   * Explicit override: boot even when the connection advertises spend methods
   * such as `pay_invoice` — in `get_info.methods`, or in the kind-13194 info
   * event when the client exposes no `get_info`. Defaults to `false`, which
   * makes preflight fail closed on a spend-capable connection.
   */
  allowSpendCapableWallet?: boolean;
  /**
   * Pause after warning that the info event advertises spend methods (override
   * path only). Defaults to {@link SPEND_CAPABILITY_WARNING_DELAY_MS}. Set `0` in tests.
   */
  spendCapabilityWarningDelayMs?: number;
  /** Sink for the spend-capability warning (override path only). Defaults to `console.error`. */
  spendCapabilityWarning?: (message: string) => void;
}

export class AlbyNwcReceiveClient implements OpenReceiveReceiveNwcClient {
  /**
   * Safe, loggable view of the connection (wallet pubkey, relays, lud16, and
   * the secret-redacted URI). The parsed connection with the client secret is
   * deliberately private: `console.log(client)` or host error serialization
   * must never leak the secret.
   */
  readonly connection: RedactedNwcConnection;

  #connection: ParsedNwcConnection;
  #connectionString: string;
  #client?: AlbyNwcCompatibleClient;
  #clientPromise?: Promise<AlbyNwcCompatibleClient>;
  #clientFactory?: AlbyNwcClientFactory;
  #preflightSummary?: WalletCapabilitySummary;
  #preflightPromise?: Promise<WalletCapabilitySummary>;
  #requirePreflight: boolean;
  #logger?: NwcEndpointLogger;
  #allowSpendCapableWallet: boolean;
  #spendCapabilityWarningDelayMs: number;
  #spendCapabilityWarning: (message: string) => void;
  #closed = false;

  constructor(options: AlbyNwcReceiveClientOptions) {
    this.#connectionString = options.connectionString;
    this.#connection = parseNwcUri(options.connectionString);
    this.connection = {
      walletPubkey: this.#connection.walletPubkey,
      relays: [...this.#connection.relays],
      ...(this.#connection.lud16 === undefined ? {} : { lud16: this.#connection.lud16 }),
      redacted: this.#connection.redacted,
    };
    this.#client = options.client;
    this.#clientFactory = options.clientFactory;
    this.#requirePreflight = options.requirePreflight ?? true;
    this.#logger = options.logger;
    this.#allowSpendCapableWallet = options.allowSpendCapableWallet ?? false;
    this.#spendCapabilityWarningDelayMs =
      options.spendCapabilityWarningDelayMs ?? SPEND_CAPABILITY_WARNING_DELAY_MS;
    this.#spendCapabilityWarning =
      options.spendCapabilityWarning ?? ((message) => console.error(message));
  }

  #log(
    level: NwcEndpointLogLevel,
    event: string,
    message: string,
    fields: Record<string, unknown> = {},
  ): void {
    if (this.#logger === undefined) return;
    try {
      this.#logger({
        level,
        event,
        message,
        wallet_pubkey: this.connection.walletPubkey,
        ...fields,
      });
    } catch {
      // Endpoint logging must never change receive-checkout behavior.
    }
  }

  async preflight(): Promise<WalletCapabilitySummary> {
    const client = await this.getClient();
    // NIP-47 keeps two lists apart. `get_info.methods` is what THIS connection
    // may call; the kind-13194 info event advertises the wallet service at
    // large, plus its encryption modes. Receive-only is proved from the
    // connection's own list — a service that also serves spend-capable apps
    // still hands out receive-only connections — and the event supplies
    // encryption. The event stands in for the method list only when the
    // client exposes no get_info.
    const hasGetInfo =
      typeof client.getInfo === "function" || typeof client.get_info === "function";
    const hasInfoEvent = typeof client.getWalletServiceInfo === "function";
    const rawInfo =
      hasGetInfo || !hasInfoEvent
        ? await this.#fetchWalletInfo("get_info", () =>
            callRequiredMethod(client, ["getInfo", "get_info"], {}),
          )
        : undefined;
    const rawServiceInfo = hasInfoEvent
      ? await this.#fetchWalletInfo("info_event", () =>
          (client.getWalletServiceInfo as () => Promise<unknown>)(),
        )
      : undefined;
    if (rawInfo === undefined) {
      this.#log(
        "warn",
        "nwc.info_event.methods_fallback",
        "NWC client exposes no get_info; proving receive-only from the service-wide info event (kind 13194) rather than this connection's own method list.",
      );
    }
    const summary = summarizeWalletCapabilities(
      this.#connection,
      rawInfo ?? rawServiceInfo,
      rawServiceInfo,
    );

    this.#log("debug", "nwc.preflight.summarized", "NWC wallet capabilities summarized.", {
      methods_source: rawInfo === undefined ? "info_event" : "get_info",
      methods: summary.methods,
      encryption: summary.encryption,
      receive_checkout_ready: summary.receiveCheckoutReady,
      spend_capability_advertised: summary.spendCapabilityAdvertised,
    });

    if (!summary.receiveCheckoutReady) {
      throw new WalletPreflightError(
        "missing_required_method",
        "NWC wallet must advertise make_invoice and list_transactions for receive checkout.",
        summary,
      );
    }

    if (summary.encryption !== "nip04" && summary.encryption !== "nip44_v2") {
      throw new WalletPreflightError(
        "unsupported_encryption",
        "NWC wallet must support NIP-04 or NIP-44 v2 encryption.",
        summary,
      );
    }

    // A leaked spend-capable NWC secret can drain the wallet from any NIP-47
    // client, so preflight fails closed unless the host explicitly overrides.
    if (summary.spendCapabilityAdvertised) {
      const spendMethods = spendMethodsIn(summary.methods);
      if (!this.#allowSpendCapableWallet) {
        this.#log(
          "error",
          "nwc.spend_capability_advertised",
          "NWC connection advertises send-payment methods; refusing to boot without an explicit override.",
          { methods: spendMethods },
        );
        throw new WalletPreflightError(
          "spend_capability_advertised",
          formatOpenReceiveSpendCapabilityRefusedMessage({ spendMethods }),
          summary,
        );
      }
      const warning = formatOpenReceiveSpendCapabilityWarningMessage({
        spendMethods,
      });
      this.#log(
        "error",
        "nwc.spend_capability_advertised",
        "NWC connection advertises send-payment methods; continuing because the spend-capable override is set.",
        { methods: spendMethods },
      );
      try {
        this.#spendCapabilityWarning(warning);
      } catch {
        // Warning sinks must never change receive-checkout behavior.
      }
      if (this.#spendCapabilityWarningDelayMs > 0) {
        await delay(this.#spendCapabilityWarningDelayMs);
      }
    }

    // Cached only once every refusal above has been cleared: a summary stored
    // before the checks would let a caller swallow the refusal and retry
    // make_invoice / list_transactions, which ensurePreflight then waves
    // through. The boot gate has to hold for the life of the client.
    this.#preflightSummary = summary;

    return summary;
  }

  async makeInvoice(request: MakeInvoiceRequest): Promise<MakeInvoiceResult> {
    await this.ensurePreflight();
    validateMakeInvoiceRequest(request);

    this.#log(
      "debug",
      "nwc.make_invoice.requested",
      "Calling NWC wallet make_invoice.",
      compact({
        method: "make_invoice",
        // String form: msats above 2^53 would silently round through Number().
        amount_msats: request.amount_msats.toString(),
        expiry: request.expiry,
        has_description: request.description !== undefined,
        has_description_hash: request.description_hash !== undefined,
      }),
    );
    const startedAt = Date.now();

    let rawResult: unknown;
    try {
      rawResult = await callRequiredMethod(
        await this.getClient(),
        ["makeInvoice", "make_invoice"],
        toNip47MakeInvoiceParams(request),
      );
    } catch (error) {
      const normalized = normalizeNwcWalletError(error);
      this.#log("error", "nwc.make_invoice.failed", "NWC wallet make_invoice failed.", {
        method: "make_invoice",
        duration_ms: Date.now() - startedAt,
        error_code: normalized.code,
        error_message: normalized.message,
      });
      throw normalized;
    }

    let result: MakeInvoiceResult;
    try {
      result = normalizeMakeInvoiceResult(rawResult);
    } catch (error) {
      // Normalization failures (missing invoice, malformed payment_hash) take
      // the same normalized + logged path as transport failures.
      const normalized = normalizeNwcWalletError(error);
      this.#log("error", "nwc.make_invoice.failed", "NWC wallet make_invoice failed.", {
        method: "make_invoice",
        duration_ms: Date.now() - startedAt,
        error_code: normalized.code,
        error_message: normalized.message,
      });
      throw normalized;
    }
    this.#log("debug", "nwc.make_invoice.completed", "NWC wallet make_invoice completed.", {
      method: "make_invoice",
      duration_ms: Date.now() - startedAt,
      payment_hash: result.payment_hash,
      amount_msats: result.amount_msats.toString(),
    });
    return result;
  }

  async listTransactions(request: ListTransactionsRequest): Promise<ListTransactionsResult> {
    await this.ensurePreflight();
    validateListTransactionsRequest(request);

    this.#log(
      "debug",
      "nwc.list_transactions.requested",
      "Calling NWC wallet list_transactions.",
      compact({
        method: "list_transactions",
        from: request.from,
        until: request.until,
        limit: request.limit,
        offset: request.offset,
        unpaid: request.unpaid,
        type: request.type,
      }),
    );
    const startedAt = Date.now();

    let rawResult: unknown;
    try {
      rawResult = await callRequiredMethod(
        await this.getClient(),
        ["listTransactions", "list_transactions"],
        toNip47ListTransactionsParams(request),
      );
    } catch (error) {
      const normalized = normalizeNwcWalletError(error);
      this.#log("error", "nwc.list_transactions.failed", "NWC wallet list_transactions failed.", {
        method: "list_transactions",
        duration_ms: Date.now() - startedAt,
        error_code: normalized.code,
        error_message: normalized.message,
      });
      throw normalized;
    }

    let result: NormalizedListTransactions;
    try {
      result = normalizeListTransactionsResult(rawResult);
    } catch (error) {
      // Normalization failures (unrecognized reply shape) take the same
      // normalized + logged path as transport failures.
      const normalized = normalizeNwcWalletError(error);
      this.#log("error", "nwc.list_transactions.failed", "NWC wallet list_transactions failed.", {
        method: "list_transactions",
        duration_ms: Date.now() - startedAt,
        error_code: normalized.code,
        error_message: normalized.message,
      });
      throw normalized;
    }
    if (result.skippedRows > 0) {
      this.#log(
        "warn",
        "nwc.list_transactions.rows_skipped",
        "Skipped wallet transaction rows that could not be normalized.",
        {
          method: "list_transactions",
          skipped_count: result.skippedRows,
        },
      );
    }
    this.#log(
      "debug",
      "nwc.list_transactions.completed",
      "NWC wallet list_transactions completed.",
      {
        method: "list_transactions",
        duration_ms: Date.now() - startedAt,
        transaction_count: result.transactions.length,
      },
    );
    return { transactions: result.transactions };
  }

  /**
   * Opt-in NWC-02 notification subscription, limited to `payment_received`.
   * Notifications are authenticated wallet data: the handler receives the
   * payload normalized like a `list_transactions` row so a payload satisfying
   * the settlement rule can settle its pending attempt directly, while
   * anything less only wakes reconciliation. Direct settlement assumes the
   * client binds notification decryption to the connection's wallet pubkey
   * (the bundled @getalby/sdk does). Resolves to an unsubscribe function.
   * Throws an OpenReceiveError with code `UNSUPPORTED_METHOD` when the
   * underlying wallet client does not support NWC notifications.
   */
  async subscribeNotifications(
    handler: NwcWalletNotificationHandler,
  ): Promise<NwcNotificationUnsubscribe> {
    const client = await this.getClient();
    const subscribe = client.subscribeNotifications;
    if (typeof subscribe !== "function") {
      throw new OpenReceiveError({
        code: "UNSUPPORTED_METHOD",
        message:
          "NWC wallet client does not support NWC notifications (subscribeNotifications). Keep polling reconciliation.",
        retryable: false,
      });
    }

    this.#log(
      "debug",
      "nwc.notifications.subscribe.requested",
      "Subscribing to NWC-02 payment_received notifications.",
      { notification_types: ["payment_received"] },
    );

    let subscription: unknown;
    try {
      subscription = await subscribe.call(
        client,
        (rawNotification: unknown) => {
          const notification = normalizeNwcNotification(rawNotification);
          // Defense in depth: some clients ignore the requested type filter.
          if (notification.type !== "payment_received") return;
          // Log only the type and payment hash — never the payload.
          this.#log(
            "debug",
            "nwc.notifications.received",
            "NWC payment_received notification received.",
            compact({
              notification_type: notification.type,
              payment_hash: notification.payment_hash,
            }),
          );
          try {
            handler(notification);
          } catch {
            // Notification hints must never break the subscription.
          }
        },
        ["payment_received"],
      );
    } catch (error) {
      const normalized = normalizeNwcWalletError(error);
      this.#log(
        "error",
        "nwc.notifications.subscribe.failed",
        "NWC notification subscription failed.",
        { error_code: normalized.code, error_message: normalized.message },
      );
      throw normalized;
    }

    this.#log(
      "info",
      "nwc.notifications.subscribe.completed",
      "Subscribed to NWC-02 payment_received notifications; polling reconciliation remains the safety net.",
    );

    return async () => {
      await closeNwcNotificationSubscription(subscription);
      this.#log(
        "info",
        "nwc.notifications.unsubscribed",
        "Unsubscribed from NWC-02 wallet notifications.",
      );
    };
  }

  async #fetchWalletInfo(
    source: "get_info" | "info_event",
    call: () => Promise<unknown>,
  ): Promise<unknown> {
    const method = source === "get_info" ? "get_info" : "getWalletServiceInfo";
    const label = source === "get_info" ? "get_info" : "info event (kind 13194)";
    this.#log("debug", `nwc.${source}.requested`, `Fetching NWC wallet ${label}.`, { method });
    const startedAt = Date.now();
    try {
      const raw = await call();
      this.#log("debug", `nwc.${source}.completed`, `NWC wallet ${label} loaded.`, {
        method,
        duration_ms: Date.now() - startedAt,
      });
      return raw;
    } catch (error) {
      const normalized = normalizeNwcWalletError(error);
      this.#log("error", `nwc.${source}.failed`, `NWC wallet ${label} fetch failed.`, {
        method,
        duration_ms: Date.now() - startedAt,
        error_code: normalized.code,
        error_message: normalized.message,
      });
      throw normalized;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    // An in-flight getClient finishes constructing the client after a bare
    // close would have returned; wait for it so the relay socket never leaks
    // — the discipline stack.ts applies one layer up.
    const client = this.#client ?? (await this.#clientPromise?.catch(() => undefined));
    this.#client = undefined;
    this.#clientPromise = undefined;
    await client?.close?.();
  }

  private async ensurePreflight(): Promise<void> {
    if (!this.#requirePreflight || this.#preflightSummary !== undefined) return;
    // Memoize the in-flight promise so concurrent first calls share one
    // preflight; a failure clears it so the next call retries.
    this.#preflightPromise ??= this.preflight();
    try {
      await this.#preflightPromise;
    } catch (error) {
      this.#preflightPromise = undefined;
      throw error;
    }
  }

  private async getClient(): Promise<AlbyNwcCompatibleClient> {
    if (this.#closed) {
      throw new Error("OpenReceive NWC receive client is closed; create a new client.");
    }
    if (this.#client !== undefined) return this.#client;

    // Memoize the in-flight promise so concurrent first calls share one client
    // instead of constructing two and leaking the one that loses the race.
    this.#clientPromise ??= (async () => {
      const client =
        this.#clientFactory !== undefined
          ? await this.#clientFactory(this.#connection)
          : await createDefaultAlbyNwcClient(this.#connectionString);
      this.#client = client;
      return client;
    })();
    try {
      return await this.#clientPromise;
    } catch (error) {
      this.#clientPromise = undefined;
      throw error;
    }
  }
}

export function createNwcReceiveClient(options: AlbyNwcReceiveClientOptions): AlbyNwcReceiveClient {
  return new AlbyNwcReceiveClient(options);
}
