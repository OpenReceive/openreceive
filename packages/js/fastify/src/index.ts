import {
  type CreateOpenReceiveHttpHandlerOptions,
  type CreateOpenReceiveStackOptions,
  createOpenReceiveHttpHandler,
  createOpenReceiveStack,
  createProxyRateLimitingConfig,
  createRequestId,
  errorResponse,
  isOpenReceiveStackOptions,
  mapHostRouteError,
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
// Prefixes: the plugin reads the instance's accumulated register prefix (fastify.prefix) and
// matches the handler's own prefix against the path inside it, so registering the plugin
// inside a prefixed scope works. A `prefix` passed at register() scopes the catch-all route
// AND lands in these options; the plugin recognizes it as the mount itself, so the
// OpenReceive routes live directly under it.

export * from "@openreceive/http/adapter-surface";

/** Minimal structural view of the Fastify surface this adapter uses. */
export interface FastifyRequestLike {
  readonly method: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body?: unknown;
  readonly raw: { url?: string };
  /** Scheme, honoring Fastify's trustProxy setting (https behind TLS/proxy). */
  readonly protocol?: string;
}

export interface FastifyReplyLike {
  code(statusCode: number): FastifyReplyLike;
  header(key: string, value: string): FastifyReplyLike;
  send(payload: string): unknown;
  /** Invokes the app's not-found handler for paths this plugin does not own. */
  callNotFound?(): unknown;
}

export interface FastifyInstanceLike {
  all(
    path: string,
    handler: (request: FastifyRequestLike, reply: FastifyReplyLike) => Promise<unknown>,
  ): unknown;
  /** Fastify lifecycle hook; used to close an all-in-one stack with the app. */
  addHook?(name: "onClose", hook: () => Promise<void>): unknown;
  /** Accumulated register prefix for this instance (from register's `{ prefix }`). */
  readonly prefix?: string;
}

interface OpenReceiveFastifyAdapterExtras {
  /**
   * Opt-in client-IP attribution for `rateLimiting` behind a reverse proxy:
   * by default the limiter reads `request.ip`, which is the proxy's address
   * when Fastify's trustProxy is not configured — every payer would then share
   * one budget. Only safe when YOUR reverse proxy sets the header (a
   * direct-to-origin client can forge it). `true` reads the first hop of
   * `x-forwarded-for`; a string names another header (e.g. `"cf-connecting-ip"`).
   */
  readonly trustProxyIpHeader?: boolean | string;
}

export interface OpenReceiveFastifyHandlerOptions
  extends CreateOpenReceiveHttpHandlerOptions,
    OpenReceiveFastifyAdapterExtras {}

/** All-in-one form: order hooks + `wallet` + `storage`; the plugin builds service and host. */
export interface OpenReceiveFastifyStackOptions
  extends CreateOpenReceiveStackOptions,
    OpenReceiveFastifyAdapterExtras {}

/**
 * Two forms: the all-in-one happy path (order hooks + `wallet` + `storage`; the
 * plugin builds the service and host and closes the owned service on app close
 * — no background process, settlement is opportunistic) or the composed
 * `{ service, host, authorize }` form.
 */
export type OpenReceiveFastifyOptions =
  | OpenReceiveFastifyHandlerOptions
  | OpenReceiveFastifyStackOptions;

/** Fastify plugin serving the OpenReceive routes. Register it with a `prefix`. */
export function openReceiveFastify(
  fastify: FastifyInstanceLike,
  options: OpenReceiveFastifyOptions,
  done?: (error?: Error) => void,
): void {
  const instancePrefix = normalizeFastifyPrefix(fastify.prefix);
  const effectivePrefix = resolveHandlerPrefix(instancePrefix, options.prefix);
  let handler: ReturnType<typeof createOpenReceiveHttpHandler>;
  if (isOpenReceiveStackOptions(options)) {
    const { trustProxyIpHeader, ...stackOptions } = options;
    const stack = createOpenReceiveStack({
      ...stackOptions,
      ...effectivePrefix,
      ...createProxyRateLimitingConfig(stackOptions.rateLimiting, trustProxyIpHeader),
    });
    handler = stack.handler;
    fastify.addHook?.("onClose", () => stack.close());
  } else {
    const { trustProxyIpHeader, ...handlerOptions } = options;
    handler = createOpenReceiveHttpHandler({
      ...handlerOptions,
      ...effectivePrefix,
      ...createProxyRateLimitingConfig(handlerOptions.rateLimiting, trustProxyIpHeader),
    });
  }
  fastify.all("/*", async (request, reply) => {
    // The catch-all binds under the instance's register prefix (the application
    // root when there is none); matching happens on the path inside that mount,
    // and paths outside the handler's prefix belong to the rest of the app, so
    // they get the app's own not-found handling instead of an OpenReceive JSON 404.
    const relativeUrl = stripInstancePrefix(request.raw.url ?? "/", instancePrefix);
    const pathname = relativeUrl.split("?")[0] as string;
    if (!openReceiveIsUnderPrefix(pathname, handler.prefix) && reply.callNotFound !== undefined) {
      return reply.callNotFound();
    }
    const response = await respond(handler, request, relativeUrl);
    reply.code(response.status);
    response.headers.forEach((value, key) => {
      reply.header(key, value);
    });
    return reply.send(await response.text());
  });
  done?.();
}

/**
 * Map a host/service error onto a Fastify JSON reply.
 * Returns `true` when handled; `false` when the caller should rethrow.
 */
export function sendHostRouteError(reply: FastifyReplyLike, error: unknown): boolean {
  const mapped = mapHostRouteError(error);
  if (mapped === null) return false;
  reply
    .code(mapped.status)
    .header("content-type", "application/json; charset=utf-8")
    .send(JSON.stringify(mapped.body));
  return true;
}

/**
 * The handler prefix to use inside the instance's mount. A `prefix` that came
 * from register() is the mount itself (Fastify forwards it into the plugin's
 * options and it is a suffix of the accumulated instance prefix), so the
 * handler serves the mount root; any other combination is a misconfiguration
 * reported at registration.
 */
function resolveHandlerPrefix(
  instancePrefix: string,
  optionsPrefix: string | undefined,
): Pick<CreateOpenReceiveHttpHandlerOptions, "prefix"> {
  if (instancePrefix === "") return {};
  const registerPrefix = normalizeFastifyPrefix(optionsPrefix);
  if (registerPrefix === "") return {};
  // registerPrefix starts with "/", so endsWith can only match on a segment
  // boundary ("/v1/api" ends with "/api"; "/myapi" does not).
  if (instancePrefix.endsWith(registerPrefix)) return { prefix: "/" };
  throw new TypeError(
    `openReceiveFastify got prefix "${registerPrefix}" but the instance is registered under ` +
      `"${instancePrefix}". Pass the prefix at register() — ` +
      `fastify.register(openReceiveFastify, { prefix, ... }) — so the route scope and the ` +
      `handler agree.`,
  );
}

function stripInstancePrefix(url: string, instancePrefix: string): string {
  if (instancePrefix === "") return url;
  if (url === instancePrefix) return "/";
  if (url.startsWith(`${instancePrefix}/`)) return url.slice(instancePrefix.length);
  if (url.startsWith(`${instancePrefix}?`)) return `/${url.slice(instancePrefix.length)}`;
  throw new Error(
    `openReceiveFastify is registered under prefix "${instancePrefix}" but received a request ` +
      `for "${url}". Register the plugin on the instance that serves these routes, or pass ` +
      `the prefix at register() so Fastify scopes the routes to it.`,
  );
}

function normalizeFastifyPrefix(prefix: string | undefined): string {
  if (prefix === undefined) return "";
  const trimmed = prefix.trim();
  if (trimmed === "") return "";
  const value = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const withoutTrailing = value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
  return withoutTrailing === "/" ? "" : withoutTrailing;
}

async function respond(
  handler: ReturnType<typeof createOpenReceiveHttpHandler>,
  request: FastifyRequestLike,
  url: string,
): Promise<Response> {
  try {
    return await handler(toWebRequest(request, url), { native: request });
  } catch (error) {
    // Bridge-level refusals (a JSON body no parser read) are OpenReceive's own
    // error responses, not the app's to render.
    if (error instanceof OpenReceiveHttpError) return errorResponse(error, createRequestId());
    throw error;
  }
}

function toWebRequest(request: FastifyRequestLike, url: string): Request {
  return openReceiveWebRequest({
    method: request.method,
    headers: request.headers,
    url,
    protocol: request.protocol,
    parsedBody: request.body,
  });
}
