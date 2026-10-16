// Supabase's API gateway, in miniature, for the shop's local Supabase. Bolt
// runs the real one; nothing here is part of the app.
//
// - /rest/v1 → PostgREST and /auth/v1 → Supabase Auth. Both want the
//   project's key in `apikey`; with no Authorization header, the key is the
//   bearer. Both answer any origin's CORS, as Supabase does for a browser
//   client.
// - /functions/v1/<name> → edge-runtime, with verify_jwt on, as Supabase
//   deploys a function by default: every request but a CORS preflight needs a
//   valid JWT in Authorization (the anon key, or a user's access token). The
//   function answers its own CORS; the gateway adds none.
import { createHmac, timingSafeEqual } from "node:crypto";
import http from "node:http";

const upstreams = {
  rest: new URL(process.env.REST_URL ?? "http://rest:3000"),
  auth: new URL(process.env.AUTH_URL ?? "http://auth:9999"),
  functions: new URL(process.env.FUNCTIONS_URL ?? "http://functions:9000"),
};
const jwtSecret = process.env.JWT_SECRET ?? "";
const port = Number(process.env.PORT ?? 8000);

/** True for an HS256 token this project signed that has not expired. */
function validJwt(token) {
  const [head, body, signature] = token.split(".");
  if (!head || !body || !signature) return false;
  const expected = createHmac("sha256", jwtSecret).update(`${head}.${body}`).digest();
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return typeof claims.exp !== "number" || claims.exp * 1000 > Date.now();
  } catch {
    return false;
  }
}

const bearer = (request) => {
  const value = request.headers.authorization;
  return typeof value === "string" && value.startsWith("Bearer ") ? value.slice(7) : undefined;
};

function reply(response, status, body, headers = {}) {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

const corsFor = (request) => ({
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers":
    request.headers["access-control-request-headers"] ??
    "authorization, x-client-info, apikey, content-type, prefer, range",
  "access-control-expose-headers": "content-range, content-profile, x-supabase-api-version",
  "access-control-max-age": "3600",
});

/** Hand the request to `upstream` under `pathname`, headers as they came, bar the hop's own. */
function forward(request, response, upstream, pathname, extraHeaders = {}, cors = undefined) {
  const headers = { ...request.headers, ...extraHeaders, host: upstream.host };
  delete headers.connection;
  const proxied = http.request(
    {
      hostname: upstream.hostname,
      port: upstream.port,
      method: request.method,
      path: pathname,
      headers,
    },
    (answer) => {
      const out = { ...answer.headers };
      if (cors !== undefined) Object.assign(out, cors);
      response.writeHead(answer.statusCode ?? 502, out);
      answer.pipe(response);
    },
  );
  proxied.on("error", (error) =>
    reply(response, 502, { message: `${upstream.host} is not reachable: ${error.message}` }),
  );
  request.pipe(proxied);
}

http
  .createServer((request, response) => {
    const url = request.url ?? "/";
    if (url === "/health") return reply(response, 200, { ok: true });

    for (const [prefix, upstream] of [
      ["/rest/v1", upstreams.rest],
      ["/auth/v1", upstreams.auth],
    ]) {
      if (url !== prefix && !url.startsWith(`${prefix}/`) && !url.startsWith(`${prefix}?`))
        continue;
      const cors = corsFor(request);
      if (request.method === "OPTIONS") {
        response.writeHead(200, cors);
        return response.end();
      }
      const apikey = request.headers.apikey;
      if (typeof apikey !== "string")
        return reply(response, 401, { message: "No API key found in request" }, cors);
      if (!validJwt(apikey)) return reply(response, 401, { message: "Invalid API key" }, cors);
      const extra = request.headers.authorization === undefined ? { authorization: `Bearer ${apikey}` } : {};
      return forward(request, response, upstream, url.slice(prefix.length) || "/", extra, cors);
    }

    if (url.startsWith("/functions/v1/")) {
      const pathname = url.slice("/functions/v1".length);
      if (request.method !== "OPTIONS") {
        const token = bearer(request);
        if (token === undefined)
          return reply(response, 401, { code: 401, message: "Missing authorization header" });
        if (!validJwt(token)) return reply(response, 401, { code: 401, message: "Invalid JWT" });
      }
      return forward(request, response, upstreams.functions, pathname);
    }

    return reply(response, 404, { message: "no route" });
  })
  .listen(port, "0.0.0.0");
