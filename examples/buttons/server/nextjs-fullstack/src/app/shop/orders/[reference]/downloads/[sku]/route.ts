import { download } from "../../../../../../../../../shared/server-node/shop-routes.ts";
import { shopContext, shopRequest, shopResponse } from "../../../../../../server/shop.ts";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ reference: string; sku: string }> },
): Promise<Response> {
  const { reference, sku } = await context.params;
  return shopResponse(download(shopRequest(request, { reference, sku }), shopContext()));
}
