import {
  type MedusaRequest,
  type MedusaResponse,
  serveCheckoutRoute,
} from "../../../../../runtime.ts";

// /store/openreceive/checkouts, /swaps and /rates. Medusa has no catch-all
// route, so the one- and two-segment paths each have a route file, and both
// hand the request to the same OpenReceive handler. A store route already
// requires the publishable API key and gets Medusa's store CORS.

export const AUTHENTICATE = false;

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  await serveCheckoutRoute(req, res);
}

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  await serveCheckoutRoute(req, res);
}
