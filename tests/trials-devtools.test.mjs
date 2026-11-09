import assert from "node:assert/strict";
import { createCipheriv, createECDH, createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  analyzeScans,
  parseNwcUri,
  relaySockets,
  requestMethod,
} from "../trials/harness/devtools.ts";
import { codesInShopFiles, codesShown, debugPageProbes } from "../trials/harness/leaks.ts";
import { RelayTap } from "../trials/wallet/interceptor/nwc-tap.mjs";

/** The relay-side TCP lines one shop's /proc/net/tcp would show. */
function procTcpLine(remoteHex, state = "01") {
  return `   3: 0200A8C0:D4F6 ${remoteHex} ${state} 00000000:00000000 00:00000000 00000000 1000 0 12345`;
}

test("relaySockets counts established connections to the interceptor's port 443 only", () => {
  // 192.168.32.13 is 0D20A8C0 in /proc/net/tcp's byte order.
  const dump = [
    "  sl  local_address rem_address   st tx_queue",
    procTcpLine("0D20A8C0:01BB"),
    procTcpLine("0D20A8C0:01BB"),
    procTcpLine("0D20A8C0:01BB", "06"),
    procTcpLine("0100007F:01BB"),
    procTcpLine("0D20A8C0:0050"),
    "   5: 0000000000000000FFFF00000200A8C0:D4F6 0000000000000000FFFF00000D20A8C0:01BB 01 00000000:00000000 00:00000000 00000000",
  ].join("\n");
  assert.equal(relaySockets(dump, "192.168.32.13"), 3);
  assert.equal(relaySockets(dump, "192.168.32.14"), 0);
});

test("parseNwcUri reads the wallet key and the client secret, and refuses anything else", () => {
  const wallet = "ab".repeat(32);
  const secret = "cd".repeat(32);
  assert.deepEqual(
    parseNwcUri(`nostr+walletconnect://${wallet}?relay=wss%3A%2F%2Frelay&secret=${secret}`),
    { walletPubkey: wallet, secret },
  );
  assert.equal(parseNwcUri("nostr+walletconnect://short?secret=x"), undefined);
  assert.equal(parseNwcUri("not a code"), undefined);
});

/** A kind-23194 request's content, the way a client encrypts it, under NIP-44 v2. */
function nip44Encrypt(message, clientSecret, walletPubkey) {
  const ecdh = createECDH("secp256k1");
  ecdh.setPrivateKey(Buffer.from(clientSecret, "hex"));
  const shared = ecdh.computeSecret(
    Buffer.concat([Buffer.from([0x02]), Buffer.from(walletPubkey, "hex")]),
  );
  const conversation = createHmac("sha256", "nip44-v2").update(shared).digest();
  const nonce = randomBytes(32);
  let block = Buffer.alloc(0);
  let material = Buffer.alloc(0);
  for (let counter = 1; material.length < 76; counter += 1) {
    block = createHmac("sha256", conversation)
      .update(Buffer.concat([block, nonce, Buffer.from([counter])]))
      .digest();
    material = Buffer.concat([material, block]);
  }
  const iv = Buffer.concat([Buffer.alloc(4), material.subarray(32, 44)]);
  const plain = Buffer.from(message, "utf8");
  const padded = Buffer.alloc(Math.max(32, plain.length));
  plain.copy(padded);
  const frame = Buffer.concat([Buffer.from([plain.length >> 8, plain.length & 0xff]), padded]);
  const cipher = createCipheriv("chacha20", material.subarray(0, 32), iv);
  const ciphertext = Buffer.concat([cipher.update(frame), cipher.final()]);
  const mac = createHmac("sha256", material.subarray(44, 76))
    .update(Buffer.concat([nonce, ciphertext]))
    .digest();
  return Buffer.concat([Buffer.from([2]), nonce, ciphertext, mac]).toString("base64");
}

function nip04Encrypt(message, clientSecret, walletPubkey) {
  const ecdh = createECDH("secp256k1");
  ecdh.setPrivateKey(Buffer.from(clientSecret, "hex"));
  const shared = ecdh.computeSecret(
    Buffer.concat([Buffer.from([0x02]), Buffer.from(walletPubkey, "hex")]),
  );
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", shared, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(message, "utf8")), cipher.final()]);
  return `${encrypted.toString("base64")}?iv=${iv.toString("base64")}`;
}

function testKeys() {
  const client = createECDH("secp256k1");
  client.generateKeys();
  const wallet = createECDH("secp256k1");
  wallet.generateKeys();
  return {
    secret: client.getPrivateKey("hex").padStart(64, "0"),
    walletPubkey: wallet.getPublicKey("hex", "compressed").slice(2),
  };
}

test("requestMethod reads a NIP-44 or NIP-04 request with the trial code, and only that code", () => {
  const keys = testKeys();
  const scan = JSON.stringify({ method: "list_transactions", params: { offset: 0, limit: 20 } });
  const nip44 = {
    at: 1,
    event: {
      content: nip44Encrypt(scan, keys.secret, keys.walletPubkey),
      tags: [["encryption", "nip44_v2"]],
    },
  };
  assert.deepEqual(requestMethod(nip44, [keys]), {
    method: "list_transactions",
    offset: 0,
    unpaid: false,
  });
  const invoice = JSON.stringify({ method: "make_invoice", params: { amount: 1000 } });
  const nip04 = {
    at: 2,
    event: { content: nip04Encrypt(invoice, keys.secret, keys.walletPubkey) },
  };
  assert.deepEqual(requestMethod(nip04, [keys]), {
    method: "make_invoice",
    offset: 0,
    unpaid: false,
  });
  const other = testKeys();
  assert.equal(requestMethod(nip44, [other]), undefined);
});

test("analyzeScans holds the gate: one scan a page, 3 s apart, within the window's budget", () => {
  const keys = testKeys();
  const request = (at, body) => ({
    at,
    event: {
      content: nip44Encrypt(JSON.stringify(body), keys.secret, keys.walletPubkey),
      tags: [],
    },
  });
  const firstPage = { method: "list_transactions", params: { offset: 0 } };
  const secondPage = { method: "list_transactions", params: { offset: 20 } };
  const invoice = { method: "make_invoice", params: {} };
  const within = analyzeScans(
    [
      request(0, firstPage),
      request(5, secondPage),
      request(100, invoice),
      request(3_100, firstPage),
      request(6_500, firstPage),
    ],
    [keys],
    7_000,
  );
  assert.equal(within.scans, 3);
  assert.equal(within.withinBudget, true);
  assert.equal(within.unclassified, 0);

  const bunched = analyzeScans([request(0, firstPage), request(900, firstPage)], [keys], 9_000);
  assert.equal(bunched.withinBudget, false);

  const tooMany = analyzeScans(
    [
      request(0, firstPage),
      request(3_000, firstPage),
      request(6_000, firstPage),
      request(9_000, firstPage),
    ],
    [keys],
    6_000,
  );
  assert.equal(tooMany.withinBudget, false);
});

test("a pass that lists settled and unpaid invoices is one scan", () => {
  const keys = testKeys();
  const request = (at, body) => ({
    at,
    event: {
      content: nip44Encrypt(JSON.stringify(body), keys.secret, keys.walletPubkey),
      tags: [],
    },
  });
  const settledPage = { method: "list_transactions", params: { offset: 0, type: "incoming" } };
  const unpaidPage = {
    method: "list_transactions",
    params: { offset: 0, type: "incoming", unpaid: true },
  };
  const laterPage = { method: "list_transactions", params: { offset: 20, type: "incoming" } };
  // What the PHP, Python, Ruby and Node engines do: two listings, 0.5 s apart, every 5 s.
  const passes = analyzeScans(
    [
      request(0, settledPage),
      request(400, laterPage),
      request(800, unpaidPage),
      request(5_000, settledPage),
      request(5_800, unpaidPage),
    ],
    [keys],
    9_000,
  );
  assert.equal(passes.scans, 2);
  assert.equal(passes.withinBudget, true);
  assert.deepEqual(passes.gaps, [5]);
});

test("an unreadable wallet request counts as a scan rather than vanishing", () => {
  const keys = testKeys();
  const unreadable = { at: 10, event: { content: "not ciphertext", tags: [] } };
  const analysis = analyzeScans([unreadable], [keys], 9_000);
  assert.equal(analysis.scans, 1);
  assert.equal(analysis.unclassified, 1);
});

function maskedFrame(text, { fin = true, opcode = 0x1 } = {}) {
  const payload = Buffer.from(text, "utf8");
  const key = randomBytes(4);
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= key[index % 4];
  const head =
    payload.length < 126
      ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | payload.length])
      : Buffer.from([
          (fin ? 0x80 : 0) | opcode,
          0x80 | 126,
          payload.length >> 8,
          payload.length & 0xff,
        ]);
  return Buffer.concat([head, key, masked]);
}

const UPGRADE =
  "GET /v1 HTTP/1.1\r\nHost: relay\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Extensions: permessage-deflate; client_max_window_bits\r\nSec-WebSocket-Key: abc\r\n\r\n";

test("RelayTap hands on the upgrade without compression and reads NWC requests from masked frames", () => {
  const seen = [];
  const tap = new RelayTap((event) => seen.push(event));
  const event = JSON.stringify([
    "EVENT",
    { id: "e1", kind: 23194, pubkey: "p", created_at: 1, tags: [], content: "abc" },
  ]);
  const out = tap.fromClient(Buffer.from(UPGRADE));
  assert.doesNotMatch(out.toString("latin1"), /permessage-deflate/);
  assert.match(out.toString("latin1"), /Sec-WebSocket-Key: abc/);
  const frame = maskedFrame(event);
  // A frame split across TLS records, then a second one, a ping and a REQ that is not a request.
  assert.deepEqual(tap.fromClient(frame.subarray(0, 5)), frame.subarray(0, 5));
  tap.fromClient(frame.subarray(5));
  tap.fromClient(maskedFrame(JSON.stringify(["EVENT", { id: "e2", kind: 23194, content: "def" }])));
  tap.fromClient(maskedFrame("", { opcode: 0x9 }));
  tap.fromClient(maskedFrame(JSON.stringify(["REQ", "sub", {}])));
  assert.deepEqual(
    seen.map((item) => item.id),
    ["e1", "e2"],
  );
});

test("RelayTap reassembles a fragmented message and leaves plain HTTP alone", () => {
  const seen = [];
  const tap = new RelayTap((event) => seen.push(event));
  tap.fromClient(Buffer.from(UPGRADE));
  const message = JSON.stringify(["EVENT", { id: "e3", kind: 23194, content: "abc" }]);
  tap.fromClient(maskedFrame(message.slice(0, 10), { fin: false }));
  tap.fromClient(maskedFrame(message.slice(10), { opcode: 0x0 }));
  assert.deepEqual(
    seen.map((item) => item.id),
    ["e3"],
  );

  const plain = new RelayTap(() => {
    throw new Error("a plain request is not a relay message");
  });
  const request = Buffer.from("GET /simple/price HTTP/1.1\r\nHost: api\r\n\r\n");
  assert.deepEqual(plain.fromClient(request), request);
  assert.deepEqual(plain.fromClient(Buffer.from("body bytes")), Buffer.from("body bytes"));
});

test("the debug page probes follow the framework a shop runs", () => {
  assert.deepEqual(debugPageProbes({ slug: "django" }), ["django"]);
  assert.deepEqual(debugPageProbes({ slug: "laravel" }), ["laravel"]);
  assert.deepEqual(debugPageProbes({ slug: "rails" }), ["rails"]);
  assert.deepEqual(debugPageProbes({ slug: "next" }), ["next"]);
  assert.deepEqual(debugPageProbes({ slug: "flask" }), ["flask"]);
  assert.deepEqual(debugPageProbes({ slug: "fastify" }), []);
});

test("a debug page is searched for each code and the codes' secret parts", () => {
  const secret = "ef".repeat(32);
  const nwc = `nostr+walletconnect://abcd?relay=wss%3A%2F%2Fr&secret=${secret}`;
  assert.deepEqual(codesShown("nothing to see", { NWC_URI: nwc }), []);
  assert.deepEqual(codesShown(`dump: ${secret.slice(0, 20)}`, { NWC_URI: nwc }), ["NWC_URI"]);
  assert.deepEqual(codesShown("lightning+swapconnect://x", { NWC_URI: nwc }), ["LSC_URI"]);
  // A code the page shows but the shop did not name still counts as one.
  assert.deepEqual(codesShown("nostr+walletconnect://other?secret=1", {}), ["NWC_URI"]);
});

test("a shop's env files name its codes, and a placeholder is not one", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "devtools-env-"));
  await writeFile(
    path.join(directory, ".env"),
    'NWC_URI="nostr+walletconnect://aa?secret=bb"\nLSC_URI_PRIMARY=placeholder\nOTHER=1\n',
  );
  await writeFile(
    path.join(directory, ".env.local"),
    "export LSC_URI_BACKUP=lightning+swapconnect://z?key=1\n",
  );
  const found = await codesInShopFiles(directory);
  assert.deepEqual(found, {
    NWC_URI: "nostr+walletconnect://aa?secret=bb",
    LSC_URI_BACKUP: "lightning+swapconnect://z?key=1",
  });
  await rm(directory, { recursive: true, force: true });
});
