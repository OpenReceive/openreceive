import {
  type CreateOpenReceiveHttpHandlerOptions,
  type CreateOpenReceiveStackOptions,
  createOpenReceiveHttpHandler,
  createOpenReceiveStack,
  createRequestId,
  errorResponse,
  isOpenReceiveStackOptions,
  OpenReceiveHttpError,
  openReceiveIsUnderPrefix,
  openReceiveWebRequest,
} from "@openreceive/http";

// @openreceive/fastify — a Fastify plugin over @openreceive/http. Fastify is not a build-time
// dependency of this package (hosts bring their own), so the Fastify surface is typed
// structurally with the minimum this adapter touches. All route/host/error logic lives in
// @openreceive/http; this only bridges Fastify's request/reply to Web Request/Response.
//
//   await fastify.register(openReceiveFastify, {
//     service, authorize, host, prefix: "/openreceive"
//   });
//
// The untouched Fastify request is passed through as `native`, so decorated state such as
// request.session (from @fastify/session and friends) is available to your policy:
//
//   authorize: ({ native }) =>
//     Boolean((native as { session?: { userId?: string } }).session?.userId)
//
// Register `prefix` scopes the plugin's catch-all route to that path AND is passed to the handler
// so both agree; request.raw.url carries the full path, so matching is exact.

// One surface, not a hand-copied subset: everything @openreceive/http exports is
// available from the adapter a host installed, so the guides can name any of it.
export * from "@openreceive/http";

/** Minimal structural view of the Fastify surface this adapter uses. */
interface FastifyRequestLike {
  readonly method: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body?: unknown;
  readonly raw: { url?: string };
  /** Scheme, honoring Fastify's trustProxy setting (https behind TLS/proxy). */
  readonly protocol?: string;
}

interface FastifyReplyLike {
  code(statusCode: number): FastifyReplyLike;
  header(key: string, value: string): FastifyReplyLike;
  send(payload: string): unknown;
  /** Invokes the app's not-found handler for paths this plugin does not own. */
  callNotFound?(): unknown;
}

interface FastifyInstanceLike {
  all(
    path: string,
    handler: (request: FastifyRequestLike, reply: FastifyReplyLike) => Promise<unknown>,
  ): unknown;
  /** Fastify lifecycle hook; used to close an all-in-one stack with the app. */
  addHook?(name: "onClose", hook: () => Promise<void>): unknown;
}

/**
 * Two forms: the all-in-one happy path (order hooks + db handle + `nwc`; the
 * plugin builds service, host, and reconciler, and stops them on app close) or
 * the composed `{ service, host, authorize }` form.
 */
export type OpenReceiveFastifyOptions =
  | CreateOpenReceiveHttpHandlerOptions
  | CreateOpenReceiveStackOptions;

/** Fastify plugin serving the OpenReceive routes. Register it with a `prefix`. */
export function openReceiveFastify(
  fastify: FastifyInstanceLike,
  options: OpenReceiveFastifyOptions,
  done?: (error?: Error) => void,
): void {
  let handler: ReturnType<typeof createOpenReceiveHttpHandler>;
  if (isOpenReceiveStackOptions(options)) {
    const stack = createOpenReceiveStack(options);
    handler = stack.handler;
    fastify.addHook?.("onClose", () => stack.close());
  } else {
    handler = createOpenReceiveHttpHandler(options);
  }
  fastify.all("/*", async (request, reply) => {
    // Registered without { prefix }, "/*" binds at the application root; paths
    // outside the handler's prefix belong to the rest of the app, so they get
    // the app's own not-found handling instead of an OpenReceive JSON 404.
    const pathname = (request.raw.url ?? "/").split("?")[0];
    if (!openReceiveIsUnderPrefix(pathname, handler.prefix) && reply.callNotFound !== undefined) {
      return reply.callNotFound();
    }
    const response = await respond(handler, request);
    reply.code(response.status);
    response.headers.forEach((value, key) => {
      reply.header(key, value);
    });
    return reply.send(await response.text());
  });
  done?.();
}

async function respond(
  handler: ReturnType<typeof createOpenReceiveHttpHandler>,
  request: FastifyRequestLike,
): Promise<Response> {
  try {
    return await handler(toWebRequest(request), { native: request });
  } catch (error) {
    // Bridge-level refusals (a JSON body no parser read) are OpenReceive's own
    // error responses, not the app's to render.
    if (error instanceof OpenReceiveHttpError) return errorResponse(error, createRequestId());
    throw error;
  }
}

function toWebRequest(request: FastifyRequestLike): Request {
  return openReceiveWebRequest({
    method: request.method,
    headers: request.headers,
    url: request.raw.url ?? "/",
    protocol: request.protocol,
    parsedBody: request.body,
  });
}
