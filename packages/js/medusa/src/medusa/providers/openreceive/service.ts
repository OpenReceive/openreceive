import { AbstractPaymentProvider } from "@medusajs/framework/utils";
import { formatAmount, sessionIdOf } from "../../../logic.ts";
import { type Logger, PG_CONNECTION, settledPayment, useConnection } from "../../../runtime.ts";

/** medusa-config takes no options: the codes come from NWC_URI and LSC_URI_PRIMARY. */
export type OpenReceiveProviderOptions = Record<string, never>;

type Data = Record<string, unknown>;
interface Input {
  readonly data?: Data;
  readonly context?: { readonly idempotency_key?: unknown };
  readonly amount?: unknown;
  readonly currency_code?: string;
}

/**
 * Bitcoin Lightning, and swaps through a provider, into the merchant's own
 * wallet. The buyer pays on the storefront's checkout before the order is
 * placed. A Lightning payment cannot be authorized and captured later, so a
 * settled payment authorizes as captured, and one that has not settled stays
 * pending: Medusa refuses to complete the cart until it has.
 */
export class OpenReceivePaymentProviderService extends AbstractPaymentProvider<OpenReceiveProviderOptions> {
  static override identifier = "openreceive";

  private readonly logger: Logger | undefined;

  constructor(cradle: Record<string, unknown>, options: OpenReceiveProviderOptions = {}) {
    super(cradle, options);
    // The payment module's container carries Medusa's shared database
    // connection; the routes and the job hand it over too.
    try {
      useConnection(cradle[PG_CONNECTION]);
    } catch {
      // Not registered here: the routes' and the job's container have it.
    }
    try {
      this.logger = cradle.logger as Logger | undefined;
    } catch {
      this.logger = undefined;
    }
  }

  /** The session's own id is the payment's reference; the checkout makes the invoice. */
  async initiatePayment(input: Input): Promise<{ id: string; data: Data; status: "pending" }> {
    const sessionId = sessionIdOf(input.data, input.context);
    if (sessionId === undefined) {
      throw new Error("OpenReceive needs Medusa's payment session id, which Medusa did not pass.");
    }
    return { id: sessionId, data: { session_id: sessionId }, status: "pending" };
  }

  async updatePayment(input: Input): Promise<{ data: Data }> {
    return { data: { ...input.data } };
  }

  async authorizePayment(input: Input): Promise<{ status: "captured" | "pending"; data: Data }> {
    const sessionId = sessionIdOf(input.data, input.context);
    const paid = sessionId === undefined ? undefined : await settledPayment(sessionId);
    if (paid === undefined) return { status: "pending", data: { ...input.data } };
    return {
      status: "captured",
      data: {
        ...input.data,
        session_id: sessionId,
        payment_hash: paid.paymentHash,
        paid_at: paid.paidAt,
      },
    };
  }

  async getPaymentStatus(input: Input): Promise<{ status: "captured" | "pending"; data: Data }> {
    return this.authorizePayment(input);
  }

  /** The payment was captured when it settled; there is nothing left to take. */
  async capturePayment(input: Input): Promise<{ data: Data }> {
    return { data: { ...input.data } };
  }

  /** An unpaid Lightning invoice simply expires. */
  async cancelPayment(input: Input): Promise<{ data: Data }> {
    return { data: { ...input.data } };
  }

  async deletePayment(input: Input): Promise<{ data: Data }> {
    return { data: { ...input.data } };
  }

  async retrievePayment(input: Input): Promise<{ data: Data }> {
    return { data: { ...input.data } };
  }

  /**
   * The wallet code is receive-only, so no refund leaves through OpenReceive.
   * Like Medusa's manual payments, the refund is recorded in Medusa and the
   * merchant sends it from their own wallet.
   */
  async refundPayment(input: Input): Promise<{ data: Data }> {
    const message = `OpenReceive recorded a refund of ${formatAmount(input.amount)} for payment ${String(input.data?.payment_hash ?? input.data?.session_id ?? "unknown")}. The wallet code is receive-only: send it from your own wallet.`;
    if (this.logger === undefined) console.warn(message);
    else this.logger.warn(message);
    return { data: { ...input.data } };
  }

  /** Settlement reaches Medusa through the plugin itself, never a webhook. */
  async getWebhookActionAndData(): Promise<{ action: "not_supported" }> {
    return { action: "not_supported" };
  }
}
