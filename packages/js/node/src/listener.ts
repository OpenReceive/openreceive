import {
  type OpenReceiveReceiveNwcClient,
  type PaymentReceivedNotification
} from "@openreceive/core";

export interface TrustedPaymentNotification {
  readonly notification: PaymentReceivedNotification;
}

export interface PaymentNotificationListenerOptions {
  readonly client: OpenReceiveReceiveNwcClient;
  readonly seenPaymentHashes?: Set<string>;
  readonly onSettledInvoice: (
    event: TrustedPaymentNotification
  ) => Promise<boolean | void> | boolean | void;
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
      // NWC payment_received notifications are trusted settlement events, but
      // delivery is at-least-once. The durable no-double-credit guarantee comes
      // from the host's idempotent payment_hash transition; this in-memory set
      // is only a fast-path duplicate filter for this listener process.
      if (seenPaymentHashes.has(notification.payment_hash)) return;

      try {
        const applied = await options.onSettledInvoice({ notification });
        if (applied !== false) {
          seenPaymentHashes.add(notification.payment_hash);
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
