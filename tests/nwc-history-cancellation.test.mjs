import assert from "node:assert/strict";
import test from "node:test";
import { historyRequest } from "../packages/js/node/src/nwc/history-request.ts";

function sdkFixture({ reply, encrypt } = {}) {
  const stats = { subscriptions: 0, closes: 0, publications: 0, cancelled: 0 };
  let callback;
  const wallet = "a".repeat(64);
  return {
    stats,
    client: {
      walletPubkey: wallet,
      relayUrls: ["wss://relay.invalid"],
      encryptionType: "nip04",
      encrypt: encrypt ?? (async (_key, content) => content),
      decrypt: async (key, content) => {
        assert.equal(key, wallet);
        return content;
      },
      signEvent: async (event) => ({
        ...event,
        id: "test-request",
        pubkey: "b".repeat(64),
        sig: "signed",
      }),
      pool: {
        subscribe(_relays, filter, options) {
          assert.deepEqual(filter.authors, [wallet]);
          assert.deepEqual(filter["#e"], ["test-request"]);
          stats.subscriptions++;
          callback = options.onevent;
          return {
            close() {
              stats.closes++;
            },
          };
        },
        publish(_relays, event, { abort }) {
          stats.publications++;
          assert.equal(JSON.parse(event.content).method, "list_transactions");
          if (reply !== undefined)
            queueMicrotask(() =>
              callback({ pubkey: wallet, tags: [["e", event.id]], content: JSON.stringify(reply) }),
            );
          return [
            new Promise((_resolve, reject) =>
              abort.addEventListener(
                "abort",
                () => {
                  stats.cancelled++;
                  reject(new Error("cancelled"));
                },
                { once: true },
              ),
            ),
          ];
        },
      },
    },
  };
}

test("history completion closes its subscription and cancels queued relay publications", async () => {
  const fixture = sdkFixture({ reply: { result: { transactions: [] } } });
  assert.deepEqual(
    await historyRequest(fixture.client, { limit: 20 }, new AbortController().signal),
    { transactions: [] },
  );
  assert.deepEqual(fixture.stats, { subscriptions: 1, closes: 1, publications: 1, cancelled: 1 });
});

test("scan cancellation closes wallet I/O rather than only abandoning its promise", async () => {
  const fixture = sdkFixture();
  const controller = new AbortController();
  const pending = historyRequest(fixture.client, { limit: 20 }, controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error("scan deadline"));
  await assert.rejects(pending, /scan deadline/);
  assert.deepEqual(fixture.stats, { subscriptions: 1, closes: 1, publications: 1, cancelled: 1 });
});

test("a cancelled preparation cannot publish a late wallet request", async () => {
  let release;
  const fixture = sdkFixture({
    encrypt: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const controller = new AbortController();
  const pending = historyRequest(fixture.client, {}, controller.signal);
  controller.abort(new Error("scan deadline"));
  release("encrypted");
  await assert.rejects(pending, /scan deadline/);
  assert.equal(fixture.stats.publications, 0);
  assert.equal(fixture.stats.subscriptions, 0);
});
