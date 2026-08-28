import { createOrder } from "../../../../../../shared/server-node/shop-routes.ts";
import { shopContext, shopRequest, shopResponse } from "../../../server/shop.ts";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  // A body that is not JSON is an empty cart, which is already a 422 with a
  // sentence the payer can act on.
  const body = await request.json().catch(() => undefined);
  return shopResponse(createOrder(shopRequest(request, {}, body), shopContext()));
}
