import {
  sourceRedirectResponse
} from "../../server/openreceive.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(): Response {
  return sourceRedirectResponse();
}
