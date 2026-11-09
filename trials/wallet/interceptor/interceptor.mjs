// The trial interceptor: a TLS proxy that stands in for the public hosts a
// shop under trial reaches (the NWC relay, the price feeds), so the harness
// can make them slow, down, or silent for one shop at a time.
//
// A shop's compose override maps each intercepted host name to this
// container (extra_hosts), and the shop trusts the trial CA, so the shop
// connects here as if to the real host. Each connection's ClientHello names
// the host (SNI); the interceptor applies the rule for (client IP, host),
// finishes TLS with its own certificate, and pipes the bytes to the real host.
// With no rule a connection passes straight through, so an agent's trial
// runs as it would without the interceptor.
//
// Rules (POST /rules, JSON):
//   { client: "<container name prefix>" | "<IP>" | "*", host: "<name>" | "*",
//     mode: "pass" | "refuse" | "silent",
//     delayMs?: number[],      // hold the handshake for one of these, at random
//     closeAfterMs?: number,   // a passing connection is cut after this long
//     forMs?: number }         // the rule lapses after this long
// refuse ends the handshake with an alert (a relay that is down); silent
// finishes TLS and then answers nothing (a relay that accepted and hung).
// A client is named by Docker's reverse DNS ("ortrial-node-…-web-1.<network>"),
// so a rule for a Compose project's prefix holds across a container restart
// that hands the shop a new address.
//
// GET /health, GET /stats, GET /requests {client?}, POST /reset {client?},
// POST /drop {client?, host?}. /requests lists the NWC requests each shop sent
// its relay, by arrival time; the harness tells a scan from an invoice.

import { promises as dns } from "node:dns";
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { Duplex } from "node:stream";
import tls from "node:tls";
import { RelayTap } from "./nwc-tap.mjs";
import { serverName } from "./sni.mjs";

const LISTEN_PORT = Number(process.env.INTERCEPT_PORT ?? 443);
const CONTROL_PORT = Number(process.env.CONTROL_PORT ?? 7791);
const HOSTS = new Set(
  (process.env.INTERCEPT_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
);
const context = tls.createSecureContext({
  key: readFileSync(process.env.INTERCEPT_KEY ?? "/work/interceptor.key"),
  cert: readFileSync(process.env.INTERCEPT_CERT ?? "/work/interceptor.crt"),
});
/** A ClientHello larger than this is not one. */
const MAX_HELLO = 18 * 1024;
const SILENT_HOLD_MS = 180_000;
/** Enough for any one trial's window; the oldest are dropped first. */
const MAX_NWC_REQUESTS = 20_000;

/** @type {Array<{client: string, host: string, mode: string, delayMs?: number[], closeAfterMs?: number, until?: number}>} */
let rules = [];
/** @type {Map<string, Record<string, number>>} */
const stats = new Map();
/** @type {Set<{client: string, host: string, sockets: Array<{destroy: () => void}>}>} */
const live = new Set();
/** @type {Array<{at: number, client: string, host: string, event: object}>} */
let nwcRequests = [];

function recordNwcRequest(client, host, event) {
  nwcRequests.push({ at: Date.now(), client, host, event });
  if (nwcRequests.length > MAX_NWC_REQUESTS) nwcRequests.shift();
}

function addressOf(socket) {
  return (socket.remoteAddress ?? "").replace(/^::ffff:/, "");
}

/** @type {Map<string, {name: string, at: number}>} */
const names = new Map();

/** The container name Docker's DNS gives an address, or the address itself. */
async function clientOf(address) {
  const cached = names.get(address);
  if (cached !== undefined && Date.now() - cached.at < 10_000) return cached.name;
  const name = await Promise.race([
    dns.reverse(address).then((found) => found[0] ?? address),
    new Promise((resolve) => setTimeout(() => resolve(address), 2_000).unref()),
  ]).catch(() => address);
  names.set(address, { name, at: Date.now() });
  return name;
}

function bump(client, host, field, by = 1) {
  const key = `${client} ${host}`;
  const row = stats.get(key) ?? {
    connections: 0,
    passed: 0,
    refused: 0,
    silenced: 0,
    delayedMs: 0,
    cut: 0,
    upstreamErrors: 0,
  };
  row[field] = (row[field] ?? 0) + by;
  stats.set(key, row);
}

function ruleFor(address, client, host) {
  const now = Date.now();
  rules = rules.filter((rule) => rule.until === undefined || rule.until > now);
  const score = (rule) => (rule.client === "*" ? 0 : 2) + (rule.host === "*" ? 0 : 1);
  const matching = rules
    .filter(
      (rule) =>
        (rule.client === "*" || rule.client === address || client.startsWith(rule.client)) &&
        (rule.host === "*" || rule.host === host),
    )
    .sort((a, b) => score(b) - score(a));
  return matching[0] ?? { mode: "pass" };
}

/** A stream over `socket` that first replays `head`, the bytes already read. */
function replaying(socket, head) {
  const stream = new Duplex({
    read() {
      socket.resume();
    },
    write(chunk, encoding, callback) {
      socket.write(chunk, encoding, callback);
    },
    final(callback) {
      socket.end();
      callback();
    },
    destroy(error, callback) {
      socket.destroy();
      callback(error);
    },
  });
  stream.push(head);
  socket.on("data", (chunk) => {
    if (!stream.push(chunk)) socket.pause();
  });
  socket.on("end", () => stream.push(null));
  socket.on("error", (error) => stream.destroy(error));
  socket.on("close", () => stream.destroy());
  return stream;
}

function pipeUpstream(client, host, secure, rule) {
  const entry = { client, host, sockets: [secure] };
  live.add(entry);
  const upstream = tls.connect({ host, port: 443, servername: host, ALPNProtocols: ["http/1.1"] });
  entry.sockets.push(upstream);
  const done = () => {
    live.delete(entry);
    secure.destroy();
    upstream.destroy();
  };
  upstream.on("error", () => {
    bump(client, host, "upstreamErrors");
    done();
  });
  secure.on("error", done);
  secure.on("close", done);
  upstream.on("close", done);
  // Forward by hand instead of pipe() so the tap reads every frame the shop sends.
  const tap = new RelayTap((event) => recordNwcRequest(client, host, event));
  secure.on("data", (chunk) => {
    const out = tap.fromClient(chunk);
    if (out.length > 0 && !upstream.write(out)) {
      secure.pause();
      upstream.once("drain", () => secure.resume());
    }
  });
  secure.on("end", () => upstream.end());
  upstream.pipe(secure);
  bump(client, host, "passed");
  if (rule.closeAfterMs !== undefined) {
    setTimeout(() => {
      if (!live.has(entry)) return;
      bump(client, host, "cut");
      done();
    }, rule.closeAfterMs).unref();
  }
}

const proxy = net.createServer((socket) => {
  const address = addressOf(socket);
  let head = Buffer.alloc(0);
  socket.on("error", () => socket.destroy());
  const onData = async (chunk) => {
    head = Buffer.concat([head, chunk]);
    const name = serverName(head);
    if (name === null && head.length < MAX_HELLO) return;
    socket.off("data", onData);
    socket.pause();
    if (typeof name !== "string" || !HOSTS.has(name)) {
      socket.destroy();
      return;
    }
    const client = await clientOf(address);
    const rule = ruleFor(address, client, name);
    bump(client, name, "connections");
    const delays = rule.delayMs ?? [];
    const delay = delays.length === 0 ? 0 : delays[Math.floor(Math.random() * delays.length)];
    if (delay > 0) bump(client, name, "delayedMs", delay);
    setTimeout(() => {
      if (socket.destroyed) return;
      if (rule.mode === "refuse") {
        bump(client, name, "refused");
        socket.destroy();
        return;
      }
      const secure = new tls.TLSSocket(replaying(socket, head), {
        isServer: true,
        secureContext: context,
        ALPNProtocols: ["http/1.1"],
      });
      secure.on("error", () => secure.destroy());
      secure.on("secure", () => {
        if (rule.mode === "silent") {
          bump(client, name, "silenced");
          const entry = { client, host: name, sockets: [secure] };
          live.add(entry);
          secure.on("data", () => {});
          secure.on("close", () => live.delete(entry));
          setTimeout(() => secure.destroy(), SILENT_HOLD_MS).unref();
          return;
        }
        pipeUpstream(client, name, secure, rule);
      });
    }, delay);
  };
  socket.on("data", onData);
});

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) reject(new Error("body too large"));
    });
    request.on("end", () => {
      try {
        resolve(body.trim() === "" ? {} : JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function validRule(body) {
  const modes = ["pass", "refuse", "silent"];
  if (typeof body !== "object" || body === null) return "a JSON object";
  if (typeof body.client !== "string" || body.client === "") return "client";
  if (typeof body.host !== "string" || (body.host !== "*" && !HOSTS.has(body.host))) return "host";
  if (!modes.includes(body.mode)) return `mode (${modes.join(", ")})`;
  if (
    body.delayMs !== undefined &&
    (!Array.isArray(body.delayMs) ||
      !body.delayMs.every((ms) => Number.isInteger(ms) && ms >= 0 && ms <= 120_000))
  )
    return "delayMs (whole milliseconds, at most 120000)";
  for (const field of ["closeAfterMs", "forMs"]) {
    if (body[field] !== undefined && !(Number.isInteger(body[field]) && body[field] > 0))
      return field;
  }
  return undefined;
}

function reply(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(body)}\n`);
}

const control = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://control");
    if (request.method === "GET" && url.pathname === "/health") {
      reply(response, 200, { ok: true, hosts: [...HOSTS] });
      return;
    }
    if (request.method === "GET" && url.pathname === "/stats") {
      const client = url.searchParams.get("client");
      const rows = {};
      for (const [key, row] of stats) {
        if (client === null || key.startsWith(client)) rows[key] = row;
      }
      reply(response, 200, { stats: rows, rules, open: live.size });
      return;
    }
    if (request.method === "GET" && url.pathname === "/requests") {
      const client = url.searchParams.get("client");
      const since = Number(url.searchParams.get("since") ?? 0);
      const requests = nwcRequests.filter(
        (item) => item.at >= since && (client === null || item.client.startsWith(client)),
      );
      reply(response, 200, { requests });
      return;
    }
    if (request.method === "POST" && url.pathname === "/rules") {
      const body = await readJson(request);
      const invalid = validRule(body);
      if (invalid !== undefined) {
        reply(response, 400, { error: `invalid ${invalid}` });
        return;
      }
      const rule = {
        client: body.client,
        host: body.host,
        mode: body.mode,
        ...(body.delayMs === undefined ? {} : { delayMs: body.delayMs }),
        ...(body.closeAfterMs === undefined ? {} : { closeAfterMs: body.closeAfterMs }),
        ...(body.forMs === undefined ? {} : { until: Date.now() + body.forMs }),
      };
      rules = rules.filter((item) => !(item.client === rule.client && item.host === rule.host));
      rules.push(rule);
      reply(response, 200, { rules });
      return;
    }
    if (request.method === "POST" && url.pathname === "/reset") {
      const body = await readJson(request);
      const client = typeof body.client === "string" ? body.client : undefined;
      rules = client === undefined ? [] : rules.filter((rule) => rule.client !== client);
      if (client === undefined) {
        stats.clear();
        nwcRequests = [];
      } else {
        for (const key of [...stats.keys()]) if (key.startsWith(client)) stats.delete(key);
        nwcRequests = nwcRequests.filter((item) => !item.client.startsWith(client));
      }
      reply(response, 200, { rules });
      return;
    }
    if (request.method === "POST" && url.pathname === "/drop") {
      const body = await readJson(request);
      let dropped = 0;
      for (const entry of [...live]) {
        if (typeof body.client === "string" && !entry.client.startsWith(body.client)) continue;
        if (typeof body.host === "string" && entry.host !== body.host) continue;
        live.delete(entry);
        for (const socket of entry.sockets) socket.destroy();
        dropped += 1;
      }
      reply(response, 200, { dropped });
      return;
    }
    reply(response, 404, { error: "not found" });
  } catch (error) {
    reply(response, 400, { error: String(error instanceof Error ? error.message : error) });
  }
});

proxy.listen(LISTEN_PORT, "0.0.0.0", () => {
  console.log(`interceptor: ${[...HOSTS].join(", ")} on :${LISTEN_PORT}`);
});
control.listen(CONTROL_PORT, "0.0.0.0", () => {
  console.log(`interceptor: control on :${CONTROL_PORT}`);
});
