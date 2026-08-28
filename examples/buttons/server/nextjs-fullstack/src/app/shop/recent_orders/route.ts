import { recentOrders } from "../../../../../../shared/server-node/shop-routes.ts";
import { shopContext, shopRequest, shopResponse } from "../../../server/shop.ts";

// Public and identical for everyone, but it reads the database on every hit —
// the ten-second cache header on the response is what collapses a burst, not a
// build-time render.
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return shopResponse(recentOrders(shopRequest(request), shopContext()));
}
