import { bootstrap } from "../../../../../../shared/server-node/shop-routes.ts";
import { shopContext, shopRequest, shopResponse } from "../../../server/shop.ts";

// Names this visitor, so it must never be cached or statically rendered.
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return shopResponse(bootstrap(shopRequest(request), shopContext()));
}
