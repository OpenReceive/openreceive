// Shared request bridging for the Node-framework adapters (Express, Fastify).
// Both frameworks hand the adapter a parsed request whose raw stream is already
// consumed, so the Web Request body is reconstructed from the parsed value.
// Keeping this in one place stops the adapters drifting apart (they already
// had: Fastify hardcoding http:// while Express honored req.protocol).

import { OpenReceiveHttpError } from "./errors.ts";
import { openReceiveClaimsPath } from "./router.ts";

const SKIP_REQUEST_HEADERS = new Set(["content-length", "transfer-encoding", "connection"]);

/** The pieces of a framework request the bridge needs, framework-agnostic. */
export interface OpenReceiveNodeRequestParts {
  readonly method: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** Request path (may include the query string). */
  readonly url: string;
  /** Scheme reported by the framework (respecting its trust-proxy setting). */
  readonly protocol?: string;
  /** Body already parsed by the framework's body parser, when present. */
  readonly parsedBody?: unknown;
}

/** Convert a parsed framework request into the Web Request the handler speaks. */
export function openReceiveWebRequest(parts: OpenReceiveNodeRequestParts): Request {
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
  let body: string | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const parsed = parts.parsedBody;
    assertBodyWasParsed(parts, parsed);
    if (typeof parsed === "string") {
      body = parsed;
    } else if (parsed !== undefined && parsed !== null && Object.keys(parsed).length > 0) {
      body = JSON.stringify(parsed);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }
  }

  return new Request(url, { method, headers, body });
}

/**
 * A JSON body arrived but nothing parsed it, so the raw stream is still
 * unread and the reconstructed request would look empty — every route would
 * then blame the client for a missing `order_id`. Express leaves `req.body`
 * undefined only when no body parser ran at all (body-parser sets `{}` even
 * when it declines the content-type), so this names the real misconfiguration.
 */
function assertBodyWasParsed(parts: OpenReceiveNodeRequestParts, parsed: unknown): void {
  if (parsed !== undefined) return;
  const header = (name: string): string | undefined => {
    const value = parts.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const declaresBody =
    Number(header("content-length") ?? "0") > 0 || header("transfer-encoding") !== undefined;
  if (!declaresBody || !(header("content-type") ?? "").includes("json")) return;
  throw new OpenReceiveHttpError(
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
export function openReceiveIsUnderPrefix(pathname: string, prefix: string): boolean {
  return openReceiveClaimsPath(prefix, pathname);
}
