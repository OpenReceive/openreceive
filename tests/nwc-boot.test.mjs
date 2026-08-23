import assert from "node:assert/strict";
import test from "node:test";
import { VALID_NWC } from "./helpers/factories.mjs";
import {
  OPENRECEIVE_NWC_CODE_HELP_URL,
  formatOpenReceiveSpendCapabilityWarningMessage,
} from "../packages/js/core/src/index.ts";
import {
  OpenReceiveConfigError,
  createNwcReceiveClient,
  createOpenReceive,
  readNwcFromEnvironment,
} from "../packages/js/node/src/index.ts";
import { readRequiredHelloFruitNwcConnectionString } from "../examples/hello-fruit/shared/demo-nwc.ts";

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

// The nwc-info vector walk lives in tests/crosslang.test.mjs ("nwc-info vectors
// summarize through the production preflight summary"); this file keeps only the
// boot-time behavior around those summaries.

const SPEND_CAPABLE_WALLET_INFO = {
  getWalletServiceInfo: async () => ({
    capabilities: ["make_invoice", "list_transactions", "pay_invoice"],
    encryptions: ["nip44_v2"],
    notifications: [],
  }),
};

test("preflight fails closed when the info event advertises pay_invoice", async () => {
  const warnings = [];
  const client = createNwcReceiveClient({
    connectionString: VALID_NWC,
    client: SPEND_CAPABLE_WALLET_INFO,
    spendCapabilityWarningDelayMs: 0,
    spendCapabilityWarning: (message) => warnings.push(message),
  });

  await assert.rejects(
    () => client.preflight(),
    (error) => {
      assert.equal(error.name, "WalletPreflightError");
      assert.equal(error.code, "spend_capability_advertised");
      assert.match(error.message, /NOT receive-only/);
      assert.match(error.message, /pay_invoice/);
      assert.match(error.message, new RegExp(OPENRECEIVE_NWC_CODE_HELP_URL.replace(/\./g, "\\.")));
      assert.match(error.message, /allowSpendCapableWallet/);
      return true;
    },
  );
  assert.equal(warnings.length, 0);
});

test("preflight warns and continues only with the explicit spend-capable override", async () => {
  const warnings = [];
  const client = createNwcReceiveClient({
    connectionString: VALID_NWC,
    client: SPEND_CAPABLE_WALLET_INFO,
    allowSpendCapableWallet: true,
    spendCapabilityWarningDelayMs: 0,
    spendCapabilityWarning: (message) => warnings.push(message),
  });

  const summary = await client.preflight();
  assert.equal(summary.spendCapabilityAdvertised, true);
  assert.equal(summary.receiveCheckoutReady, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /NOT receive-only/);
  assert.match(warnings[0], /pay_invoice/);
  assert.match(warnings[0], /override is explicitly set/);
  assert.match(warnings[0], new RegExp(OPENRECEIVE_NWC_CODE_HELP_URL.replace(/\./g, "\\.")));
  assert.equal(
    warnings[0],
    formatOpenReceiveSpendCapabilityWarningMessage({ spendMethods: ["pay_invoice"] }),
  );
});

// NIP-47 keeps the kind-13194 info event (what the wallet SERVICE offers) apart
// from get_info.methods (what THIS connection may call). A receive-only
// connection on a service that also serves spend-capable apps must boot.
test("preflight proves receive-only from get_info.methods, not the service-wide event", async () => {
  let infoEventCalls = 0;
  const client = createNwcReceiveClient({
    connectionString: VALID_NWC,
    client: {
      getWalletServiceInfo: async () => {
        infoEventCalls += 1;
        return {
          capabilities: ["make_invoice", "list_transactions", "pay_invoice"],
          encryptions: ["nip44_v2"],
          notifications: [],
        };
      },
      getInfo: async () => ({ methods: ["make_invoice", "list_transactions"] }),
    },
    spendCapabilityWarningDelayMs: 0,
  });

  const summary = await client.preflight();
  assert.equal(summary.spendCapabilityAdvertised, false);
  assert.deepEqual(summary.methods, ["make_invoice", "list_transactions"]);
  // Encryption is negotiated service-wide, so it still comes from the event.
  assert.equal(summary.encryption, "nip44_v2");
  assert.equal(infoEventCalls, 1);
});

test("preflight refuses a connection whose own get_info.methods carries pay_invoice", async () => {
  const client = createNwcReceiveClient({
    connectionString: VALID_NWC,
    client: {
      getWalletServiceInfo: async () => ({
        capabilities: ["make_invoice", "list_transactions"],
        encryptions: ["nip44_v2"],
      }),
      getInfo: async () => ({ methods: ["make_invoice", "list_transactions", "pay_invoice"] }),
    },
    spendCapabilityWarningDelayMs: 0,
  });

  await assert.rejects(
    () => client.preflight(),
    (error) => {
      assert.equal(error.code, "spend_capability_advertised");
      return true;
    },
  );
});

test("createOpenReceive wraps a spend-capable refusal in WALLET_PREFLIGHT_FAILED", async () => {
  await withEnv(
    { NWC_URI: VALID_NWC, OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC: undefined },
    async () => {
      await assert.rejects(
        () =>
          createOpenReceive({
            client: createNwcReceiveClient({
              connectionString: VALID_NWC,
              client: SPEND_CAPABLE_WALLET_INFO,
              spendCapabilityWarningDelayMs: 0,
            }),
            logging: { enabled: false, console: false },
          }),
        (error) => {
          assert.ok(error instanceof OpenReceiveConfigError);
          assert.equal(error.code, "WALLET_PREFLIGHT_FAILED");
          assert.equal(error.cause?.code, "spend_capability_advertised");
          return true;
        },
      );
    },
  );
});

test("a caught spend-capability refusal never unlocks the client for later calls", async () => {
  let walletCalls = 0;
  let infoCalls = 0;
  const client = createNwcReceiveClient({
    connectionString: VALID_NWC,
    client: {
      getWalletServiceInfo: async () => {
        infoCalls += 1;
        return {
          capabilities: ["make_invoice", "list_transactions", "pay_invoice"],
          encryptions: ["nip44_v2"],
        };
      },
      make_invoice: async () => {
        walletCalls += 1;
        return { invoice: "lnbc1", payment_hash: "f".repeat(64), amount_msats: 1000 };
      },
      list_transactions: async () => {
        walletCalls += 1;
        return { transactions: [] };
      },
    },
    spendCapabilityWarningDelayMs: 0,
  });

  const refused = (error) => {
    assert.equal(error.name, "WalletPreflightError");
    assert.equal(error.code, "spend_capability_advertised");
    return true;
  };

  await assert.rejects(() => client.preflight(), refused);
  // Swallowing the boot refusal must not leave a cached "preflight passed"
  // summary behind for the receive endpoints to sail through.
  await assert.rejects(() => client.makeInvoice({ amount_msats: 1000n }), refused);
  await assert.rejects(() => client.listTransactions({}), refused);
  assert.equal(walletCalls, 0, "no wallet endpoint may run after a refused preflight");
  assert.equal(infoCalls, 3, "each call re-checks the refusal");
});

test("a passing preflight is cached, so receive calls do not re-fetch the info event", async () => {
  let infoCalls = 0;
  const client = createNwcReceiveClient({
    connectionString: VALID_NWC,
    client: {
      getWalletServiceInfo: async () => {
        infoCalls += 1;
        return { methods: ["make_invoice", "list_transactions"], encryption: ["nip44_v2"] };
      },
      list_transactions: async () => ({ transactions: [] }),
    },
  });

  await client.preflight();
  await client.listTransactions({});
  await client.listTransactions({});
  assert.equal(infoCalls, 1);
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

test("preflight rejects a wallet advertising only unsupported encryption modes", async () => {
  const client = createNwcReceiveClient({
    connectionString: VALID_NWC,
    client: {
      getWalletServiceInfo: async () => ({
        methods: ["make_invoice", "list_transactions"],
        encryption: ["nip44_v3"],
      }),
    },
  });
  await assert.rejects(
    () => client.preflight(),
    (error) => {
      assert.equal(error.name, "WalletPreflightError");
      assert.equal(error.code, "unsupported_encryption");
      return true;
    },
  );
});

test("the client's public connection view never carries the secret", () => {
  const client = createNwcReceiveClient({
    connectionString: VALID_NWC,
    client: {
      getWalletServiceInfo: async () => ({ methods: ["make_invoice", "list_transactions"] }),
    },
  });
  assert.equal(client.connection.walletPubkey, "a".repeat(64));
  assert.equal(client.connection.clientSecret, undefined);
  assert.doesNotMatch(JSON.stringify(client.connection), new RegExp("b".repeat(64)));
  assert.match(client.connection.redacted, /secret=/);
  assert.doesNotMatch(client.connection.redacted, new RegExp("b".repeat(64)));
});

test("one malformed wallet row degrades or is skipped; the scan still succeeds", async () => {
  const rows = [
    // Good settled row.
    {
      type: "incoming",
      payment_hash: "c".repeat(64),
      amount: 1000,
      settled_at: 1000.5, // float timestamp: floored, not fatal
      state: "settled",
      preimage: "d".repeat(64),
    },
    // Quirky row: empty strings, bad hash, unparsable amount.
    {
      type: "incoming",
      payment_hash: "not-hex",
      invoice: "",
      preimage: "",
      amount: "NaN-ish",
      settled_at: "soon",
    },
  ];
  const client = createNwcReceiveClient({
    connectionString: VALID_NWC,
    client: {
      getWalletServiceInfo: async () => ({ methods: ["make_invoice", "list_transactions"] }),
      list_transactions: async () => ({ transactions: rows }),
    },
  });
  const result = await client.listTransactions({});
  assert.equal(result.transactions.length, 2);
  assert.equal(result.transactions[0].settled_at, 1000); // floored
  // The quirky row survives with unusable fields degraded to absent.
  assert.equal(result.transactions[1].invoice, undefined);
  assert.equal(result.transactions[1].amount_msats, undefined);
  assert.equal(result.transactions[1].settled_at, undefined);
});

test("an unrecognized non-empty list_transactions reply fails the scan loudly", async () => {
  const client = createNwcReceiveClient({
    connectionString: VALID_NWC,
    client: {
      getWalletServiceInfo: async () => ({ methods: ["make_invoice", "list_transactions"] }),
      list_transactions: async () => ({ rows: [{ payment_hash: "e".repeat(64) }] }),
    },
  });
  await assert.rejects(
    () => client.listTransactions({}),
    (error) => {
      assert.match(String(error.message), /unrecognized|Wallet/i);
      return true;
    },
  );
});
