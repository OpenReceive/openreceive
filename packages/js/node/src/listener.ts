import {
  type LookupInvoiceResult,
  type OpenReceiveReceiveNwcClient,
  type PaymentReceivedNotification,
  isLookupSettled
} from "@openreceive/core";

export interface VerifiedPaymentNotification {
  readonly notification: PaymentReceivedNotification;
  readonly lookup: LookupInvoiceResult;
}

export interface PaymentNotificationListenerOptions {
  readonly client: OpenReceiveReceiveNwcClient;
  readonly seenPaymentHashes?: Set<string>;
  readonly onSettledInvoice: (
    event: VerifiedPaymentNotification
  ) => Promise<void> | void;
  readonly onUnsettledNotification?: (
    event: VerifiedPaymentNotification
  ) => Promise<void> | void;
  readonly onError?: (
    error: unknown,
    notification?: PaymentReceivedNotification
  ) => Promise<void> | void;
}

export interface PaymentNotificationListener {
  readonly seenPaymentHashes: ReadonlySet<string>;
  stop(): Promise<void>;
}

export async function startPaymentNotificationListener(
  options: PaymentNotificationListenerOptions
): Promise<PaymentNotificationListener> {
  if (options.client.subscribeToPaymentReceived === undefined) {
    throw new Error("client does not support payment_received notifications");
  }

  const seenPaymentHashes = options.seenPaymentHashes ?? new Set<string>();
  const unsubscribe = await options.client.subscribeToPaymentReceived(
    async (notification) => {
      // NWC notification delivery is at-least-once, not exactly-once. Only a
      // settled-and-credited payment_hash is marked seen; a redelivery that
      // arrives after a transient lookup error or an as-yet-unsettled result
      // must be allowed to re-trigger verification. The durable no-double-credit
      // guarantee comes from the host's idempotent pending -> settled
      // transition, not from this in-memory fast-path dedup.
      if (seenPaymentHashes.has(notification.payment_hash)) return;

      try {
        const lookup = await options.client.lookupInvoice({
          payment_hash: notification.payment_hash
        });
        const event = {
          notification,
          lookup
        };

        if (isLookupSettled(lookup)) {
          await options.onSettledInvoice(event);
          seenPaymentHashes.add(notification.payment_hash);
        } else {
          await options.onUnsettledNotification?.(event);
        }
      } catch (error) {
        await options.onError?.(error, notification);
      }
    }
  );

  return {
    seenPaymentHashes,
    async stop() {
      await unsubscribe();
    }
  };
}
