import {
  type CreateOpenReceiveHttpHandlerOptions,
  createOpenReceiveHttpHandler,
  type OpenReceiveHttpHandler,
} from "@openreceive/http";

// @openreceive/next — App Router route handlers over @openreceive/http. Next App Router route
// handlers already receive a Web-standard Request and return a Web-standard Response, which is
// exactly what @openreceive/http speaks, so this adapter is a direct pass-through.
//
// Mount as a catch-all so every method/subpath under the prefix reaches the handler:
//
//   // app/openreceive/[...openreceive]/route.ts
//   import { openReceiveNextHandlers } from "@openreceive/next";
//   const service = await createOpenReceive();
//   export const { GET, POST } = openReceiveNextHandlers({ service, authorize, getCheckoutAmount });

export type { CreateOpenReceiveHttpHandlerOptions } from "@openreceive/http";

export type OpenReceiveNextRouteHandler = (request: Request) => Promise<Response>;

export interface OpenReceiveNextHandlers {
  readonly GET: OpenReceiveNextRouteHandler;
  readonly POST: OpenReceiveNextRouteHandler;
  /** The underlying framework-agnostic handler, if you need it directly. */
  readonly handler: OpenReceiveHttpHandler;
}

/** Build Next.js App Router GET/POST handlers for the OpenReceive routes. */
export function openReceiveNextHandlers(
  options: CreateOpenReceiveHttpHandlerOptions,
): OpenReceiveNextHandlers {
  const handler = createOpenReceiveHttpHandler(options);
  const route: OpenReceiveNextRouteHandler = (request) => handler(request);
  return { GET: route, POST: route, handler };
}
