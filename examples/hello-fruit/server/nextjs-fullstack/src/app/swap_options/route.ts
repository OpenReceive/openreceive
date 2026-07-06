import {
  swapOptionsResponse
} from "../../server/openreceive.ts";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return await swapOptionsResponse(request);
}
