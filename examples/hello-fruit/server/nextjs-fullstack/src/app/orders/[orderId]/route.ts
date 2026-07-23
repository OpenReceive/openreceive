import { readOrderResponse } from "../../../server/openreceive.ts";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ orderId: string }> },
): Promise<Response> {
  const { orderId } = await context.params;
  return readOrderResponse(orderId);
}
