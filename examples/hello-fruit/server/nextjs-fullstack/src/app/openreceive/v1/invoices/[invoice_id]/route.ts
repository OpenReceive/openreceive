import {
  dispatchOpenReceiveHandler
} from "../../../../../server/openreceive.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { readonly params: Promise<{ readonly invoice_id: string }> }
): Promise<Response> {
  const params = await context.params;
  return dispatchOpenReceiveHandler("getInvoice", request, params);
}
