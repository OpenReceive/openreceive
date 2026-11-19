#!/usr/bin/env node
// A local stand-in for a Vercel deployment of a site with no framework: static
// files, Node functions under api/, and the rewrites in vercel.json. It does
// what a real deployment did when we measured one on 2026-11-19
// (Fluid compute, Node 24, framework "Other"):
//
//   - The filesystem comes first (static files, then functions), and the
//     rewrites after it.
//   - A rewritten request keeps the URL the browser asked for. The parameters
//     the rewrite matched are appended to its query (`/rw/a/b` through
//     `/rw/:path*` reaches the function as `/rw/a/b?path=a%2Fb`).
//   - `api/[name].js` matches one path segment, and so does
//     `api/[...name].js`: outside Next.js it is not a catch-all. The segment
//     reaches the function as `?name=` (or `?...name=`).
//   - x-forwarded-for, x-real-ip and x-forwarded-proto come from the
//     connection. Whatever a client sent in them is replaced.
//   - Exported GET/POST/… functions, and `export default { fetch }`, get a Web
//     Request. A default-exported function gets Vercel's (req, res) helpers:
//     req.query, req.cookies, a parsed req.body, res.status/json/send/redirect.
//     req.url is the browser's path, as above.
//   - With a public/ folder, only that folder is served. Without one, the
//     project's root is, except api/, node_modules, dotfiles, package files
//     and vercel.json: server modules in lib/ are readable, as on Vercel.
//   - A path nothing serves gets Vercel's NOT_FOUND page; a function that
//     throws, FUNCTION_INVOCATION_FAILED; one that outlasts its maxDuration
//     (vercel.json `functions`, default 300 s), FUNCTION_INVOCATION_TIMEOUT.
//
// Not emulated: instances being suspended, replaced or run side by side
// (one process serves every request, and the modules a function imports are
// shared between functions), the Edge runtime, and vercel.json's redirects,
// headers, has/missing conditions and external rewrites.
//
//   node vercel-local.mjs [--root <dir>] [--port 3000] [--host 127.0.0.1]
//
// tests/vercel-functions/vercel-local.mjs is the original; the trial fixture in
// trials/platforms/vercel-functions keeps an identical copy, which
// tests/vercel-local.test.mjs holds to it.

import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const FUNCTION_EXTENSIONS = [".js", ".mjs", ".cjs"];
const DEFAULT_MAX_DURATION_S = 300;
const MAX_BODY_BYTES = 4.5 * 1024 * 1024;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade"]);
const HIDDEN_AT_ROOT = new Set([
  "api",
  "node_modules",
  "package.json",
  "package-lock.json",
  "vercel.json",
]);

function vercelId() {
  return `dev1::${randomBytes(4).toString("hex")}-${Date.now()}`;
}

function textResponse(status, code, title) {
  return new Response(`${title}\n\n${code}\n\n${vercelId()}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "x-vercel-error": code },
  });
}

const notFound = () => textResponse(404, "NOT_FOUND", "The page could not be found");

/**
 * `/openreceive/:path*` and friends (path-to-regexp's syntax) as a RegExp.
 * An unnamed `(.*)` is `$1`, `$2`, … in the destination.
 */
export function compileSource(source) {
  let pattern = "";
  let unnamed = 0;
  for (const segment of source.split("/").filter(Boolean)) {
    const param = segment.match(/^:([A-Za-z_]\w*)(\(.*\))?([*+?])?$/);
    if (param) {
      const [, name, custom, modifier] = param;
      const repeats = modifier === "*" || modifier === "+";
      const body = custom ? custom.slice(1, -1) : repeats ? ".+" : "[^/]+";
      const group = `(?<${name}>${body})`;
      pattern += modifier === "*" || modifier === "?" ? `(?:/${group})?` : `/${group}`;
    } else if (segment === "(.*)") {
      unnamed += 1;
      pattern += `/(?<_${unnamed}>.*)`;
    } else {
      pattern += `/${segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
    }
  }
  return new RegExp(`^${pattern || "/"}/?$`);
}

/**
 * The rewrite's destination for a matched path, and the named parameters it
 * did not use: Vercel appends those to the query.
 */
export function applyRewrite(rewrite, pathname) {
  const match = rewrite.regex.exec(pathname);
  if (match === null) return undefined;
  let destination = rewrite.destination;
  const appended = [];
  for (const [name, value] of Object.entries(match.groups ?? {})) {
    if (value === undefined) continue;
    if (name.startsWith("_")) {
      destination = destination.replaceAll(`$${name.slice(1)}`, value);
      continue;
    }
    const placeholder = new RegExp(`:${name}(?!\\w)[*+?]?`, "g");
    if (placeholder.test(destination)) destination = destination.replace(placeholder, value);
    else appended.push([name, value]);
  }
  return { destination, appended };
}

/** Every function file under api/, as a route pattern ranked static-first. */
export function functionRoutes(root) {
  const apiDir = path.join(root, "api");
  const routes = [];
  const walk = (directory, segments) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full, [...segments, entry.name]);
        continue;
      }
      const extension = path.extname(entry.name);
      if (!FUNCTION_EXTENSIONS.includes(extension)) continue;
      const name = entry.name.slice(0, -extension.length);
      const parts = ["api", ...segments, ...(name === "index" ? [] : [name])];
      const params = [];
      const pattern = parts
        .map((part) => {
          const dynamic = part.match(/^\[(\.\.\.)?([^\]]+)\]$/);
          if (!dynamic) return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          params.push(`${dynamic[1] ?? ""}${dynamic[2]}`);
          return "([^/]+)";
        })
        .join("/");
      routes.push({
        file: full,
        relative: path.relative(root, full).split(path.sep).join("/"),
        regex: new RegExp(`^/${pattern}/?$`),
        params,
        rank: params.length,
      });
    }
  };
  walk(apiDir, []);
  return routes.sort((left, right) => left.rank - right.rank);
}

function matchFunction(routes, pathname) {
  for (const route of routes) {
    const match = route.regex.exec(pathname);
    if (match === null) continue;
    return {
      route,
      appended: route.params.map((name, index) => [name, decodeURIComponent(match[index + 1])]),
    };
  }
  return undefined;
}

/** A glob from vercel.json `functions` ("api/**\/*.js") against a file. */
function globMatches(glob, file) {
  const regex = glob
    .split("/")
    .map((part) =>
      part === "**"
        ? "(?:.*)"
        : part
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replace(/\*/g, "[^/]*")
            .replace(/\?/g, "[^/]"),
    )
    .join("/")
    .replace(/\(\?:\.\*\)\//g, "(?:.*/)?");
  return new RegExp(`^${regex}$`).test(file);
}

function staticFile(root, staticRoot, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const relative = path.normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, "");
  const parts = relative.split(/[/\\]/).filter(Boolean);
  if (parts.some((part) => part.startsWith("."))) return undefined;
  if (staticRoot === root && parts.length > 0 && HIDDEN_AT_ROOT.has(parts[0])) return undefined;
  let file = path.join(staticRoot, ...parts);
  if (!file.startsWith(staticRoot)) return undefined;
  if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, "index.html");
  return existsSync(file) && statSync(file).isFile() ? file : undefined;
}

function serveStatic(file, method) {
  const body = method === "HEAD" ? null : readFileSync(file);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "public, max-age=0, must-revalidate",
    },
  });
}

function parseCookies(header) {
  const cookies = {};
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

function queryObject(searchParams) {
  const query = {};
  for (const [key, value] of searchParams) {
    if (key in query) query[key] = [].concat(query[key], value);
    else query[key] = value;
  }
  return query;
}

/** Vercel's (req, res) helpers on Node's own objects. */
function legacyInvoke(handler, nodeReq, nodeRes, url, bodyBuffer) {
  const contentType = (nodeReq.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  let parsed;
  let parsedOnce = false;
  Object.defineProperty(nodeReq, "body", {
    configurable: true,
    get() {
      if (parsedOnce) return parsed;
      parsedOnce = true;
      if (bodyBuffer === undefined || bodyBuffer.length === 0) return undefined;
      const text = bodyBuffer.toString("utf8");
      if (contentType === "application/json") {
        try {
          parsed = JSON.parse(text);
        } catch {
          const error = new Error("Invalid JSON");
          error.statusCode = 400;
          throw error;
        }
      } else if (contentType === "application/x-www-form-urlencoded") {
        parsed = queryObject(new URLSearchParams(text));
      } else if (contentType.startsWith("text/")) {
        parsed = text;
      } else {
        parsed = bodyBuffer;
      }
      return parsed;
    },
  });
  nodeReq.url = `${url.pathname}${url.search}`;
  nodeReq.query = queryObject(url.searchParams);
  nodeReq.cookies = parseCookies(nodeReq.headers.cookie);
  nodeRes.status = (code) => {
    nodeRes.statusCode = code;
    return nodeRes;
  };
  nodeRes.send = (body) => {
    if (body === undefined || body === null) return nodeRes.end();
    if (Buffer.isBuffer(body)) {
      if (!nodeRes.getHeader("content-type"))
        nodeRes.setHeader("content-type", "application/octet-stream");
      return nodeRes.end(body);
    }
    if (typeof body === "object") return nodeRes.json(body);
    if (!nodeRes.getHeader("content-type"))
      nodeRes.setHeader("content-type", "text/html; charset=utf-8");
    return nodeRes.end(String(body));
  };
  nodeRes.json = (body) => {
    nodeRes.setHeader("content-type", "application/json; charset=utf-8");
    return nodeRes.end(JSON.stringify(body));
  };
  nodeRes.redirect = (statusOrUrl, maybeUrl) => {
    const [status, location] =
      typeof statusOrUrl === "number" ? [statusOrUrl, maybeUrl] : [307, statusOrUrl];
    nodeRes.statusCode = status;
    nodeRes.setHeader("location", location);
    return nodeRes.end();
  };
  return new Promise((resolve, reject) => {
    nodeRes.on("finish", resolve);
    nodeRes.on("close", resolve);
    Promise.resolve()
      .then(() => handler(nodeReq, nodeRes))
      .catch(reject);
  });
}

async function readBody(nodeReq) {
  const chunks = [];
  let size = 0;
  for await (const chunk of nodeReq) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES)
      throw Object.assign(new Error("body too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function writeResponse(nodeRes, response, method) {
  const headers = {};
  for (const [name, value] of response.headers) {
    if (name === "set-cookie") continue;
    headers[name] = value;
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) headers["set-cookie"] = cookies;
  nodeRes.writeHead(response.status, headers);
  if (method === "HEAD" || response.body === null) {
    nodeRes.end();
    return;
  }
  for await (const chunk of Readable.fromWeb(response.body)) nodeRes.write(chunk);
  nodeRes.end();
}

export function createVercelLocal({
  root,
  log = (line) => console.log(line),
  logError = (error) => console.error(error),
}) {
  const absoluteRoot = path.resolve(root);
  const configFile = path.join(absoluteRoot, "vercel.json");
  const config = existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : {};
  for (const key of ["redirects", "headers", "routes"]) {
    if (config[key] !== undefined) log(`vercel-local: vercel.json "${key}" is not emulated`);
  }
  const rewrites = (config.rewrites ?? []).map((rewrite) => {
    if (rewrite.has !== undefined || rewrite.missing !== undefined) {
      throw new Error(
        `vercel-local: rewrite ${rewrite.source} uses has/missing, which is not emulated`,
      );
    }
    return { ...rewrite, regex: compileSource(rewrite.source) };
  });
  const publicDir = path.join(absoluteRoot, "public");
  const staticRoot = existsSync(publicDir) ? publicDir : absoluteRoot;
  const routes = functionRoutes(absoluteRoot);
  const modules = new Map();

  const maxDurationFor = (relative) => {
    for (const [glob, settings] of Object.entries(config.functions ?? {})) {
      if (globMatches(glob, relative) && typeof settings.maxDuration === "number")
        return settings.maxDuration;
    }
    return DEFAULT_MAX_DURATION_S;
  };

  const loadModule = (route) => {
    let loaded = modules.get(route.file);
    if (loaded === undefined) {
      loaded = import(pathToFileURL(route.file).href);
      modules.set(route.file, loaded);
      loaded
        .then((module) => {
          if (module.config?.runtime === "edge") {
            log(
              `vercel-local: ${route.relative} asks for the Edge runtime, which is not emulated; it runs on Node here`,
            );
          }
        })
        .catch(() => modules.delete(route.file));
    }
    return loaded;
  };

  /** Find what serves `pathname`: a static file or a function, then the rewrites. */
  const resolve = (pathname) => {
    const direct = staticFile(absoluteRoot, staticRoot, pathname);
    if (direct) return { kind: "static", file: direct };
    const fn = matchFunction(routes, pathname);
    if (fn) return { kind: "function", ...fn };
    for (const rewrite of rewrites) {
      const applied = applyRewrite(rewrite, pathname);
      if (applied === undefined) continue;
      if (/^https?:\/\//.test(applied.destination)) return { kind: "external" };
      const target = new URL(applied.destination, "http://destination.invalid");
      const extra = [...target.searchParams];
      const file = staticFile(absoluteRoot, staticRoot, target.pathname);
      if (file) return { kind: "static", file };
      const rewritten = matchFunction(routes, target.pathname);
      if (rewritten) {
        return {
          kind: "function",
          route: rewritten.route,
          appended: [...extra, ...rewritten.appended, ...applied.appended],
        };
      }
      return { kind: "missing" };
    }
    return { kind: "missing" };
  };

  const handle = async (nodeReq, nodeRes) => {
    const started = Date.now();
    const method = (nodeReq.method ?? "GET").toUpperCase();
    const remote = (nodeReq.socket.remoteAddress ?? "127.0.0.1").replace(/^::ffff:/, "");
    const host = nodeReq.headers.host ?? "localhost";
    const url = new URL(nodeReq.url ?? "/", `http://${host}`);
    // Vercel sets these from the connection, never from the client.
    nodeReq.headers["x-forwarded-for"] = remote;
    nodeReq.headers["x-real-ip"] = remote;
    nodeReq.headers["x-vercel-forwarded-for"] = remote;
    nodeReq.headers["x-forwarded-proto"] = "http";
    nodeReq.headers["x-forwarded-host"] = host;
    nodeReq.headers["x-vercel-id"] = vercelId();
    let status = 500;
    try {
      const target = resolve(url.pathname);
      if (target.kind === "static") {
        const response =
          method === "GET" || method === "HEAD"
            ? serveStatic(target.file, method)
            : textResponse(405, "METHOD_NOT_ALLOWED", "Method not allowed");
        status = response.status;
        await writeResponse(nodeRes, response, method);
        return;
      }
      if (target.kind !== "function") {
        const response =
          target.kind === "external"
            ? textResponse(
                502,
                "EXTERNAL_REWRITE_NOT_EMULATED",
                "External rewrites are not emulated",
              )
            : notFound();
        status = response.status;
        await writeResponse(nodeRes, response, method);
        return;
      }
      for (const [name, value] of target.appended) url.searchParams.append(name, value);
      const body = method === "GET" || method === "HEAD" ? undefined : await readBody(nodeReq);
      const module = await loadModule(target.route);
      const maxDurationMs = maxDurationFor(target.route.relative) * 1000;
      const named = METHODS.filter((name) => typeof module[name] === "function");
      let work;
      if (named.length > 0 || typeof module.default?.fetch === "function") {
        const fn =
          module[method] ??
          (named.length === 0 ? module.default.fetch.bind(module.default) : undefined);
        if (fn === undefined) {
          const response = textResponse(405, "METHOD_NOT_ALLOWED", "Method not allowed");
          status = 405;
          await writeResponse(nodeRes, response, method);
          return;
        }
        const headers = new Headers();
        for (const [name, value] of Object.entries(nodeReq.headers)) {
          if (value === undefined || HOP_BY_HOP.has(name)) continue;
          for (const one of [].concat(value)) headers.append(name, one);
        }
        const request = new Request(url, {
          method,
          headers,
          body: body?.length ? body : undefined,
        });
        // A handler that throws before it returns a promise fails the same way.
        work = Promise.resolve()
          .then(() => fn(request))
          .then(async (response) => {
            if (!(response instanceof Response))
              throw new TypeError(`${target.route.relative} did not return a Response`);
            // A reply after the timeout answered has nowhere to go.
            if (nodeRes.headersSent) return;
            status = response.status;
            await writeResponse(nodeRes, response, method);
          });
        work.catch(() => {});
      } else if (typeof module.default === "function") {
        work = legacyInvoke(module.default, nodeReq, nodeRes, url, body).then(() => {
          status = nodeRes.statusCode;
        });
      } else {
        throw new TypeError(`${target.route.relative} exports no handler`);
      }
      let timer;
      const timeout = new Promise((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout("timeout"), maxDurationMs);
      });
      let outcome;
      try {
        outcome = await Promise.race([work, timeout]);
      } finally {
        clearTimeout(timer);
      }
      if (outcome === "timeout") {
        status = 504;
        if (!nodeRes.headersSent) {
          await writeResponse(
            nodeRes,
            textResponse(
              504,
              "FUNCTION_INVOCATION_TIMEOUT",
              "An error occurred with your deployment",
            ),
            method,
          );
        } else nodeRes.destroy();
      }
    } catch (error) {
      status = error?.statusCode ?? 500;
      logError(error);
      if (!nodeRes.headersSent) {
        const response =
          status === 400 || status === 413
            ? textResponse(
                status,
                status === 400 ? "INVALID_REQUEST" : "FUNCTION_PAYLOAD_TOO_LARGE",
                "Bad request",
              )
            : textResponse(500, "FUNCTION_INVOCATION_FAILED", "A server error has occurred");
        status = response.status;
        await writeResponse(nodeRes, response, method).catch(() => nodeRes.destroy());
      } else nodeRes.destroy();
    } finally {
      log(`${method} ${url.pathname} ${status} ${Date.now() - started}ms`);
    }
  };

  return createServer((nodeReq, nodeRes) => {
    handle(nodeReq, nodeRes).catch((error) => {
      logError(error);
      nodeRes.destroy();
    });
  });
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const flag = (name, fallback) => {
    const at = process.argv.indexOf(name);
    return at === -1 ? fallback : process.argv[at + 1];
  };
  const root = flag("--root", process.cwd());
  const port = Number(flag("--port", process.env.PORT ?? "3000"));
  const host = flag("--host", "127.0.0.1");
  const server = createVercelLocal({ root });
  server.listen(port, host, () =>
    console.log(`vercel-local: serving ${path.resolve(root)} on http://${host}:${port}`),
  );
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      server.closeAllConnections();
    });
  }
}
