import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import tls from "node:tls";
import { parse as parseYaml } from "yaml";
import {
  clientPrefix,
  MEASURED_HANDSHAKES_MS,
  structuredError,
  walletServices,
} from "../trials/harness/chaos.ts";
import { shopLogCheck } from "../trials/harness/checks.ts";
import { buyerErrorChecks } from "../trials/harness/live.ts";
import { assertRecheckable, phasesOf, slugOf, stepsOf } from "../trials/harness/recheck.ts";
import { trialWalletOverride } from "../trials/harness/wallet.ts";
import { serverName } from "../trials/wallet/interceptor/sni.mjs";

/** The first bytes a TLS client sends for `servername`: its ClientHello. */
async function clientHello(servername) {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const captured = new Promise((resolve) => {
    server.once("connection", (socket) => {
      socket.once("data", (chunk) => {
        resolve(chunk);
        socket.destroy();
      });
    });
  });
  const client = tls.connect({ host: "127.0.0.1", port, servername });
  client.on("error", () => {});
  const hello = await captured;
  client.destroy();
  server.close();
  return hello;
}

test("the interceptor reads the host a ClientHello names", async () => {
  const hello = await clientHello("relay-nwc.rizful.com");
  assert.equal(serverName(hello), "relay-nwc.rizful.com");
  // A record that has not fully arrived asks for more bytes.
  assert.equal(serverName(hello.subarray(0, 20)), null);
  assert.equal(serverName(Buffer.from([0x16, 0x03])), null);
  // Not a TLS handshake record at all.
  assert.equal(serverName(Buffer.from("GET / HTTP/1.1\r\n\r\n")), undefined);
});

test("chaos rules name a shop by its Compose project, as Docker spells container names", () => {
  assert.equal(clientPrefix("/tmp/ortrial-node-6def8e5c-HhLMKt"), "ortrial-node-6def8e5c-hhlmkt-");
});

test("a chaos restart restarts the wallet services, not the one-shot ones", () => {
  assert.deepEqual(walletServices({ service: "web" }), ["web"]);
  assert.deepEqual(walletServices({}), ["web"]);
  assert.deepEqual(walletServices({ wallet_services: ["wordpress", "cli"] }), ["wordpress"]);
  assert.deepEqual(walletServices({ wallet_services: ["server", "worker", "seed", "server"] }), [
    "server",
    "worker",
  ]);
});

test("a structured error is a 503 or 504 with a code a checkout can turn into a sentence", () => {
  const body = JSON.stringify({ code: "WALLET_UNAVAILABLE", message: "x", retryable: true });
  assert.equal(structuredError({ status: 503, body, ms: 3 }), true);
  assert.equal(structuredError({ status: 504, body, ms: 3 }), true);
  assert.equal(structuredError({ status: 502, body, ms: 3 }), false);
  assert.equal(structuredError({ status: 500, body, ms: 3 }), false);
  assert.equal(
    structuredError({ status: 503, body: "<html>Service Unavailable</html>", ms: 3 }),
    false,
  );
  assert.equal(
    structuredError({ status: 503, body: JSON.stringify({ error: { code: "TIMEOUT" } }), ms: 3 }),
    true,
  );
  assert.equal(structuredError({ status: 503, body: "{}", ms: 3 }), false);
});

test("the measured handshakes include the two that 0.4.31's 1 s PHP limit failed", () => {
  assert.equal(MEASURED_HANDSHAKES_MS.length, 8);
  assert.equal(MEASURED_HANDSHAKES_MS.filter((ms) => ms > 1_000).length, 2);
});

test("a 503 a buyer saw fails the trial even when a retry got past it", () => {
  const ok = { route: "/openreceive/checkouts", status: 201, body: "{}", ms: 10 };
  const retried = {
    route: "/openreceive/checkouts",
    status: 503,
    body: '{"code":"WALLET_UNAVAILABLE","retryable":true}',
    ms: 3000,
  };
  const healthy = buyerErrorChecks([{ answers: [ok, ok] }, { answers: [ok] }]);
  assert.deepEqual(
    healthy.map((item) => [item.id, item.pass]),
    [
      ["live_no_buyer_503", true],
      ["live_no_server_error", true],
    ],
  );
  const [unavailable, serverError] = buyerErrorChecks([{ answers: [retried, ok] }]);
  assert.equal(unavailable.pass, false);
  assert.match(unavailable.evidence, /1 of 2 answers were 503/);
  assert.equal(serverError.pass, true);
  const broken = buyerErrorChecks([
    { answers: [ok, { ...ok, status: 502 }, { ...ok, status: 0, body: "TimeoutError" }] },
  ]);
  assert.equal(broken[0].pass, true);
  assert.equal(broken[1].pass, false);
  assert.match(broken[1].evidence, /2 of 3 answers/);
});

test("recheck finds the platform in a kept shop's directory name", () => {
  assert.equal(slugOf("/tmp/ortrial-node-6def8e5c-HhLMKt"), "node");
  assert.equal(slugOf("/tmp/ortrial-react-router-0123abcd-AbC123"), "react-router");
  assert.throws(() => slugOf("/tmp/some-shop"), /not a kept trial shop/);
  assert.deepEqual(phasesOf(undefined), ["live", "payer", "leaks", "chaos", "logs", "devtools"]);
  assert.deepEqual(phasesOf("chaos"), ["chaos"]);
  assert.deepEqual(phasesOf("wpadmin,two-shops,upgrade"), ["wpadmin", "two-shops", "upgrade"]);
  assert.throws(() => phasesOf("live,party"), /Unknown phase "party"/);
  assert.deepEqual(stepsOf(undefined), ["debug", "build", "tests", "hot", "workers"]);
  assert.deepEqual(stepsOf("hot,workers"), ["hot", "workers"]);
  assert.throws(() => stepsOf("party"), /Unknown step "party"/);
});

test("recheck walks a hosted platform as a payer, and runs nothing else on it", () => {
  for (const host of ["paymenter", "fossbilling", "prestashop", "odoo", "medusa", "vendure"]) {
    assert.doesNotThrow(() => assertRecheckable({ slug: host, host }, ["payer"]), host);
    assert.throws(
      () => assertRecheckable({ slug: host, host }, ["live", "payer"]),
      /pass --phases payer \(not live\)/,
      host,
    );
  }
  assert.doesNotThrow(() =>
    assertRecheckable({ slug: "node" }, ["live", "payer", "leaks", "chaos"]),
  );
  for (const host of ["btcpay", "bolt"]) {
    assert.throws(() => assertRecheckable({ slug: host, host }, ["payer"]), /no payer walk/, host);
  }
});

test("with an interceptor, a shop resolves the relay and price feeds to it", () => {
  const wallet = {
    network: "openreceive-trial",
    caFile: "/repo/trials/wallet/certs/ca.crt",
    caBundle: "/repo/trials/wallet/certs/ca-bundle.crt",
    interceptor: { ip: "192.168.32.7", hosts: ["relay-nwc.rizful.com", "api.coingecko.com"] },
  };
  const override = parseYaml(trialWalletOverride(["web", "worker"], wallet));
  for (const service of Object.values(override.services)) {
    assert.deepEqual(service.extra_hosts, [
      "relay-nwc.rizful.com:192.168.32.7",
      "api.coingecko.com:192.168.32.7",
    ]);
  }
  assert.throws(
    () =>
      trialWalletOverride(["web"], {
        ...wallet,
        interceptor: { ip: "192.168.32.7", hosts: ["bad host: x"] },
      }),
    /Not a host name/,
  );
});

test("friction signals flag the ways an agent works around a gap in the directions", async () => {
  const { frictionSignals } = await import("../trials/harness/checks.ts");
  const shell = (command, exitCode = 0) => ({ type: "shell", command, exitCode });
  const turns = [
    {
      role: "agent",
      text: "",
      tools: [
        shell("NODE_OPTIONS=--experimental-sqlite npx openreceive doctor"),
        shell("npm install better-sqlite3@12.11.1"),
        shell("npm test", 1),
        shell("npm test", 1),
        shell("npm test", 1),
        { type: "fetch", url: "https://openreceive.org/agent-directions/node.md" },
      ],
    },
  ];
  const signals = frictionSignals(turns);
  assert.ok(signals.some((line) => line.startsWith("a NODE_OPTIONS flag")));
  assert.ok(signals.some((line) => line.startsWith("an --experimental flag")));
  assert.ok(signals.some((line) => line.startsWith("a pinned package version")));
  assert.ok(signals.some((line) => line.startsWith("the same command failed 3 times")));
  assert.ok(!signals.some((line) => line.startsWith("fetched")));
  const clean = [
    {
      role: "agent",
      text: "",
      tools: [shell("npm install @openreceive/express"), shell("npx openreceive doctor")],
    },
  ];
  assert.deepEqual(frictionSignals(clean), []);
});

test("the Django debug-page probe reports which codes the page shows", async () => {
  const { debugPageProbes, probeShown } = await import("../trials/harness/leaks.ts");
  assert.deepEqual(
    probeShown("17 objects imported\nOPENRECEIVE_PROBE shown=LSC_URI_PRIMARY,NWC_URI\n"),
    ["LSC_URI_PRIMARY", "NWC_URI"],
  );
  assert.deepEqual(probeShown("OPENRECEIVE_PROBE shown=\n"), []);
  assert.equal(probeShown("Traceback (most recent call last):"), undefined);
  assert.deepEqual(debugPageProbes({ slug: "django" }), ["django"]);
  assert.deepEqual(debugPageProbes({ slug: "flask" }), ["flask"]);
  assert.deepEqual(debugPageProbes({ slug: "fastify" }), []);
});

test("each merchant scenario pastes the code its own way, and mix deals them out", async () => {
  const { pasted, scenarioFor, SCENARIOS } = await import("../trials/harness/scenarios.ts");
  const { merchantReply } = await import("../trials/harness/merchant.ts");
  const nwc = "nostr+walletconnect://abc?relay=wss%3A%2F%2Frelay.example&secret=00ff";
  const lsc = "lightning+swapconnect://fake-lsc:7788/?key=k&secret=s";
  assert.equal(pasted(nwc, SCENARIOS.canonical), nwc);
  assert.equal(pasted(nwc, SCENARIOS["quoted-paste"]), `"${nwc}"`);
  assert.equal(pasted(nwc, SCENARIOS["env-line-paste"]), `NWC_URI=${nwc}`);
  assert.equal(pasted(lsc, SCENARIOS["env-line-paste"]), `LSC_URI_PRIMARY=${lsc}`);
  const wrapped = pasted(nwc, SCENARIOS["wrapped-paste"]);
  assert.equal(wrapped.replace("\n", ""), nwc);
  assert.ok(wrapped.split("\n")[1].includes("secret=00ff"), "the secret stays whole");
  assert.deepEqual(
    [0, 1, 2].map((run) => scenarioFor("mix", run).id),
    ["canonical", "wrapped-paste", "bitcoin-only"],
  );
  assert.throws(() => scenarioFor("pirate", 0), /Unknown scenario "pirate"/);
  const codes = { nwc, lsc };
  assert.equal(
    merchantReply(
      "Please paste your NWC receive-only code here.",
      SCENARIOS["quoted-paste"],
      codes,
    ),
    `"${nwc}"`,
  );
  assert.equal(
    merchantReply(
      "Do you want stablecoins too, or bitcoin only?",
      SCENARIOS["bitcoin-only"],
      codes,
    ),
    "Bitcoin only",
  );
});

test("the review step runs Claude, Codex and Cursor unless told otherwise", async () => {
  const { REVIEW_PROMPT, reviewersOf } = await import("../trials/harness/review.ts");
  assert.deepEqual(reviewersOf(undefined), ["claude", "codex", "cursor"]);
  assert.deepEqual(reviewersOf("codex"), ["codex"]);
  assert.throws(() => reviewersOf("gemini"), /Unknown reviewer "gemini"/);
  for (const file of ["transcript.md", "friction.md", "result.json", "payer/", "shop.log"]) {
    assert.ok(REVIEW_PROMPT.includes(file), `the prompt names ${file}`);
  }
  assert.match(REVIEW_PROMPT, /Do not change any file/);
});

test("the soak fails a checkout outside a fault, growing memory or piling sockets", async () => {
  const { drift, soakChecks } = await import("../trials/harness/soak.ts");
  assert.deepEqual(drift([1, 1, 1, 1, 1, 9, 9, 9, 9, 9]), { start: 1, end: 9 });
  const ok = (at, inFault = false) => ({ at, status: 201, ms: 500, inFault, settled: true });
  const flat = Array.from({ length: 10 }, (_, at) => ({ at, memoryMiB: 120, fds: 30 }));
  const healthy = soakChecks(
    [ok(1), ok(2), { at: 3, status: 503, ms: 5, inFault: true }, ok(4)],
    flat,
  );
  assert.deepEqual(
    healthy.map((item) => [item.id, item.pass]),
    [
      ["soak_checkouts", true],
      ["soak_memory_flat", true],
      ["soak_fds_flat", true],
      ["soak_latency_flat", true],
    ],
  );
  const leaking = Array.from({ length: 10 }, (_, at) => ({
    at,
    memoryMiB: 120 + at * 40,
    fds: 30 + at * 10,
  }));
  const broken = soakChecks([ok(1), { at: 2, status: 502, ms: 3000, inFault: false }], leaking);
  assert.equal(broken[0].pass, false);
  assert.equal(broken[1].pass, false);
  assert.equal(broken[2].pass, false);
});

test("the donation merchant opens with the video-12 ask, not the shop's checkout", async () => {
  const { SCENARIOS } = await import("../trials/harness/scenarios.ts");
  const { openingFor } = await import("../trials/harness/loop.ts");
  const url = "https://openreceive.org/agent-directions/node.md";
  const platform = { slug: "node", prompt_name: "Node.js app" };
  const opening = await openingFor(platform, url, SCENARIOS.donation);
  assert.match(opening, /^This is a Node\.js app\. Add a donation page at \/donate/);
  assert.match(opening, /\$5, \$20 or \$50/);
  assert.ok(opening.endsWith(url));
  assert.equal(SCENARIOS.donation.kind, "donation");
  // A platform with its own opening keeps it.
  const own = await openingFor(
    { ...platform, opening: "Own {{directions_url}}" },
    url,
    SCENARIOS.donation,
  );
  assert.equal(own, `Own ${url}`);
  assert.match(await openingFor(platform, url), /Enable Bitcoin and stablecoin payments/);
});

test("a Bitcoin only closing is not the choice question, and a repeated closing ends the run", async () => {
  const { classify } = await import("../trials/harness/merchant.ts");
  const { repeatedClosing } = await import("../trials/harness/loop.ts");
  const closing = "Bitcoin only is already set. Open http://127.0.0.1:42495 and click Buy to pay.";
  assert.notEqual(classify(closing), "bitcoin_choice");
  assert.equal(classify("Do you want stablecoins too, or Bitcoin only?"), "bitcoin_choice");
  assert.equal(classify("Reply Bitcoin only or stablecoins too."), "bitcoin_choice");
  const agent = (text, tools = []) => ({ role: "agent", text, tools });
  const merchant = { role: "merchant", text: "Yes, go ahead." };
  assert.equal(repeatedClosing([agent(closing), merchant, agent(` ${closing}\n`)]), true);
  assert.equal(
    repeatedClosing([agent(closing), merchant, agent(closing, [{ type: "shell", command: "ls" }])]),
    false,
  );
  assert.equal(repeatedClosing([agent(closing), merchant, agent("Something new.")]), false);
  assert.equal(repeatedClosing([agent(closing)]), false);
});

test("the visitor finds the order id before a guest token, keeps the page, and sends Origin", async () => {
  const { createServer } = await import("node:http");
  const { Visitor } = await import("../trials/harness/live.ts");
  const seen = [];
  let next = "/orders/7/Qx81kTokenAbc";
  const server = createServer((request, response) => {
    seen.push({ method: request.method, url: request.url, origin: request.headers.origin });
    if (request.method === "POST" && request.url === "/orders") {
      response.statusCode = 302;
      response.setHeader("location", next);
      return response.end();
    }
    response.end("<form></form>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const visitor = new Visitor(base);
    assert.equal(await visitor.placeOrder(), "7");
    assert.equal(visitor.orderPage("7"), "/orders/7/Qx81kTokenAbc");
    next = "/checkout/12";
    assert.equal(await visitor.placeOrder(2), "12");
    assert.equal(visitor.orderPage("12"), "/checkout/12");
    assert.equal(visitor.orderPage("99"), "/orders/99");
    const posts = seen.filter((item) => item.method === "POST");
    assert.ok(posts.length >= 2);
    for (const post of posts) assert.equal(post.origin, base);
  } finally {
    server.close();
  }
});

test("a wait the caller never reaches rejects without an unhandled rejection", async () => {
  const { awaitedLater } = await import("../trials/harness/promises.ts");
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  try {
    awaitedLater(Promise.reject(new Error("Target page, context or browser has been closed")));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(unhandled.length, 0);
    await assert.rejects(awaitedLater(Promise.reject(new Error("still thrown"))), /still thrown/);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("the directions-cut scenario cuts on a line, says so, and is told apart from reading on", async () => {
  const { cutDirections } = await import("../trials/harness/serve.ts");
  const { readPastCutCheck } = await import("../trials/harness/checks.ts");
  const { SCENARIOS } = await import("../trials/harness/scenarios.ts");
  const body = Buffer.from("first line\nsecond line\nthird line\n");
  const cut = cutDirections(body, 15).toString();
  assert.match(cut, /^first line\n\n\[output truncated: showing the first 11 of 34 bytes\]\n$/);
  assert.equal(cutDirections(body, 1000), body, "a short file is left alone");
  assert.equal(SCENARIOS["directions-cut"].directionsCutAt, 10_000);

  const after = (tools) => readPastCutCheck([{ role: "agent", text: "", tools }]).pass;
  const shell = (command) => ({ type: "shell", command });
  assert.equal(after([shell("curl -fsSL http://127.0.0.1:4000/node.md?cut=10000")]), false);
  assert.equal(
    after([shell("curl -o /tmp/d.md https://openreceive.org/agent-directions/node/full.md")]),
    true,
  );
  assert.equal(after([shell("curl -fsSL http://127.0.0.1:4000/node.md")]), true);
  assert.equal(
    after([{ type: "fetch", url: "https://openreceive.org/agent-directions/node/full.md" }]),
    true,
  );
});

test("a wallet code in the shop's log fails the run and is never repeated", () => {
  const secret = "a".repeat(64);
  const code = `nostr+walletconnect://${"b".repeat(64)}?relay=wss://r.example/v1&secret=${secret}`;
  const clean = shopLogCheck("web-1  | listening on 3000\nweb-1  | GET /health 200", [code]);
  assert.ok(clean.pass);
  const whole = shopLogCheck(`web-1  | booting\nworker-1  | NWC_URI=${code}`, [code]);
  assert.ok(!whole.pass);
  assert.match(whole.evidence, /worker-1 line 2/);
  assert.ok(!whole.evidence.includes(secret.slice(0, 12)));
  // A piece of the secret is enough: a logger that cuts a line still leaks it.
  const piece = shopLogCheck(`web-1  | secret=${secret.slice(0, 20)}`, [code]);
  assert.ok(!piece.pass);
});
