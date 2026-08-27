/**
 * The Rails host's realtime transport: ActionCable over solid_cable.
 *
 * THIS FILE IS THE HOST'S, NOT THE SHOP'S. Nothing under
 * `examples/buttons/shared/` imports `@rails/actioncable` or knows a websocket
 * exists — the stores expose `setPushConnected`, `refreshFromPush` and
 * `confirmSettlement`, and this wires a Rails-specific transport to them. A
 * stack with a different push mechanism, or none, plugs in here instead.
 *
 * PUSH IS THE FAST PATH, NOT THE ONLY PATH. The feed keeps a slow safety-net
 * poll and the checkout keeps its own poll loop, so a dropped socket costs
 * latency and never correctness. Both paths land in the same idempotent store
 * methods, which is what makes running them together safe.
 *
 * Two streams, for two different audiences:
 *
 *   ShopFeedChannel   public, no identity, one stream for everybody
 *   ShopOrderChannel  this payer's own order, authorized against the signed
 *                     cookie — a stranger's subscription is rejected
 *
 * Neither envelope carries order data. They say "something changed"; the
 * client re-reads the HTTP route, whose payload whitelist lives in exactly one
 * place on the server.
 */

import { type Consumer, createConsumer, type Subscription } from "@rails/actioncable";
import { reaction } from "mobx";
import type { ShopStore } from "../../../../../shared/client/stores/ShopStore.ts";

type CableEnvelope = { readonly message?: string };

// One consumer per page. `createConsumer()` opens a websocket, and a second
// one would be a second socket carrying the same traffic.
let consumer: Consumer | undefined;
const getConsumer = (): Consumer => {
  consumer ??= createConsumer();
  return consumer;
};

/**
 * Subscribe to the public feed for the life of the panel, and to the payer's
 * own order for the life of that order. Returns a teardown.
 */
export const startShopCable = (shop: ShopStore): (() => void) => {
  const feed = getConsumer().subscriptions.create<CableEnvelope>(
    { channel: "ShopFeedChannel" },
    {
      // `connected` also fires on every RECONNECT, so this is where a socket
      // that dropped and came back catches up on what it missed.
      connected: () => {
        shop.feed.setPushConnected(true);
        shop.feed.refreshFromPush();
      },
      disconnected: () => shop.feed.setPushConnected(false),
      rejected: () => shop.feed.setPushConnected(false),
      received: (payload) => {
        if (payload?.message === "orders-changed") shop.feed.refreshFromPush();
      },
    },
  );

  // One ShopOrderChannel subscription, keyed to the order the payer is looking
  // at. A mobx reaction re-subscribes when the reference changes and tears the
  // old one down on start-over.
  let order: Subscription | undefined;
  let subscribedTo = "";

  const stopWatchingReference = reaction(
    () => shop.orderReference,
    (reference) => {
      if (reference === subscribedTo) return;
      order?.unsubscribe();
      order = undefined;
      subscribedTo = reference;
      if (!reference) return;

      order = getConsumer().subscriptions.create<CableEnvelope>(
        { channel: "ShopOrderChannel", reference },
        {
          received: (payload) => {
            // The browser does not learn from this message that it was
            // fulfilled. It re-reads the row, which is the only thing that can
            // say so — and which only says so because `config.on_paid` wrote it
            // inside OpenReceive's settlement transaction.
            if (payload?.message === "order-paid") void shop.confirmSettlement();
          },
        },
      );
    },
    { fireImmediately: true },
  );

  return () => {
    stopWatchingReference();
    order?.unsubscribe();
    feed.unsubscribe();
    shop.feed.setPushConnected(false);
  };
};
