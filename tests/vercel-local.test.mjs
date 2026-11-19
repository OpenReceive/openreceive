import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createVercelLocal } from "./vercel-functions/vercel-local.mjs";

// tests/vercel-functions/vercel-local.mjs stands in for Vercel in the
// Vercel Functions CI lane and in that platform's trial shop. Each case below
// is what a real deployment did when we measured one (2026-11-19, Fluid
// compute, Node 24, framework "Other"), so the stand-in cannot drift from it.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
let scratch;
let server;
let base;

const echo = (label) => `const describe = async (request) => ({
  label: ${JSON.stringify(label)},
  url: request.url,
  pathname: new URL(request.url).pathname,
  search: new URL(request.url).search,
  forwardedFor: request.headers.get("x-forwarded-for"),
  realIp: request.headers.get("x-real-ip"),
  body: request.method === "POST" ? await request.text() : undefined,
});
export async function GET(request) { return Response.json(await describe(request)); }
export async function POST(request) { return Response.json(await describe(request)); }
`;

before(async () => {
  scratch = mkdtempSync(path.join(tmpdir(), "openreceive-vercel-local-"));
  const file = (relative, text) => {
    mkdirSync(path.dirname(path.join(scratch, relative)), { recursive: true });
    writeFileSync(path.join(scratch, relative), text);
  };
  file("package.json", '{ "type": "module" }\n');
  file(
    "vercel.json",
    `${JSON.stringify({
      rewrites: [
        { source: "/rw/:path*", destination: "/api/rw" },
        { source: "/rwf/:path*", destination: "/api/rwfetch" },
        { source: "/legacy/:path*", destination: "/api/legacy" },
        { source: "/orders/:id", destination: "/api/order?id=:id" },
      ],
      functions: { "api/slow.js": { maxDuration: 1 } },
    })}\n`,
  );
  file("index.html", "<!doctype html><p>static ok</p>\n");
  file("lib/shop.js", "export const secret = 'server code';\n");
  file("api/rw.js", echo("rw"));
  file("api/echo/[...path].js", echo("catch-all"));
  file("api/echo1/[slug].js", echo("one segment"));
  file(
    "api/rwfetch.js",
    "export default { async fetch(request) { return Response.json({ label: 'fetch', url: request.url }); } };\n",
  );
  file(
    "api/legacy.js",
    `export default function handler(req, res) {
  res.status(200).json({ url: req.url, query: req.query, body: req.body, cookies: req.cookies });
}
`,
  );
  file(
    "api/order.js",
    "export default function handler(req, res) { res.send('order ' + req.query.id); }\n",
  );
  file(
    "api/redirect.js",
    "export default function handler(req, res) { res.redirect(303, '/orders/7'); }\n",
  );
  file("api/throws.js", "export function GET() { throw new Error('boom'); }\n");
  file(
    "api/slow.js",
    "export function GET() { return new Promise((r) => setTimeout(() => r(new Response('late')), 3000)); }\n",
  );
  server = createVercelLocal({ root: scratch, log: () => {}, logError: () => {} });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve));
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

test("the trial fixture's copy of vercel-local.mjs is the original", () => {
  const original = readFileSync(path.join(here, "vercel-functions", "vercel-local.mjs"), "utf8");
  const copy = readFileSync(
    path.join(root, "trials/platforms/vercel-functions/fixture/infra/vercel-local.mjs"),
    "utf8",
  );
  assert.equal(copy, original);
});

test("a rewrite keeps the browser's path and appends what it matched", async () => {
  const body = await (await fetch(`${base}/rw/checkouts/prepare?q=2`)).json();
  assert.equal(body.label, "rw");
  assert.equal(body.pathname, "/rw/checkouts/prepare");
  assert.equal(body.search, "?q=2&path=checkouts%2Fprepare");
  const post = await fetch(`${base}/rw/checkouts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"reference":"abc"}',
  });
  assert.equal((await post.json()).body, '{"reference":"abc"}');
  // A parameter the destination uses is not appended again.
  assert.equal(await (await fetch(`${base}/orders/12`)).text(), "order 12");
});

test("[...path].js matches one segment only, outside Next.js", async () => {
  const one = await fetch(`${base}/api/echo/checkouts`);
  assert.equal(one.status, 200);
  assert.equal((await one.json()).search, "?...path=checkouts");
  const deeper = await fetch(`${base}/api/echo/checkouts/prepare`);
  assert.equal(deeper.status, 404);
  assert.match(await deeper.text(), /NOT_FOUND/);
  assert.equal((await (await fetch(`${base}/api/echo1/one`)).json()).search, "?slug=one");
});

test("x-forwarded-for comes from the connection, not the client", async () => {
  const body = await (
    await fetch(`${base}/rw/a`, {
      headers: { "x-forwarded-for": "198.51.100.9", "x-real-ip": "198.51.100.10" },
    })
  ).json();
  assert.equal(body.forwardedFor, "127.0.0.1");
  assert.equal(body.realIp, "127.0.0.1");
});

test("export default { fetch } gets a Request too", async () => {
  const body = await (await fetch(`${base}/rwf/payments/check`)).json();
  assert.equal(body.label, "fetch");
  assert.equal(new URL(body.url).search, "?path=payments%2Fcheck");
});

test("a (req, res) function gets Vercel's helpers and a parsed body", async () => {
  const response = await fetch(`${base}/legacy/swaps/x?y=1`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: "visitor=v1" },
    body: "product_id=2",
  });
  const body = await response.json();
  assert.equal(body.url, "/legacy/swaps/x?y=1&path=swaps%2Fx");
  assert.deepEqual(body.query, { y: "1", path: "swaps/x" });
  assert.deepEqual(body.body, { product_id: "2" });
  assert.deepEqual(body.cookies, { visitor: "v1" });
  const json = await fetch(`${base}/legacy/a`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"reference":"abc"}',
  });
  assert.deepEqual((await json.json()).body, { reference: "abc" });
  const redirect = await fetch(`${base}/api/redirect`, { redirect: "manual" });
  assert.equal(redirect.status, 303);
  assert.equal(redirect.headers.get("location"), "/orders/7");
});

test("static files: the root is served, package files and api/ are not", async () => {
  assert.match(await (await fetch(`${base}/`)).text(), /static ok/);
  // As on Vercel, a server module outside public/ is readable.
  assert.equal((await fetch(`${base}/lib/shop.js`)).status, 200);
  for (const hidden of ["/package.json", "/vercel.json", "/api/rw.js"]) {
    const response = await fetch(`${base}${hidden}`);
    assert.notEqual(response.status, 200, hidden);
  }
});

test("a throwing function and a slow one answer as Vercel does", async () => {
  const thrown = await fetch(`${base}/api/throws`);
  assert.equal(thrown.status, 500);
  assert.match(await thrown.text(), /FUNCTION_INVOCATION_FAILED/);
  const slow = await fetch(`${base}/api/slow`);
  assert.equal(slow.status, 504);
  assert.match(await slow.text(), /FUNCTION_INVOCATION_TIMEOUT/);
  assert.equal((await fetch(`${base}/nothing/here`)).status, 404);
  assert.equal((await fetch(`${base}/api/rwfetch`, { method: "PATCH" })).status, 200);
  assert.equal((await fetch(`${base}/api/rw`, { method: "PATCH" })).status, 405);
});
