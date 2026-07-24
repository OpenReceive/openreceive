import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  OPENRECEIVE_NWC_CODE_HELP_URL,
  formatOpenReceiveSpendCapabilityWarningMessage,
  parseNwcUri,
} from "../../packages/js/core/src/index.ts";
import {
  OpenReceiveConfigError,
  createNwcReceiveClient,
  createOpenReceive,
  readNwcFromEnvironment,
  summarizeWalletCapabilities,
} from "../../packages/js/node/src/index.ts";
import { readRequiredHelloFruitNwcConnectionString } from "../../examples/hello-fruit/shared/demo-nwc.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const VALID_NWC = `nostr+walletconnect://${"a".repeat(64)}?relay=wss%3A%2F%2Frelay.example.com&secret=${"b".repeat(64)}`;

async function withEnv(overrides, run) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("createOpenReceive refuses a missing NWC_URI with the help URL", async () => {
  await withEnv({ NWC_URI: undefined }, async () => {
    await assert.rejects(
      () => createOpenReceive({}),
      (error) => {
        assert.ok(error instanceof OpenReceiveConfigError);
        assert.equal(error.code, "MISSING_NWC");
        assert.match(error.message, /needs a receive-only NWC code/);
        assert.match(
          error.message,
          new RegExp(OPENRECEIVE_NWC_CODE_HELP_URL.replace(/\./g, "\\.")),
        );
        return true;
      },
    );
  });
});

test("createOpenReceive refuses an invalid NWC URI with the help URL", async () => {
  await withEnv({ NWC_URI: "https://example.com" }, async () => {
    await assert.rejects(
      () => createOpenReceive({}),
      (error) => {
        assert.ok(error instanceof OpenReceiveConfigError);
        assert.equal(error.code, "INVALID_NWC");
        assert.match(error.message, /not a valid NWC code/);
        assert.match(error.message, /nostr\+walletconnect/);
        assert.match(
          error.message,
          new RegExp(OPENRECEIVE_NWC_CODE_HELP_URL.replace(/\./g, "\\.")),
        );
        return true;
      },
    );
  });
});

test("Hello Fruit NWC gate uses the demo subject and help URL", async () => {
  await withEnv({ NWC_URI: undefined }, () => {
    assert.throws(
      () => readRequiredHelloFruitNwcConnectionString(),
      /The Hello Fruit demo needs a receive-only NWC code[\s\S]*https:\/\/openreceive\.org\/get_a_nwc_code_to_receive_payments/,
    );
  });
  await withEnv({ NWC_URI: "not-a-uri" }, () => {
    assert.throws(
      () => readNwcFromEnvironment({ subject: "The Hello Fruit demo" }),
      /not a valid NWC code[\s\S]*https:\/\/openreceive\.org\/get_a_nwc_code_to_receive_payments/,
    );
  });
});

test("nwc-info vectors normalize spend capability from the info event payload", () => {
  const vector = JSON.parse(
    readFileSync(path.join(root, "spec/test-vectors/nwc-info.json"), "utf8"),
  );
  const connection = parseNwcUri(VALID_NWC);
  for (const item of vector.cases) {
    const summary = summarizeWalletCapabilities(connection, item.raw_info);
    assert.deepEqual(summary.methods, item.expected.methods, item.name);
    assert.equal(summary.encryption, item.expected.encryption, item.name);
    assert.equal(
      summary.spendCapabilityAdvertised,
      item.expected.spend_capability_advertised,
      item.name,
    );
    assert.equal(summary.receiveCheckoutReady, item.expected.receive_checkout_ready, item.name);
    assert.deepEqual(
      summary.warnings.map((warning) => warning.match(/'([^']+)'/)?.[1]).filter(Boolean),
      item.expected.warning_methods,
      item.name,
    );
  }
});

test("preflight warns and continues when the info event advertises pay_invoice", async () => {
  const warnings = [];
  const client = createNwcReceiveClient({
    connectionString: VALID_NWC,
    client: {
      getWalletServiceInfo: async () => ({
        capabilities: ["make_invoice", "list_transactions", "pay_invoice"],
        encryptions: ["nip44_v2"],
        notifications: [],
      }),
    },
    spendCapabilityWarningDelayMs: 0,
    spendCapabilityWarning: (message) => warnings.push(message),
  });

  const summary = await client.preflight();
  assert.equal(summary.spendCapabilityAdvertised, true);
  assert.equal(summary.receiveCheckoutReady, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /NOT receive-only/);
  assert.match(warnings[0], /pay_invoice/);
  assert.match(warnings[0], new RegExp(OPENRECEIVE_NWC_CODE_HELP_URL.replace(/\./g, "\\.")));
  assert.equal(
    warnings[0],
    formatOpenReceiveSpendCapabilityWarningMessage({ spendMethods: ["pay_invoice"] }),
  );
});

test("preflight still fails when the info event omits make_invoice", async () => {
  const client = createNwcReceiveClient({
    connectionString: VALID_NWC,
    client: {
      getWalletServiceInfo: async () => ({
        capabilities: ["list_transactions", "pay_invoice"],
        encryptions: ["nip44_v2"],
        notifications: [],
      }),
    },
    spendCapabilityWarningDelayMs: 0,
  });
  await assert.rejects(() => client.preflight(), /make_invoice and list_transactions/);
});
