import { Button, Text } from "@mantine/core";
import { observer } from "mobx-react";
import type React from "react";
import { useEffect } from "react";
import { formatUsdCents, pluralize, relativeTime, summarizeItems } from "../../shop-types.ts";
import type { ShopStore } from "../stores/ShopStore.ts";

const THUMB_LIMIT = 3;
const SKELETON_ROWS = 3;
const HANDLE_LENGTH = 8;

/**
 * Every paid order on the site, to every visitor.
 *
 * The response is public, identical for everyone and cached for ten seconds —
 * there is no `you: true` field in it. The "You" badge is drawn here, by
 * comparing each row's `buyer` against this visitor's own public uuid from the
 * bootstrap payload.
 */
export const RecentOrdersStage: React.FC<{ shop: ShopStore }> = observer(({ shop }) => {
  const feed = shop.feed;

  // The store owns the interval (started by setTab); the component owns only
  // the unmount. A store that starts a timer and never stops it leaks past
  // every navigation, because the root store never unmounts.
  useEffect(() => () => feed.stop(), [feed]);

  return (
    <>
      <div className="or-shop-stage">
        {feed.isFirstLoad ? (
          <div className="or-shop-feed">
            {Array.from({ length: SKELETON_ROWS }, (_, index) => (
              <div className="or-shop-feed-skeleton" key={`skeleton-${index}`} />
            ))}
          </div>
        ) : feed.isEmpty ? (
          <div className="or-shop-feed-empty">
            <Text fw={600}>No buttons sold yet.</Text>
            <Text size="sm">Every paid order shows up here.</Text>
          </div>
        ) : (
          <div className="or-shop-feed">
            {feed.orders.map((order, index) => {
              const mine = Boolean(shop.visitorRef) && order.buyer === shop.visitorRef;
              return (
                <div
                  className="or-shop-feed-row"
                  // The payload carries no order id on purpose — it IS the
                  // OpenReceive reference — so rows key on their position.
                  key={`${order.paid_at}-${index}`}
                  data-you={mine || undefined}
                >
                  <div className="or-shop-feed-thumbs">
                    {order.items
                      .slice(0, THUMB_LIMIT)
                      .map((item) =>
                        item.image_url ? (
                          <img key={item.sku} src={item.image_url} alt="" loading="lazy" />
                        ) : null,
                      )}
                  </div>
                  <div className="or-shop-feed-main">
                    <div className="or-shop-feed-title">{summarizeItems(order.items)}</div>
                    <div className="or-shop-feed-meta">
                      {/* Truncated for DISPLAY only — 36 characters do not fit a
                          three-column row at 360px — with the full value in
                          `title`. */}
                      <span className="or-shop-feed-buyer" title={order.buyer ?? ""}>
                        {order.buyer ? `${order.buyer.slice(0, HANDLE_LENGTH)}…` : "anonymous"}
                      </span>
                      <span>·</span>
                      <span>{relativeTime(order.paid_at)}</span>
                      {mine ? <span className="or-shop-feed-you">You</span> : null}
                    </div>
                  </div>
                  <div className="or-shop-feed-amount">{formatUsdCents(order.total_cents)}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="or-shop-footer">
        <Text className="or-shop-feed-totals">
          {pluralize(feed.totals.paid_orders, "order")} ·{" "}
          {pluralize(feed.totals.buttons_sold, "button")} sold
        </Text>
        <Button variant="subtle" size="sm" loading={feed.loading} onClick={feed.refresh}>
          Refresh
        </Button>
      </div>
    </>
  );
});
