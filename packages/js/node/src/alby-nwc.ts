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
  formatOpenReceiveSpendCapabilityRefusedMessage,
  formatOpenReceiveSpendCapabilityWarningMessage,
  OpenReceiveError,
  parseNwcUri,
  type ListTransactionsRequest,
  type ListTransactionsResult,
  type MakeInvoiceRequest,
  type MakeInvoiceResult,
  type OpenReceiveReceiveNwcClient,
  type ParsedNwcConnection,
  type RedactedNwcConnection,
  type WalletCapabilitySummary,
} from "@openreceive/core";
import { normalizeNwcWalletError, WalletPreflightError } from "./nwc/errors.ts";
import {
  normalizeListTransactionsResult,
  normalizeMakeInvoiceResult,
  normalizeNwcNotification,
  spendMethodsIn,
  summarizeWalletCapabilities,
  toNip47ListTransactionsParams,
  toNip47MakeInvoiceParams,
  validateListTransactionsRequest,
  validateMakeInvoiceRequest,
  type NormalizedListTransactions,
} from "./nwc/normalize.ts";
import {
  callRequiredMethod,
  closeNwcNotificationSubscription,
  createDefaultAlbyNwcClient,
  delay,
  type AlbyNwcCompatibleClient,
} from "./nwc/transport.ts";

export {
  normalizeNwcWalletError,
  ReceiveCheckoutValidationError,
  WalletPreflightError,
} from "./nwc/errors.ts";
export type { WalletPreflightErrorCode } from "./nwc/errors.ts";
export { summarizeWalletCapabilities } from "./nwc/normalize.ts";
export type { NwcWalletNotification } from "./nwc/normalize.ts";
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
   * Explicit override: boot even when the wallet info event advertises spend
   * methods such as `pay_invoice`. Defaults to `false`, which makes preflight
   * fail closed on a spend-capable connection.
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
  #clientFactory?: AlbyNwcClientFactory;
  #preflightSummary?: WalletCapabilitySummary;
  #requirePreflight: boolean;
  #logger?: NwcEndpointLogger;
  #allowSpendCapableWallet: boolean;
  #spendCapabilityWarningDelayMs: number;
  #spendCapabilityWarning: (message: string) => void;

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
    // Prefer the NIP-47 info event (kind 13194) via getWalletServiceInfo when available.
    const usesInfoEvent = typeof client.getWalletServiceInfo === "function";
    const infoMethod = usesInfoEvent ? "getWalletServiceInfo" : "get_info";
    this.#log(
      "debug",
      usesInfoEvent ? "nwc.info_event.requested" : "nwc.get_info.requested",
      usesInfoEvent
        ? "Fetching NWC wallet info event (kind 13194)."
        : "Calling NWC wallet get_info.",
      { method: infoMethod },
    );
    const startedAt = Date.now();
    let rawInfo: unknown;
    try {
      rawInfo =
        usesInfoEvent && client.getWalletServiceInfo !== undefined
          ? await client.getWalletServiceInfo()
          : await callRequiredMethod(client, ["getInfo", "get_info"], {});
    } catch (error) {
      const normalized = normalizeNwcWalletError(error);
      this.#log(
        "error",
        usesInfoEvent ? "nwc.info_event.failed" : "nwc.get_info.failed",
        usesInfoEvent
          ? "NWC wallet info event (kind 13194) fetch failed."
          : "NWC wallet get_info failed.",
        {
          method: infoMethod,
          duration_ms: Date.now() - startedAt,
          error_code: normalized.code,
          error_message: normalized.message,
        },
      );
      throw normalized;
    }
    const summary = summarizeWalletCapabilities(this.#connection, rawInfo);

    this.#log(
      "debug",
      usesInfoEvent ? "nwc.info_event.completed" : "nwc.get_info.completed",
      usesInfoEvent
        ? "NWC wallet info event (kind 13194) loaded."
        : "NWC wallet get_info completed.",
      {
        method: infoMethod,
        duration_ms: Date.now() - startedAt,
        methods: summary.methods,
        receive_checkout_ready: summary.receiveCheckoutReady,
        spend_capability_advertised: summary.spendCapabilityAdvertised,
      },
    );

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
          "NWC info event advertises send-payment methods; refusing to boot without an explicit override.",
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
        "NWC info event advertises send-payment methods; continuing because the spend-capable override is set.",
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

    this.#log("debug", "nwc.make_invoice.requested", "Calling NWC wallet make_invoice.", {
      method: "make_invoice",
      // String form: msats above 2^53 would silently round through Number().
      amount_msats: request.amount_msats.toString(),
      ...(request.expiry === undefined ? {} : { expiry: request.expiry }),
      has_description: request.description !== undefined,
      has_description_hash: request.description_hash !== undefined,
    });
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

    const result = normalizeMakeInvoiceResult(rawResult);
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

    this.#log("debug", "nwc.list_transactions.requested", "Calling NWC wallet list_transactions.", {
      method: "list_transactions",
      ...(request.from === undefined ? {} : { from: request.from }),
      ...(request.until === undefined ? {} : { until: request.until }),
      ...(request.limit === undefined ? {} : { limit: request.limit }),
      ...(request.offset === undefined ? {} : { offset: request.offset }),
      ...(request.unpaid === undefined ? {} : { unpaid: request.unpaid }),
      ...(request.type === undefined ? {} : { type: request.type }),
    });
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
            {
              notification_type: notification.type,
              ...(notification.payment_hash === undefined
                ? {}
                : { payment_hash: notification.payment_hash }),
            },
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

  async close(): Promise<void> {
    await this.#client?.close?.();
  }

  private async ensurePreflight(): Promise<void> {
    if (!this.#requirePreflight || this.#preflightSummary !== undefined) return;
    await this.preflight();
  }

  private async getClient(): Promise<AlbyNwcCompatibleClient> {
    if (this.#client !== undefined) return this.#client;

    if (this.#clientFactory !== undefined) {
      this.#client = await this.#clientFactory(this.#connection);
      return this.#client;
    }

    this.#client = await createDefaultAlbyNwcClient(this.#connectionString);
    return this.#client;
  }
}

export function createNwcReceiveClient(options: AlbyNwcReceiveClientOptions): AlbyNwcReceiveClient {
  return new AlbyNwcReceiveClient(options);
}
