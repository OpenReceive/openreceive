import {
  type CreateHttpHandlerOptions,
  type CreateStackOptions,
  createHttpHandler,
  createStack,
  createProxyRateLimitingConfig,
  createRequestId,
  errorResponse,
  isStackOptions,
  mapHostRouteError,
  HttpError,
  type HttpHandler,
  isUnderPrefix,
  webRequest,
} from "@openreceive/http";
import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
  NextFunction,
  RequestHandler,
} from "express";

// @openreceive/express — a thin adapter over @openreceive/http. All routing, authorization,
// host integration and error-mapping logic lives in @openreceive/http; this only converts
// between Express req/res and the Web-standard Request/Response the handler speaks.
//
// Mount it at the root or under a sub-path (app.use("/api", ...)): the middleware matches
// its prefix (default /openreceive) against the path inside the mount — req.baseUrl is
// stripped — and calls next() for everything else, so it composes with the rest of your
// app. The untouched Express req is passed through as `native`, so middleware-attached
// state like req.session is available to your policy:
//
//   app.use(express.json());
//   app.use(openReceiveExpress({
//     service,
//     host,
//     authorize: ({ native }) =>
//       Boolean((native as { session?: { userId?: string } }).session?.userId),
//   }));

export * from "@openreceive/http/adapter-surface";

export interface ExpressMiddleware extends RequestHandler {
  /** The normalized mount prefix the middleware handles. */
  readonly prefix: string;
  /** All-in-one form only: resolves when the owned service and handler are up. */
  readonly ready?: Promise<void>;
  /** All-in-one form only: closes the service the middleware created. */
  readonly close?: () => Promise<void>;
}

interface ExpressAdapterExtras {
  /**
   * Opt-in client-IP attribution for `rateLimiting` behind a reverse proxy:
   * by default the limiter reads `req.ip`, which is the proxy's address when
   * Express's trust-proxy is not configured — every payer would then share one
   * budget. Only safe when YOUR reverse proxy sets the header (a
   * direct-to-origin client can forge it). `true` reads the first hop of
   * `x-forwarded-for`; a string names another header (e.g. `"cf-connecting-ip"`).
   */
  readonly trustProxyIpHeader?: boolean | string;
}

export interface ExpressOptions extends CreateHttpHandlerOptions, ExpressAdapterExtras {}

/** All-in-one form: host hooks + `wallet` + `storage`; the middleware builds service and host. */
export interface ExpressStackOptions extends CreateStackOptions, ExpressAdapterExtras {}

/**
 * Build an Express middleware that serves the OpenReceive routes under its prefix.
 *
 * Two forms:
 * - All-in-one (the happy path): pass the host hooks and a db handle directly —
 *   `openReceiveExpress({ wallet: { nwc }, storage: { db, onPaid }, amountFor, authorize })`.
 *   The middleware builds the service and host itself (first request awaits
 *   boot) and exposes `ready`/`close`. It starts no background process:
 *   settlement of abandoned checkouts happens opportunistically through the
 *   durable reconcile gate, and hosts that want push notifications or a poll
 *   loop run the optional `startNotificationWorker` separately.
 * - Composed: pass a prebuilt `{ service, host, authorize }` when you construct
 *   the pieces yourself (custom repositories, tests, shared services).
 */
export function openReceiveExpress(
  options: ExpressOptions | ExpressStackOptions,
): ExpressMiddleware {
  if (isStackOptions(options)) {
    const { trustProxyIpHeader, ...stackOptions } = options;
    const stack = createStack({
      ...stackOptions,
      ...createProxyRateLimitingConfig(stackOptions.rateLimiting, trustProxyIpHeader),
    });
    const middleware = buildMiddleware(stack.handler);
    Object.defineProperties(middleware, {
      ready: { value: stack.ready, enumerable: true },
      close: { value: stack.close, enumerable: true },
    });
    return middleware;
  }
  const { trustProxyIpHeader, ...handlerOptions } = options;
  return buildMiddleware(
    createHttpHandler({
      ...handlerOptions,
      ...createProxyRateLimitingConfig(handlerOptions.rateLimiting, trustProxyIpHeader),
    }),
  );
}

function buildMiddleware(handler: HttpHandler): ExpressMiddleware {
  const middleware = (async (req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
    const pathname = mountRelativeUrl(req).split("?")[0] as string;
    if (!isUnderPrefix(pathname, handler.prefix)) {
      next();
      return;
    }
    try {
      const response = await handler(toWebRequest(req), { native: req });
      await writeWebResponse(res, response);
    } catch (error) {
      // Bridge-level refusals (a JSON body no parser read) are OpenReceive's
      // own error responses, not the app's to render.
      if (error instanceof HttpError) {
        await writeWebResponse(res, errorResponse(error, createRequestId()));
        return;
      }
      next(error);
    }
  }) as ExpressMiddleware;
  Object.defineProperty(middleware, "prefix", { value: handler.prefix, enumerable: true });
  return middleware;
}

/**
 * Map a host/service error onto an Express JSON response.
 * Returns `true` when handled; `false` when the caller should `next(error)`.
 */
export function sendHostRouteError(res: ExpressResponse, error: unknown): boolean {
  const mapped = mapHostRouteError(error);
  if (mapped === null) return false;
  res.status(mapped.status).json(mapped.body);
  return true;
}

/**
 * Path (plus query) inside the Express mount: `app.use("/api", ...)` puts the
 * mount path in `req.baseUrl`, so prefix matching and handler routing work on
 * the remainder — a root mount (`baseUrl` empty) passes through unchanged.
 */
function mountRelativeUrl(req: ExpressRequest): string {
  const url = req.originalUrl ?? req.url;
  const base = req.baseUrl ?? "";
  if (base.length === 0 || base === "/" || !url.startsWith(base)) return url;
  const rest = url.slice(base.length);
  if (rest.length === 0 || rest.startsWith("?")) return `/${rest}`;
  return rest.startsWith("/") ? rest : url;
}

function toWebRequest(req: ExpressRequest): Request {
  // req.protocol honors Express's trust-proxy setting, so HTTPS deployments
  // behind a proxy produce correct absolute URLs.
  return webRequest({
    method: req.method,
    headers: req.headers,
    url: mountRelativeUrl(req),
    protocol: req.protocol,
    parsedBody: (req as { body?: unknown }).body,
  });
}

async function writeWebResponse(res: ExpressResponse, response: Response): Promise<void> {
  res.status(response.status);
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  res.send(await response.text());
}
