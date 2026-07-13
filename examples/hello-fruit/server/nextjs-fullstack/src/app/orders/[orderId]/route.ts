import { orderSummaryResponse } from "../../../server/openreceive.ts";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { readonly params: Promise<{ readonly orderId: string }> },
): Promise<Response> {
  const { orderId } = await context.params;
  return await orderSummaryResponse(orderId);
}
