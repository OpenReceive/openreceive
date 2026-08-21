import { ratesResponse } from "../../server/openreceive.ts";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return await ratesResponse();
}
