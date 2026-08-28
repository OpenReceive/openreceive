/**
 * The bootstrap payload, fetched.
 *
 * The Node hosts serve it as a route and hydrate the store on mount; the Rails
 * host inlines the identical payload into its ERB layout and reads it
 * synchronously. That is the only thing the four stacks genuinely do
 * differently about it, which is why this lives here rather than in three
 * clients.
 */

import { SHOP_BOOTSTRAP_PATH, type ShopBootstrap } from "../shop-types.ts";
import { getJson } from "./http.ts";

export const loadShopBootstrap = async (): Promise<ShopBootstrap | null> => {
  const payload = await getJson<{ shop?: ShopBootstrap }>(SHOP_BOOTSTRAP_PATH);
  return payload.shop ?? null;
};
