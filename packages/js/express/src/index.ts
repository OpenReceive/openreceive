import {
  type CreateOpenReceiveHttpHandlerOptions,
  createOpenReceiveHttpHandler,
  type OpenReceiveHttpHandler,
} from "@openreceive/http";
import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
  NextFunction,
  RequestHandler,
} from "express";

// @openreceive/express — a thin adapter over @openreceive/http. All routing, authorization,
// capability-token, and error-mapping logic lives in @openreceive/http; this only converts
// between Express req/res and the Web-standard Request/Response the handler speaks.
//
// Mount it at the root; it handles requests under its prefix (default /openreceive) and calls
// next() for everything else, so it composes with the rest of your app:
//
//   app.use(express.json());
//   app.use(openReceiveExpress({ service, authorize, getOrderAmount }));

export type { CreateOpenReceiveHttpHandlerOptions } from "@openreceive/http";

export interface OpenReceiveExpressMiddleware extends RequestHandler {
  /** The normalized mount prefix the middleware handles. */
  readonly prefix: string;
}

/** Build an Express middleware that serves the OpenReceive routes under its prefix. */
export function openReceiveExpress(
  options: CreateOpenReceiveHttpHandlerOptions,
): OpenReceiveExpressMiddleware {
  const handler = createOpenReceiveHttpHandler(options);
  const middleware = (async (req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
    const pathname = (req.originalUrl ?? req.url).split("?")[0];
    if (!isUnderPrefix(pathname, handler.prefix)) {
      next();
      return;
    }
    try {
      const response = await handler(toWebRequest(req));
      await writeWebResponse(res, response);
    } catch (error) {
      next(error);
    }
  }) as OpenReceiveExpressMiddleware;
  Object.defineProperty(middleware, "prefix", { value: handler.prefix, enumerable: true });
  return middleware;
}

function isUnderPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

const SKIP_REQUEST_HEADERS = new Set(["content-length", "transfer-encoding", "connection"]);

function toWebRequest(req: ExpressRequest): Request {
  const host = (req.headers.host ?? "localhost").toString();
  const protocol = req.protocol ?? "http";
  const url = `${protocol}://${host}${req.originalUrl ?? req.url}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (SKIP_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(", "));
  }

  const method = req.method.toUpperCase();
  let body: string | undefined;
  if (method !== "GET" && method !== "HEAD") {
    // express.json()/body-parser has already consumed the raw stream, so reconstruct the body
    // from the parsed value. A string body is passed through verbatim.
    const parsed = (req as { body?: unknown }).body;
    if (typeof parsed === "string") {
      body = parsed;
    } else if (parsed !== undefined && parsed !== null && Object.keys(parsed).length > 0) {
      body = JSON.stringify(parsed);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }
  }

  return new Request(url, { method, headers, body });
}

async function writeWebResponse(res: ExpressResponse, response: Response): Promise<void> {
  res.status(response.status);
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  res.send(await response.text());
}

export type { OpenReceiveHttpHandler };
