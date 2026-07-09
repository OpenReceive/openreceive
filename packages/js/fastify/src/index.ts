import {
  type CreateOpenReceiveHttpHandlerOptions,
  createOpenReceiveHttpHandler,
} from "@openreceive/http";

// @openreceive/fastify — a Fastify plugin over @openreceive/http. Fastify is not a build-time
// dependency of this package (hosts bring their own), so the Fastify surface is typed
// structurally with the minimum this adapter touches. All route/auth/token/error logic lives in
// @openreceive/http; this only bridges Fastify's request/reply to Web Request/Response.
//
//   await fastify.register(openReceiveFastify, { service, authorize, getOrderAmount, prefix: "/openreceive" });
//
// Register `prefix` scopes the plugin's catch-all route to that path AND is passed to the handler
// so both agree; request.raw.url carries the full path, so matching is exact.

export type { CreateOpenReceiveHttpHandlerOptions } from "@openreceive/http";

/** Minimal structural view of the Fastify surface this adapter uses. */
interface FastifyRequestLike {
  readonly method: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body?: unknown;
  readonly raw: { url?: string };
}

interface FastifyReplyLike {
  code(statusCode: number): FastifyReplyLike;
  header(key: string, value: string): FastifyReplyLike;
  send(payload: string): unknown;
}

interface FastifyInstanceLike {
  all(
    path: string,
    handler: (request: FastifyRequestLike, reply: FastifyReplyLike) => Promise<unknown>,
  ): unknown;
}

export type OpenReceiveFastifyOptions = CreateOpenReceiveHttpHandlerOptions;

/** Fastify plugin serving the OpenReceive routes. Register it with a `prefix`. */
export function openReceiveFastify(
  fastify: FastifyInstanceLike,
  options: OpenReceiveFastifyOptions,
  done?: (error?: Error) => void,
): void {
  const handler = createOpenReceiveHttpHandler(options);
  fastify.all("/*", async (request, reply) => {
    const response = await handler(toWebRequest(request));
    reply.code(response.status);
    response.headers.forEach((value, key) => {
      reply.header(key, value);
    });
    return reply.send(await response.text());
  });
  done?.();
}

const SKIP_REQUEST_HEADERS = new Set(["content-length", "transfer-encoding", "connection"]);

function toWebRequest(request: FastifyRequestLike): Request {
  const rawHost = request.headers.host;
  const host = (Array.isArray(rawHost) ? rawHost[0] : rawHost) ?? "localhost";
  const url = `http://${host}${request.raw.url ?? "/"}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (SKIP_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(", "));
  }

  const method = request.method.toUpperCase();
  let body: string | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const parsed = request.body;
    if (typeof parsed === "string") {
      body = parsed;
    } else if (parsed !== undefined && parsed !== null && Object.keys(parsed).length > 0) {
      body = JSON.stringify(parsed);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }
  }

  return new Request(url, { method, headers, body });
}
