import {
  type CreateOpenReceiveHttpHandlerOptions,
  type CreateOpenReceiveStackOptions,
  createOpenReceiveHttpHandler,
  createOpenReceiveStack,
  createRequestId,
  errorResponse,
  isOpenReceiveStackOptions,
  mapHostRouteError,
  OpenReceiveHttpError,
  type OpenReceiveHttpHandler,
  openReceiveIsUnderPrefix,
  openReceiveWebRequest,
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
// Mount it at the root; it handles requests under its prefix (default /openreceive) and calls
// next() for everything else, so it composes with the rest of your app. The untouched Express
// req is passed through as `native`, so middleware-attached state like req.session is available
// to your policy:
//
//   app.use(express.json());
//   app.use(openReceiveExpress({
//     service,
//     host,
//     authorize: ({ native }) =>
//       Boolean((native as { session?: { userId?: string } }).session?.userId),
//   }));

// One surface, not a hand-copied subset: everything @openreceive/http exports is
// available from the adapter a host installed, so the guides can name any of it.
export * from "@openreceive/http";

export interface OpenReceiveExpressMiddleware extends RequestHandler {
  /** The normalized mount prefix the middleware handles. */
  readonly prefix: string;
  /** All-in-one form only: resolves when the service and reconciler are up. */
  readonly ready?: Promise<void>;
  /** All-in-one form only: stops the reconciler and closes the owned service. */
  readonly close?: () => Promise<void>;
}

/**
 * Build an Express middleware that serves the OpenReceive routes under its prefix.
 *
 * Two forms:
 * - All-in-one (the happy path): pass the order hooks and a db handle directly —
 *   `openReceiveExpress({ nwc, db, loadOrder, amountForOrder, onPaid, authorize })`.
 *   The middleware builds the service, host, and background reconciler itself
 *   (first request awaits boot) and exposes `ready`/`close`.
 * - Composed: pass a prebuilt `{ service, host, authorize }` when you construct
 *   the pieces yourself (custom repositories, tests, shared services).
 */
export function openReceiveExpress<Order = unknown>(
  options: CreateOpenReceiveHttpHandlerOptions | CreateOpenReceiveStackOptions<Order>,
): OpenReceiveExpressMiddleware {
  if (isOpenReceiveStackOptions(options)) {
    const stack = createOpenReceiveStack(options);
    const middleware = buildMiddleware(stack.handler);
    Object.defineProperties(middleware, {
      ready: { value: stack.ready, enumerable: true },
      close: { value: stack.close, enumerable: true },
    });
    return middleware;
  }
  return buildMiddleware(createOpenReceiveHttpHandler(options));
}

function buildMiddleware(handler: OpenReceiveHttpHandler): OpenReceiveExpressMiddleware {
  const middleware = (async (req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
    const pathname = (req.originalUrl ?? req.url).split("?")[0];
    if (!openReceiveIsUnderPrefix(pathname, handler.prefix)) {
      next();
      return;
    }
    try {
      const response = await handler(toWebRequest(req), { native: req });
      await writeWebResponse(res, response);
    } catch (error) {
      // Bridge-level refusals (a JSON body no parser read) are OpenReceive's
      // own error responses, not the app's to render.
      if (error instanceof OpenReceiveHttpError) {
        await writeWebResponse(res, errorResponse(error, createRequestId()));
        return;
      }
      next(error);
    }
  }) as OpenReceiveExpressMiddleware;
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

function toWebRequest(req: ExpressRequest): Request {
  // req.protocol honors Express's trust-proxy setting, so HTTPS deployments
  // behind a proxy produce correct absolute URLs.
  return openReceiveWebRequest({
    method: req.method,
    headers: req.headers,
    url: req.originalUrl ?? req.url,
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
