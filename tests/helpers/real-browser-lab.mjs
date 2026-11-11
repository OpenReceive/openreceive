// The browser lab: real browser engines for the JS suite.
//
//   real Chromium / WebKit / Firefox -> a socket on 127.0.0.1 -> the real HTTP
//   handler -> the real SQL repository on in-memory SQLite -> the testkit wallet
//
// tests/helpers/lifecycle-harness.mjs runs the same stack under happy-dom with
// `fetch` stubbed. happy-dom is a stand-in: it does not upgrade custom elements
// the way a browser does (issue 137), has no read-only `Element.prototype.prefix`
// (issue 132), and never aborts a request on the wire. Everything a payer's
// browser does to the checkout that the stand-in cannot do is tested here.
//
// The checkout is the BUILT standalone file (`pretest:js` builds it): the same
// bytes npm, the WordPress ZIP and the wheels carry, never src/. Where each
// framework wrapper comes from is in real-browser-bundles.mjs.
//
// Engines: Chromium, WebKit and Firefox all run. An engine that cannot start
// on this machine (WebKit needs system libraries a host seldom has) is reached
// through a Playwright server instead: OPENRECEIVE_PLAYWRIGHT_SERVER, or the
// one the agent trials keep on ws://127.0.0.1:17894/ (Playwright's own image,
// started by the command in the skip message). An engine neither way can reach
// skips by name, unless OPENRECEIVE_BROWSER_TESTS=require (CI's browser lane),
// where it fails. OPENRECEIVE_BROWSERS=chromium,webkit narrows the list.

import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLifecycleStack } from "./lifecycle-harness.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const STANDALONE_DIR = path.join(repoRoot, "packages/js/elements/dist/standalone");

const ALL_ENGINES = ["chromium", "webkit", "firefox"];
const REQUIRE_BROWSERS = process.env.OPENRECEIVE_BROWSER_TESTS === "require";

/** The engines this run names: all three, or OPENRECEIVE_BROWSERS' list. */
export function requestedEngines() {
  const listed = process.env.OPENRECEIVE_BROWSERS;
  if (listed === undefined || listed.trim() === "") return ALL_ENGINES;
  const names = listed.split(",").map((name) => name.trim());
  for (const name of names) {
    if (!ALL_ENGINES.includes(name)) {
      throw new Error(`OPENRECEIVE_BROWSERS names ${name}; use ${ALL_ENGINES.join(", ")}`);
    }
  }
  return names;
}

const launched = new Map();

/**
 * Launch one engine once per process. Resolves `{ browser }`, or `{ skip }`
 * with the reason when the engine is not installed or cannot start here.
 */
export function launchEngine(name) {
  if (!launched.has(name)) launched.set(name, launch(name));
  return launched.get(name);
}

/** The trials' Playwright server (trials/wallet/compose.yml, profile `webkit`). */
const TRIALS_PLAYWRIGHT_SERVER = "ws://127.0.0.1:17894/";
const START_SERVER =
  "docker compose -p openreceive-trial-wallet -f trials/wallet/compose.yml --profile webkit up -d --wait webkit";

async function launch(name) {
  const playwright = await import("@playwright/test");
  const engine = playwright[name];
  const explicitServer = process.env.OPENRECEIVE_PLAYWRIGHT_SERVER;
  let local;
  if (explicitServer === undefined) {
    if (!existsSync(engine.executablePath())) {
      local = `not installed (\`npx playwright install ${name}\`)`;
    } else {
      try {
        return { browser: await engine.launch(), via: "local" };
      } catch (error) {
        const text = String(error?.message ?? error);
        local = /missing dependencies/i.test(text)
          ? `missing system libraries (\`sudo npx playwright install-deps ${name}\`)`
          : `did not start (${text.split("\n").find((line) => line.trim() !== "") ?? "no reason given"})`;
      }
    }
  }
  const server = explicitServer ?? TRIALS_PLAYWRIGHT_SERVER;
  try {
    return { browser: await engine.connect(server, { timeout: 5_000 }), via: server };
  } catch {
    const reason =
      explicitServer === undefined
        ? `${name} is ${local}, and no Playwright server answers on ${server} (\`${START_SERVER}\`)`
        : `no Playwright server answers on ${server} for ${name}`;
    if (REQUIRE_BROWSERS) throw new Error(`OPENRECEIVE_BROWSER_TESTS=require, and ${reason}`);
    return { skip: reason };
  }
}

export async function closeEngines() {
  for (const pending of launched.values()) {
    const result = await pending.catch(() => undefined);
    await result?.browser?.close().catch(() => undefined);
  }
  launched.clear();
}

// ------------------------------------------------------------------ the server

const CONTENT_TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".html": "text/html; charset=utf-8",
};

function standaloneFile(name) {
  const file = path.join(STANDALONE_DIR, name);
  if (!existsSync(file)) {
    throw new Error(
      `${path.relative(repoRoot, file)} is missing: run \`npm run pretest:js\` ` +
        "(the browser lab serves the built checkout, never src/).",
    );
  }
  return readFileSync(file);
}

/**
 * One shop for one test: the lifecycle stack behind a real socket.
 *
 * `prefix` mounts the routes somewhere other than /openreceive, the way a host
 * that passes `prefix` does. `walletLatencyMs` makes the fake wallet answer
 * like a wallet behind a relay instead of instantly; races between two requests
 * only exist when the first one is still waiting on the wallet.
 */
export async function createLab(options = {}) {
  const stack = await createLifecycleStack({
    ...options,
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
  });
  const prefix = stack.handler.prefix;
  const pages = new Map();
  const assets = new Map();
  const held = new Map();
  /** Every request under the checkout prefix, as the server saw it. */
  const served = [];

  const server = http.createServer((request, response) => {
    void respond(request, response).catch((error) => {
      if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
      response.end(String(error?.stack ?? error));
    });
  });

  async function respond(request, response) {
    const url = new URL(request.url, origin());
    const { pathname } = url;
    if (pathname.startsWith("/lab/standalone/")) {
      const name = pathname.slice("/lab/standalone/".length);
      response.writeHead(200, {
        "content-type": CONTENT_TYPES[path.extname(name)] ?? "application/octet-stream",
      });
      response.end(standaloneFile(name));
      return;
    }
    if (pathname.startsWith("/lab/asset/")) {
      const asset = assets.get(pathname.slice("/lab/asset/".length));
      if (asset === undefined) return notFound(response);
      response.writeHead(200, { "content-type": asset.type });
      response.end(asset.body);
      return;
    }
    if (pathname.startsWith("/lab/release/")) {
      const release = held.get(pathname.slice("/lab/release/".length));
      response.writeHead(204).end();
      release?.();
      return;
    }
    if (pathname.startsWith("/lab/page/")) {
      const page = pages.get(pathname.slice("/lab/page/".length));
      if (page === undefined) return notFound(response);
      response.writeHead(200, { "content-type": CONTENT_TYPES[".html"] });
      if (typeof page === "string") {
        response.end(page);
        return;
      }
      // A streamed page: the first part goes out, and the rest waits until the
      // page itself asks for it (GET /lab/release/<id>), so "the script ran
      // before the parser reached the element" is an order, not a sleep.
      response.write(page.first);
      await new Promise((resolve) => {
        held.set(page.id, resolve);
      });
      response.end(page.rest);
      return;
    }
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      const record = { method: request.method, path: pathname, aborted: false };
      served.push(record);
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      // Seen by the server, dropped by the browser: the request an AbortController
      // cancelled still ran here, exactly as it would on a real shop.
      response.on("close", () => {
        if (!response.writableEnded) record.aborted = true;
      });
      const body = Buffer.concat(chunks);
      const answer = await stack.handler(
        new Request(url, {
          method: request.method,
          headers: fetchHeaders(request.headers),
          ...(body.length === 0 ? {} : { body }),
        }),
      );
      record.status = answer.status;
      const text = await answer.text();
      try {
        record.body = JSON.parse(text);
      } catch {
        record.body = text;
      }
      response.writeHead(answer.status, Object.fromEntries(answer.headers));
      response.end(text);
      return;
    }
    notFound(response);
  }

  function notFound(response) {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  }

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  function origin() {
    return `http://127.0.0.1:${server.address().port}`;
  }

  let nextId = 0;
  return {
    stack,
    prefix,
    served,
    origin: origin(),
    /** Register an HTML document; returns its URL. */
    page(html) {
      nextId += 1;
      const id = String(nextId);
      pages.set(id, html);
      return `${origin()}/lab/page/${id}`;
    },
    /**
     * Register a document sent in two parts: `rest(releaseUrl)` is held back
     * until the page fetches `releaseUrl`.
     */
    streamedPage(first, rest) {
      nextId += 1;
      const id = String(nextId);
      const releaseUrl = `/lab/release/${id}`;
      pages.set(id, { id, first: first(releaseUrl), rest: rest(releaseUrl) });
      return `${origin()}/lab/page/${id}`;
    },
    /** Serve `body` (a bundle a test built) at the returned path. */
    asset(name, body, type = CONTENT_TYPES[".js"]) {
      assets.set(name, { body, type });
      return `/lab/asset/${name}`;
    },
    /** The server-side requests to one route, e.g. `servedTo("/checkouts/prepare")`. */
    servedTo(route) {
      return served.filter((entry) => entry.path === `${prefix}${route}`);
    },
    async close() {
      for (const release of held.values()) release();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await stack.close();
    },
  };
}

function fetchHeaders(nodeHeaders) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(nodeHeaders)) {
    // The handler builds its own framing; these describe the socket, not the request.
    if (name === "connection" || name === "content-length" || name === "host") continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

// ------------------------------------------------------------------- the watch

/**
 * What a page did, recorded from outside it: every checkout request it started,
 * every request the browser gave up on, every script error and console
 * complaint. Install before navigating.
 */
function watch(page, lab) {
  const record = {
    /** Requests under the checkout prefix, in the order the page started them. */
    requests: [],
    /** Requests that never got an answer (aborted, refused, reset). */
    failed: [],
    /** Answers of 400 and above from any URL. */
    refused: [],
    /** console.error and console.warn text, and uncaught exceptions. */
    complaints: [],
    /** Requests to a checkout route (`/checkouts/prepare`, ...), whatever prefix they used. */
    to(route) {
      return this.requests.filter((entry) => entry.path.endsWith(route));
    },
  };
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== lab.origin || url.pathname.startsWith("/lab/")) return;
    record.requests.push({ method: request.method(), path: url.pathname });
  });
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    record.failed.push(
      `${request.method()} ${url.pathname} (${request.failure()?.errorText ?? "failed"})`,
    );
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    record.refused.push(
      `${response.request().method()} ${new URL(response.url()).pathname} -> ${response.status()}`,
    );
  });
  page.on("pageerror", (error) => record.complaints.push(`uncaught: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error" && message.type() !== "warning") return;
    record.complaints.push(`console.${message.type()}: ${message.text()}`);
  });
  return record;
}

/**
 * Runs in the page before any of its scripts: every `fetch` the page calls is
 * written down, with how it ended. This is the count the tests assert on. The
 * network events above differ by engine: Chromium sends a request that is
 * aborted in the same task and reports it failed, Firefox never sends it, so
 * only the page itself knows how many requests its code asked for.
 */
function recordFetches() {
  const calls = [];
  window.__labFetches = calls;
  const realFetch = window.fetch;
  window.fetch = function fetch(...args) {
    const [input, init] = args;
    const url = new URL(
      typeof input === "string" ? input : (input.url ?? String(input)),
      location.href,
    );
    const method =
      init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
    const call = { method: String(method).toUpperCase(), path: url.pathname, outcome: "pending" };
    calls.push(call);
    return realFetch.apply(this, args).then(
      (response) => {
        call.outcome = String(response.status);
        return response;
      },
      (error) => {
        call.outcome = error?.name === "AbortError" ? "aborted" : "failed";
        throw error;
      },
    );
  };
}

/**
 * A new tab in its own context (its own storage and cookies: another device,
 * as far as the shop can tell), watched from before its first request.
 * `fetches(route)` reads the page's own list of `fetch` calls to one route.
 */
export async function openTab(browser, lab, contextOptions = {}) {
  const context = await browser.newContext(contextOptions);
  await context.addInitScript(recordFetches);
  const page = await context.newPage();
  const seen = watch(page, lab);
  return {
    context,
    page,
    seen,
    async fetches(route) {
      // The lab's own plumbing (/lab/...) is not the page's business.
      const calls = (await page.evaluate(() => window.__labFetches ?? [])).filter(
        (call) => !call.path.startsWith("/lab/"),
      );
      return route === undefined ? calls : calls.filter((call) => call.path.endsWith(route));
    },
    close: () => context.close(),
  };
}

// ------------------------------------------------------------------- the pages

/** `<openreceive-checkout a="1" b="2">`, attributes in the order given. */
export function checkoutTag(attributes) {
  const text = Object.entries(attributes)
    .map(([name, value]) => `${name}="${escapeHtml(String(value))}"`)
    .join(" ");
  return `<openreceive-checkout ${text}></openreceive-checkout>`;
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export const STANDALONE_SCRIPT = "/lab/standalone/openreceive-checkout.js";

/** A whole document around `body`; `head` goes inside <head>. */
export function documentHtml({ head = "", body = "", htmlAttributes = "" } = {}) {
  return `<!doctype html>
<html lang="en"${htmlAttributes === "" ? "" : ` ${htmlAttributes}`}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>browser lab</title>
<link rel="icon" href="data:,">
${head}
</head>
<body>
${body}
</body>
</html>`;
}
