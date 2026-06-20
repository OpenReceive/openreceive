import {
  dispatchOpenReceiveHandler
} from "../../../../server/openreceive.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request): Promise<Response> {
  return dispatchOpenReceiveHandler("capabilities", request);
}
