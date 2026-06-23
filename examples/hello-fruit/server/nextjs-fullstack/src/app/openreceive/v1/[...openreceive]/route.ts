import {
  dispatchOpenReceiveRoute
} from "../../../../server/openreceive.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type OpenReceiveRouteContext = {
  readonly params: Promise<{
    readonly openreceive?: string[];
  }>;
};

async function handleOpenReceiveRoute(
  request: Request,
  _context: OpenReceiveRouteContext
): Promise<Response> {
  return dispatchOpenReceiveRoute(request);
}

export function GET(
  request: Request,
  context: OpenReceiveRouteContext
): Promise<Response> {
  return handleOpenReceiveRoute(request, context);
}

export function POST(
  request: Request,
  context: OpenReceiveRouteContext
): Promise<Response> {
  return handleOpenReceiveRoute(request, context);
}
