import { showOrder } from "../../../../../../../shared/server-node/shop-routes.ts";
import { shopContext, shopRequest, shopResponse } from "../../../../server/shop.ts";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ reference: string }> },
): Promise<Response> {
  const { reference } = await context.params;
  return shopResponse(showOrder(shopRequest(request, { reference }), shopContext()));
}
