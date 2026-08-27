import { computed } from "mobx";
import { type Frozen, frozen, Model, model, modelAction, prop } from "mobx-keystone";
import {
  SHOP_FEED_PATH,
  type ShopFeed,
  type ShopFeedOrder,
  type ShopFeedTotals,
} from "../../shop-types.ts";
import { getJson } from "../http.ts";

/** No push transport: the feed is only as fresh as this. */
const REFRESH_MS = 30_000;

/**
 * With a push transport connected, polling stops being the way news arrives
 * and becomes the backstop for news that did not. Slow, not off: a websocket
 * that dropped without saying so must not leave the tab permanently stale.
 */
const SAFETY_NET_MS = 120_000;

const EMPTY_TOTALS: ShopFeedTotals = { paid_orders: 0, buttons_sold: 0 };

/**
 * The public order feed: every paid order on the site, to every visitor.
 *
 * The rows are frozen — a server transcript, replaced wholesale on every load
 * and never edited in place.
 *
 * This store OWNS A POLLING INTERVAL, so it owns a `stop()`. A store that
 * starts something and cannot stop it is a leak that survives every
 * navigation, because the root store never unmounts.
 */
@model("or/RecentOrders")
export class RecentOrders extends Model({
  feed: prop<Frozen<ShopFeed> | null>(null),
  loading: prop<boolean>(false),
  loadedAt: prop<number>(0),
  errorMessage: prop<string>(""),
}) {
  // A timer is not snapshot data. Making this a prop would have mobx-keystone
  // deep-convert an interval handle.
  private timer?: number;

  // Neither of these is a prop either: nothing renders them. `watching` is
  // "somebody has this tab open", which is what makes a push worth acting on.
  private watching = false;
  private pushConnected = false;

  @computed
  get orders(): readonly ShopFeedOrder[] {
    return this.feed?.data.orders ?? [];
  }

  @computed
  get totals(): ShopFeedTotals {
    return this.feed?.data.totals ?? EMPTY_TOTALS;
  }

  /** Loaded at least once AND genuinely empty — not "has not loaded yet". */
  @computed
  get isEmpty(): boolean {
    return this.loadedAt > 0 && this.orders.length === 0;
  }

  @computed
  get isFirstLoad(): boolean {
    return this.loadedAt === 0;
  }

  /**
   * The polling read. May be served from the response's ten-second public
   * cache, which is exactly what that cache is for.
   */
  load = (): Promise<void> => this.fetchFeed(false);

  /**
   * A read by somebody who KNOWS the feed changed: a settlement push, a
   * reconnect, or a person pressing Refresh. It revalidates, so a push that
   * lands inside the ten-second cache window is not answered with the stale
   * copy that predates it.
   */
  refresh = (): Promise<void> => this.fetchFeed(true);

  // A plain async arrow, never @modelAction: an `await` ends the action, so
  // every write is a call to one.
  private fetchFeed = async (fresh: boolean): Promise<void> => {
    if (this.loading) return;
    this.setLoading(true);
    try {
      this.applyFeed(await getJson<ShopFeed>(SHOP_FEED_PATH, { fresh }));
    } catch (error) {
      this.setError(error instanceof Error ? error.message : String(error));
    } finally {
      this.setLoading(false);
    }
  };

  /**
   * Once immediately, then on an interval. `stop()` first, so calling `start()`
   * twice cannot leave two intervals running.
   *
   * The immediate read REVALIDATES and the interval reads do not. Somebody
   * opening the tab is in the same category as somebody pressing Refresh —
   * they have just asked to see this — and it is the one moment staleness is
   * most visible, because the common way to arrive here is straight off your
   * own receipt, well inside the response's ten-second cache.
   */
  start = () => {
    this.stop();
    this.watching = true;
    void this.refresh();
    this.timer = window.setInterval(() => void this.load(), this.intervalMs);
  };

  stop = () => {
    this.watching = false;
    window.clearInterval(this.timer);
    this.timer = undefined;
  };

  private get intervalMs(): number {
    return this.pushConnected ? SAFETY_NET_MS : REFRESH_MS;
  }

  /**
   * The host's realtime transport came up or went away.
   *
   * Re-arming through `start()` is deliberate on BOTH edges: coming up it
   * costs one redundant load, and going down it catches up on everything
   * missed while the socket was dead — which is the moment the fast interval
   * matters most.
   *
   * The store does not know or care what the transport is. The Rails host uses
   * ActionCable over solid_cable; another stack could use anything, or nothing.
   */
  setPushConnected = (connected: boolean) => {
    if (connected === this.pushConnected) return;
    this.pushConnected = connected;
    if (this.watching) this.start();
  };

  /**
   * A push said the feed changed. Reload only if somebody is looking — a
   * background tab does not need to re-query on every stranger's purchase.
   *
   * This deliberately re-reads GET /shop/recent_orders rather than trusting a
   * payload off the socket. The feed's whitelist lives in exactly one place on
   * the server, and the response is already cached for ten seconds, so a burst
   * of settlements collapses into one query.
   */
  refreshFromPush = () => {
    if (this.watching) void this.refresh();
  };

  @modelAction
  private applyFeed(feed: ShopFeed) {
    this.feed = frozen(feed);
    this.loadedAt = Date.now();
    this.errorMessage = "";
  }

  @modelAction
  private setLoading(value: boolean) {
    this.loading = value;
  }

  @modelAction
  private setError(message: string) {
    this.errorMessage = message;
  }
}
