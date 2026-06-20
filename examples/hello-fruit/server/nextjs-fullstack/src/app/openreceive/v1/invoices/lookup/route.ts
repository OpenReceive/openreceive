import {
  dispatchOpenReceiveHandler
} from "../../../../../server/openreceive.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request): Promise<Response> {
  return dispatchOpenReceiveHandler("lookupInvoice", request);
}
