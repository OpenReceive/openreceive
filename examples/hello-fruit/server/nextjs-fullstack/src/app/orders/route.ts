import { createOrderResponse } from "../../server/openreceive.ts";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return createOrderResponse(request);
}
