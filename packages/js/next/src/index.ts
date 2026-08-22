import {
  type CreateOpenReceiveHttpHandlerOptions,
  type CreateOpenReceiveStackOptions,
  createOpenReceiveHttpHandler,
  createOpenReceiveStack,
  createProxyRateLimitingConfig,
  isOpenReceiveStackOptions,
  mapHostRouteError,
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
//   export const { GET, POST } = openReceiveNextHandlers({
//     service, authorize, host
//   });
//
// The incoming NextRequest is passed through as `native`, so its cookie/session helpers are
// available to your policy:
//
//   authorize: ({ native }) =>
//     Boolean((native as { cookies?: { get(name: string): unknown } }).cookies?.get("session"))

export * from "@openreceive/http/adapter-surface";

export type OpenReceiveNextRouteHandler = (request: Request) => Promise<Response>;

export interface OpenReceiveNextHandlers {
  readonly GET: OpenReceiveNextRouteHandler;
  readonly POST: OpenReceiveNextRouteHandler;
  /** The underlying framework-agnostic handler, if you need it directly. */
  readonly handler: OpenReceiveHttpHandler;
  /** All-in-one form only: resolves when the owned service and handler are up. */
  readonly ready?: Promise<void>;
  /** All-in-one form only: closes the service the adapter created. */
  readonly close?: () => Promise<void>;
}

interface OpenReceiveNextAdapterExtras {
  /**
   * Opt-in client-IP attribution for `rateLimiting`: a web Request has no
   * socket IP, so the Next adapter must read a forwarded header — and that is
   * only safe when YOUR reverse proxy sets it (a direct-to-origin client can
   * forge it). `true` reads the first hop of `x-forwarded-for`; a string names
   * another header (e.g. `"cf-connecting-ip"`).
   */
  readonly trustProxyIpHeader?: boolean | string;
}

export interface OpenReceiveNextHandlersOptions
  extends CreateOpenReceiveHttpHandlerOptions,
    OpenReceiveNextAdapterExtras {}

/** All-in-one form: order hooks + db handle; the adapter builds service and host. */
export interface OpenReceiveNextStackOptions
  extends CreateOpenReceiveStackOptions,
    OpenReceiveNextAdapterExtras {}

/**
 * Build Next.js App Router GET/POST handlers for the OpenReceive routes.
 *
 * Two forms: the all-in-one happy path (order hooks + db handle + `nwc`; the
 * adapter builds the service and host, exposing `ready`/`close` — no
 * background process, settlement is opportunistic through the durable
 * reconcile gate, with `startOpenReceiveNotificationWorker` as the optional
 * push/poll worker) or the composed `{ service, host, authorize }` form.
 */
export function openReceiveNextHandlers(
  options: OpenReceiveNextHandlersOptions | OpenReceiveNextStackOptions,
): OpenReceiveNextHandlers {
  if (isOpenReceiveStackOptions(options)) {
    const { trustProxyIpHeader, ...stackOptions } = options;
    const stack = createOpenReceiveStack({
      ...stackOptions,
      ...createProxyRateLimitingConfig(stackOptions.rateLimiting, trustProxyIpHeader, {
        requireIpSource: "Next",
      }),
    });
    const route: OpenReceiveNextRouteHandler = (request) =>
      stack.handler(request, { native: request });
    return {
      GET: route,
      POST: route,
      handler: stack.handler,
      ready: stack.ready,
      close: stack.close,
    };
  }
  const { trustProxyIpHeader, ...handlerOptions } = options;
  const handler = createOpenReceiveHttpHandler({
    ...handlerOptions,
    ...createProxyRateLimitingConfig(handlerOptions.rateLimiting, trustProxyIpHeader, {
      requireIpSource: "Next",
    }),
  });
  const route: OpenReceiveNextRouteHandler = (request) => handler(request, { native: request });
  return { GET: route, POST: route, handler };
}

/**
 * Map a host/service error onto a JSON Response for an app route handler.
 * Returns the Response to return, or `null` when the caller should rethrow.
 */
export function sendHostRouteError(error: unknown): Response | null {
  const mapped = mapHostRouteError(error);
  if (mapped === null) return null;
  return new Response(JSON.stringify(mapped.body), {
    status: mapped.status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
