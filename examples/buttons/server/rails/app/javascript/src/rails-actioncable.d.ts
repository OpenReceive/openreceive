// @rails/actioncable ships no TypeScript types; declare the surface we use.
declare module "@rails/actioncable" {
  export interface Subscription {
    unsubscribe(): void;
  }

  export interface Subscriptions {
    create<Payload = unknown>(
      params: Record<string, unknown>,
      handlers: {
        received?: (payload: Payload) => void;
        connected?: () => void;
        disconnected?: () => void;
        rejected?: () => void;
      },
    ): Subscription;
  }

  export interface Consumer {
    subscriptions: Subscriptions;
  }

  export function createConsumer(url?: string): Consumer;
}
