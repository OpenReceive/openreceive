import {
  type CreateOpenReceiveHttpHandlerOptions,
  type CreateOpenReceiveStackOptions,
  createOpenReceiveHttpHandler,
  createOpenReceiveStack,
  isOpenReceiveStackOptions,
  type OpenReceiveAuthorizeContext,
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

// One surface, not a hand-copied subset: everything @openreceive/http exports is
// available from the adapter a host installed, so the guides can name any of it.
export * from "@openreceive/http";

export type OpenReceiveNextRouteHandler = (request: Request) => Promise<Response>;

export interface OpenReceiveNextHandlers {
  readonly GET: OpenReceiveNextRouteHandler;
  readonly POST: OpenReceiveNextRouteHandler;
  /** The underlying framework-agnostic handler, if you need it directly. */
  readonly handler: OpenReceiveHttpHandler;
  /** All-in-one form only: resolves when the service and reconciler are up. */
  readonly ready?: Promise<void>;
  /** All-in-one form only: stops the reconciler and closes the owned service. */
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

/** All-in-one form: order hooks + db handle; the adapter builds service/host/reconciler. */
export interface OpenReceiveNextStackOptions
  extends CreateOpenReceiveStackOptions,
    OpenReceiveNextAdapterExtras {}

/**
 * Build Next.js App Router GET/POST handlers for the OpenReceive routes.
 *
 * Two forms: the all-in-one happy path (order hooks + db handle + `nwc`; the
 * adapter builds service, host, and reconciler, exposing `ready`/`close`) or
 * the composed `{ service, host, authorize }` form.
 */
export function openReceiveNextHandlers(
  options: OpenReceiveNextHandlersOptions | OpenReceiveNextStackOptions,
): OpenReceiveNextHandlers {
  if (isOpenReceiveStackOptions(options)) {
    const { trustProxyIpHeader, ...stackOptions } = options;
    const stack = createOpenReceiveStack({
      ...stackOptions,
      ...resolveNextRateLimiting(stackOptions.rateLimiting, trustProxyIpHeader),
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
    ...resolveNextRateLimiting(handlerOptions.rateLimiting, trustProxyIpHeader),
  });
  const route: OpenReceiveNextRouteHandler = (request) => handler(request, { native: request });
  return { GET: route, POST: route, handler };
}

function resolveNextRateLimiting(
  rateLimiting: CreateOpenReceiveHttpHandlerOptions["rateLimiting"],
  trustProxyIpHeader: boolean | string | undefined,
): Pick<CreateOpenReceiveHttpHandlerOptions, "rateLimiting"> {
  if (rateLimiting === undefined || rateLimiting === false) return {};
  const headerName =
    trustProxyIpHeader === true
      ? "x-forwarded-for"
      : typeof trustProxyIpHeader === "string"
        ? trustProxyIpHeader.toLowerCase()
        : undefined;
  const headerIp =
    headerName === undefined
      ? undefined
      : (context: OpenReceiveAuthorizeContext): string | undefined => {
          const value = context.request.headers.get(headerName);
          const first = value?.split(",")[0]?.trim();
          return first !== undefined && first.length > 0 ? first : undefined;
        };
  const config = rateLimiting === true ? {} : rateLimiting;
  if (config.ip === undefined && headerIp === undefined) {
    // Fail loud at construction: without an IP source every request would be
    // unattributable and the security control would silently do nothing.
    throw new TypeError(
      "rateLimiting on the Next adapter needs a client IP source: a web Request has no " +
        "socket IP. Pass trustProxyIpHeader: true to read x-forwarded-for (only behind " +
        "your own reverse proxy), name another trusted header, or supply a custom " +
        "rateLimiting.ip extractor.",
    );
  }
  return { rateLimiting: { ...config, ip: config.ip ?? headerIp } };
}
