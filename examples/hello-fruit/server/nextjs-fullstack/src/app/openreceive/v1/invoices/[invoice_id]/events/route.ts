import {
  invoiceEventsResponse
} from "../../../../../../server/openreceive.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { readonly params: Promise<{ readonly invoice_id: string }> }
): Promise<Response> {
  const { invoice_id } = await context.params;
  return invoiceEventsResponse(request, invoice_id);
}
