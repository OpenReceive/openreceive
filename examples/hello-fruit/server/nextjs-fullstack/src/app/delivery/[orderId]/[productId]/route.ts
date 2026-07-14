import { deliveryResponse } from "../../../../server/openreceive.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: {
    readonly params: Promise<{ readonly orderId: string; readonly productId: string }>;
  },
): Promise<Response> {
  const { orderId, productId } = await context.params;
  return deliveryResponse(request, orderId, productId);
}
