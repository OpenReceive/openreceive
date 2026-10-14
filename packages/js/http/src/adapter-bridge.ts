// Shared request bridging for the Node-framework adapters (Express, Fastify).
// Both frameworks hand the adapter a parsed request whose raw stream is already
// consumed, so the Web Request body is reconstructed from the parsed value.
// Keeping this in one place stops the adapters drifting apart (they already
// had: Fastify hardcoding http:// while Express honored req.protocol).

import { HttpError } from "./errors.ts";
import { claimsPath } from "./router.ts";

const SKIP_REQUEST_HEADERS = new Set(["content-length", "transfer-encoding", "connection"]);

/** The pieces of a framework request the bridge needs, framework-agnostic. */
export interface NodeRequestParts {
  readonly method: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** Request path (may include the query string). */
  readonly url: string;
  /** Scheme reported by the framework (respecting its trust-proxy setting). */
  readonly protocol?: string;
  /** Body already parsed by the framework's body parser, when present. */
  readonly parsedBody?: unknown;
  /**
   * The request's own unread body, for a framework that leaves it on the
   * stream when no parser ran (Express). Called only when `parsedBody` is
   * undefined and the request declares a body; `undefined` when the stream
   * can no longer give the client's body.
   */
  readonly unparsedBody?: () => ReadableStream<Uint8Array> | undefined;
}

/** Convert a parsed framework request into the Web Request the handler speaks. */
export function webRequest(parts: NodeRequestParts): Request {
  const rawHost = parts.headers.host;
  const host = (Array.isArray(rawHost) ? rawHost[0] : rawHost) ?? "localhost";
  const protocol =
    parts.protocol !== undefined && parts.protocol.length > 0 ? parts.protocol : "http";
  const url = `${protocol}://${host}${parts.url.length > 0 ? parts.url : "/"}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(parts.headers)) {
    if (SKIP_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(", "));
  }

  const method = parts.method.toUpperCase();
  let body: string | ReadableStream<Uint8Array> | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const parsed = parts.parsedBody;
    if (parsed === undefined) {
      body = unparsedBody(parts);
    } else if (typeof parsed === "string") {
      body = parsed;
    } else if (parsed !== null && Object.keys(parsed).length > 0) {
      body = JSON.stringify(parsed);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }
  }

  if (typeof body === "object") {
    // Node's Request refuses a stream body without `duplex: "half"`, which
    // the DOM RequestInit type does not declare.
    return new Request(url, { method, headers, body, duplex: "half" } as RequestInit);
  }
  return new Request(url, { method, headers, body });
}

/**
 * Nothing parsed the body: no parser was mounted, or it runs after
 * OpenReceive (NestJS adds its own only at listen). The adapter hands over
 * the unread stream, and the handler reads it under its own size cap after
 * the cross-site and content-type checks. With no stream to read, a JSON
 * body would look empty and every route would blame the client for a
 * missing `reference`, so this names the real misconfiguration instead.
 */
function unparsedBody(parts: NodeRequestParts): ReadableStream<Uint8Array> | undefined {
  const header = (name: string): string | undefined => {
    const value = parts.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const declaresBody =
    Number(header("content-length") ?? "0") > 0 || header("transfer-encoding") !== undefined;
  if (!declaresBody) return undefined;
  const stream = parts.unparsedBody?.();
  if (stream !== undefined) return stream;
  if (!(header("content-type") ?? "").includes("json")) return undefined;
  throw new HttpError(
    500,
    "INTERNAL",
    "OpenReceive received a JSON request body that no body parser had read. Mount your " +
      "framework's JSON body parser (Express: app.use(express.json())) before the OpenReceive " +
      "middleware.",
  );
}

/**
 * True when the adapter should hand this request to the OpenReceive handler
 * instead of the surrounding app. A root mount (`prefix: "/"`) claims only the
 * library's own paths.
 */
export function isUnderPrefix(pathname: string, prefix: string): boolean {
  return claimsPath(prefix, pathname);
}
