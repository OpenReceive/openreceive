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
  context: OpenReceiveRouteContext
): Promise<Response> {
  const params = await context.params;
  return dispatchOpenReceiveRoute(request, params.openreceive ?? []);
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
