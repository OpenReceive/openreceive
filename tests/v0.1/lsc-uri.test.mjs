import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  formatLscUri,
  parseLscUri,
  readLscConnectionsFromEnvironment,
} from "../../packages/js/node/src/index.ts";

const vectors = JSON.parse(
  await readFile(new URL("../../spec/test-vectors/lsc-uri.json", import.meta.url), "utf8"),
);

test("Node parses the shared LSC URI vectors", () => {
  for (const vector of vectors.valid) {
    const actual = parseLscUri(vector.uri);
    assert.deepEqual(
      {
        uri_protocol: actual.uriProtocol,
        base_url: actual.baseUrl,
        provider_id: actual.providerId,
        key: actual.key,
        secret: actual.secret,
      },
      vector.expected,
      vector.name,
    );
  }
  for (const vector of vectors.invalid) {
    assert.throws(() => parseLscUri(vector.uri), TypeError, vector.name);
  }
});

test("formatLscUri percent-encodes credentials and round-trips", () => {
  const uri = formatLscUri({
    baseUrl: "https://swap.example/api",
    key: "key + one",
    secret: "secret/two",
  });
  assert(!uri.includes("key + one"));
  assert(!uri.includes("secret/two"));
  assert.deepEqual(parseLscUri(uri), {
    uriProtocol: "lightning+swapconnect:",
    baseUrl: "https://swap.example/api/",
    providerId: "swap-example-api",
    key: "key + one",
    secret: "secret/two",
  });
});

test("primary and backup connections are ordered and duplicate providers are rejected", () => {
  const first = "lightning+swapconnect://one.example/?key=k1&secret=s1";
  const second = "lightning+swapconnect://two.example/?key=k2&secret=s2";
  assert.deepEqual(
    readLscConnectionsFromEnvironment({
      LSC_URI_BACKUP: second,
      LSC_URI_PRIMARY: first,
    }).map(({ providerId }) => providerId),
    ["one-example", "two-example"],
  );
  assert.throws(
    () =>
      readLscConnectionsFromEnvironment({
        LSC_URI_PRIMARY: first,
        LSC_URI_BACKUP: first,
      }),
    /duplicates another LSC provider id/,
  );
});

test("LSC parser errors never reveal credentials", () => {
  const credential = "do-not-print-this";
  assert.throws(
    () =>
      parseLscUri(
        `lightning+swapconnect://ff.example/?key=${credential}&secret=${credential}&${credential}=x`,
      ),
    (error) => error instanceof Error && !error.message.includes(credential),
  );
});
