// Supabase's API gateway, in miniature, for the shop's local Supabase: it
// serves PostgREST under /rest/v1, takes the project's secret key in `apikey`
// alone, and hands PostgREST a service_role token for it, as Supabase does.
// A legacy JWT key passes through with its Authorization header. Lovable runs
// the real one; nothing here is part of the app.
import { createHmac } from "node:crypto";
import http from "node:http";

const rest = process.env.REST_URL ?? "http://rest:3000";
const secretKey = process.env.SECRET_KEY;
const jwtSecret = process.env.JWT_SECRET;
const port = Number(process.env.PORT ?? 8000);

const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
function serviceToken() {
  const head = encode({ alg: "HS256", typ: "JWT" });
  const body = encode({ role: "service_role", iss: "supabase", exp: Math.floor(Date.now() / 1000) + 3600 });
  const signature = createHmac("sha256", jwtSecret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${signature}`;
}

http
  .createServer(async (request, response) => {
    const reply = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.url === "/health") return reply(200, { ok: true });
    if (!request.url.startsWith("/rest/v1/")) return reply(404, { message: "no route" });
    const apikey = request.headers.apikey;
    if (typeof apikey !== "string") return reply(401, { message: "No API key found in request" });
    let authorization = request.headers.authorization;
    if (apikey.startsWith("sb_")) {
      if (apikey !== secretKey) return reply(401, { message: "Invalid API key" });
      if (authorization !== undefined && authorization !== `Bearer ${apikey}`)
        return reply(401, { message: "Authorization is not a JWT; send the key in apikey" });
      authorization = `Bearer ${serviceToken()}`;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    try {
      const forwarded = await fetch(`${rest}${request.url.slice("/rest/v1".length)}`, {
        method: request.method,
        headers: Object.fromEntries(
          Object.entries({
            authorization,
            accept: request.headers.accept,
            "content-type": request.headers["content-type"],
            prefer: request.headers.prefer,
            "accept-profile": request.headers["accept-profile"],
            "content-profile": request.headers["content-profile"],
          }).filter(([, value]) => value !== undefined),
        ),
        ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
      });
      const headers = {};
      for (const name of ["content-type", "content-range"]) {
        const value = forwarded.headers.get(name);
        if (value !== null) headers[name] = value;
      }
      response.writeHead(forwarded.status, headers);
      response.end(Buffer.from(await forwarded.arrayBuffer()));
    } catch (error) {
      reply(502, { message: `PostgREST is not reachable: ${error.message}` });
    }
  })
  .listen(port, "0.0.0.0");
