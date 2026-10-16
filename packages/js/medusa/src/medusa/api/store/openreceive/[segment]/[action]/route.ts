import {
  type MedusaRequest,
  type MedusaResponse,
  serveCheckoutRoute,
} from "../../../../../../runtime.ts";

// /store/openreceive/checkouts/prepare, /payments/check and the swap routes
// (/swaps/quote, /swaps/status, /swaps/refunds).

export const AUTHENTICATE = false;

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  await serveCheckoutRoute(req, res);
}

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  await serveCheckoutRoute(req, res);
}
