import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { InMemoryInvoiceKvStore } from "../../packages/js/core/src/index.ts";
import {
  OpenReceiveError,
  ReceiveCheckoutValidationError,
  OPENRECEIVE_DATABASE_SCHEMA_VERSION,
  OPENRECEIVE_POSTGRES_MIGRATION_SQL,
  OPENRECEIVE_SQLITE_MIGRATION_SQL,
  createAlbyNwcReceiveClient,
  createOpenReceiveSqliteKvStore,
  createOpenReceiveSqliteQueryClient,
  migrateOpenReceiveSqlite,
  normalizeNwcWalletError,
  resolveOpenReceiveStore,
  summarizeWalletCapabilities
} from "../../packages/js/node/src/index.ts";
import { runOpenReceiveCli } from "../../packages/js/node/src/cli.ts";

const NWC_URI =
  "nostr+walletconnect://" +
  "1".repeat(64) +
  "?relay=wss%3A%2F%2Frelay.example.com&secret=" +
  "2".repeat(64);
const ERROR_NORMALIZATION_VECTORS = JSON.parse(
  readFileSync("spec/test-vectors/error-normalization.json", "utf8")
);
const MAKE_INVOICE_VALIDATION_VECTORS = JSON.parse(
  readFileSync("spec/test-vectors/make-invoice-validation.json", "utf8")
);
const NWC_INFO_VECTORS = JSON.parse(
  readFileSync("spec/test-vectors/nwc-info.json", "utf8")
);
const NWC_REQUEST_RESPONSE_VECTORS = JSON.parse(
  readFileSync("spec/test-vectors/nwc-request-response.json", "utf8")
);

class FakeAlbyClient {
  makeInvoiceParams = [];
  lookupInvoiceParams = [];
  nextResponse = undefined;
  info = {
    capabilities: ["get_info", "make_invoice", "lookup_invoice", "pay_invoice"],
    notifications: ["payment_received"],
    encryptions: ["nip44_v2", "nip04"]
  };

  async getWalletServiceInfo() {
    return this.info;
  }

  async makeInvoice(params) {
    this.makeInvoiceParams.push(params);
    if (this.nextResponse !== undefined) return this.nextResponse;
    return {
      invoice: "lnbc-fake",
      payment_hash: "a".repeat(64),
      amount: params.amount,
      state: "pending",
      created_at: 1000,
      expires_at: 1600
    };
  }

  async lookupInvoice(params) {
    this.lookupInvoiceParams.push(params);
    if (this.nextResponse !== undefined) return this.nextResponse;
    return {
      invoice: "lnbc-fake",
      payment_hash: "a".repeat(64),
      amount: 200000,
      state: "SETTLED",
      settled_at: 1200,
      preimage: "b".repeat(64)
    };
  }
}

test("preflight summarizes receive readiness and warns on spend capability", async () => {
  const fake = new FakeAlbyClient();
  const client = createAlbyNwcReceiveClient({
    connectionString: NWC_URI,
    client: fake
  });

  const summary = await client.preflight();

  assert.equal(summary.receiveCheckoutReady, true);
  assert.equal(summary.encryption, "nip44_v2");
  assert.equal(summary.spendCapabilityAdvertised, true);
  assert.match(summary.warnings[0], /pay_invoice/);
});

test("summarizes NWC info vectors for readiness and encryption", () => {
  const connection = createAlbyNwcReceiveClient({
    connectionString: NWC_URI,
    client: new FakeAlbyClient(),
    requirePreflight: false
  }).connection;

  for (const vector of NWC_INFO_VECTORS.cases) {
    const summary = summarizeWalletCapabilities(connection, vector.raw_info);
    assert.deepEqual(summary.methods, vector.expected.methods, vector.name);
    assert.deepEqual(
      summary.notifications,
      vector.expected.notifications,
      vector.name
    );
    assert.equal(summary.encryption, vector.expected.encryption, vector.name);
    assert.equal(
      summary.spendCapabilityAdvertised,
      vector.expected.spend_capability_advertised,
      vector.name
    );
    assert.equal(
      summary.receiveCheckoutReady,
      vector.expected.receive_checkout_ready,
      vector.name
    );
    for (const method of vector.expected.warning_methods) {
      assert.equal(
        summary.warnings.some((warning) => warning.includes(method)),
        true,
        vector.name
      );
    }
    if (vector.expected.warning_methods.length === 0) {
      assert.equal(summary.warnings.length, 0, vector.name);
    }
  }
});

test("receive client maps amount_msats to NIP-47 amount and normalizes results", async () => {
  for (const vector of NWC_REQUEST_RESPONSE_VECTORS.cases) {
    const fake = new FakeAlbyClient();
    fake.nextResponse = vector.raw_response;
    const client = createAlbyNwcReceiveClient({
      connectionString: NWC_URI,
      client: fake
    });
    const request = makeRequestResponseVectorRequest(vector.openreceive_request);

    if (vector.method === "make_invoice") {
      const invoice = await client.makeInvoice(request);
      assert.deepEqual(
        fake.makeInvoiceParams[0],
        vector.expected_nip47_request,
        vector.name
      );
      assert.deepEqual(
        makeComparableResult(invoice),
        vector.expected_openreceive_response,
        vector.name
      );
    } else if (vector.method === "lookup_invoice") {
      const lookup = await client.lookupInvoice(request);
      assert.deepEqual(
        fake.lookupInvoiceParams[0],
        vector.expected_nip47_request,
        vector.name
      );
      assert.deepEqual(
        makeComparableResult(lookup),
        vector.expected_openreceive_response,
        vector.name
      );
    } else {
      throw new Error(`Unknown vector method: ${vector.method}`);
    }
  }
});

test("receive client enforces make invoice validation vectors", async () => {
  for (const vector of MAKE_INVOICE_VALIDATION_VECTORS.cases) {
    const fake = new FakeAlbyClient();
    const client = createAlbyNwcReceiveClient({
      connectionString: NWC_URI,
      client: fake
    });
    const request = makeInvoiceRequestFromVector(vector.request);

    if (vector.expected.valid) {
      await client.makeInvoice(request);
      assert.equal(fake.makeInvoiceParams.length, 1, vector.name);
    } else {
      await assert.rejects(
        () => client.makeInvoice(request),
        ReceiveCheckoutValidationError,
        vector.name
      );
      assert.equal(fake.makeInvoiceParams.length, 0, vector.name);
    }
  }
});

test("normalizes NWC wallet errors into canonical OpenReceive codes", async () => {
  for (const vector of ERROR_NORMALIZATION_VECTORS.cases) {
    const normalized = normalizeNwcWalletError(vector.raw_error);
    assert.equal(normalized instanceof OpenReceiveError, true, vector.name);
    assert.deepEqual(normalized.toJSON(), vector.expected, vector.name);
  }
});

test("receive client throws normalized wallet errors from make_invoice", async () => {
  class ErroringMakeInvoiceClient extends FakeAlbyClient {
    async makeInvoice(params) {
      this.makeInvoiceParams.push(params);
      throw {
        error: {
          code: "payment_failed",
          message: "Wallet could not create this invoice"
        }
      };
    }
  }

  const client = createAlbyNwcReceiveClient({
    connectionString: NWC_URI,
    client: new ErroringMakeInvoiceClient()
  });

  await assert.rejects(
    () =>
      client.makeInvoice({
        amount_msats: 200000n,
        description: "Fruit sticker"
      }),
    (error) => {
      assert.equal(error instanceof OpenReceiveError, true);
      assert.equal(error.code, "PAYMENT_FAILED");
      assert.equal(error.message, "Wallet could not create this invoice");
      assert.equal(error.retryable, false);
      return true;
    }
  );
});

test("receive client rejects metadata above the NWC payload guard", async () => {
  const client = createAlbyNwcReceiveClient({
    connectionString: NWC_URI,
    client: new FakeAlbyClient()
  });

  await assert.rejects(
    () =>
      client.makeInvoice({
        amount_msats: 200000n,
        description: "Too much metadata",
        metadata: {
          note: "x".repeat(3901)
        }
      }),
    ReceiveCheckoutValidationError
  );
});

test("receive checkout wrapper does not expose payInvoice", () => {
  const client = createAlbyNwcReceiveClient({
    connectionString: NWC_URI,
    client: new FakeAlbyClient()
  });

  assert.equal("payInvoice" in client, false);
});

test("Node SQL store DDL uses opaque records and meta rows", () => {
  assert.match(OPENRECEIVE_POSTGRES_MIGRATION_SQL, /data JSONB NOT NULL/);
  assert.match(OPENRECEIVE_POSTGRES_MIGRATION_SQL, /openreceive_meta/);
  assert.match(OPENRECEIVE_POSTGRES_MIGRATION_SQL, /idempotency_scope TEXT NOT NULL UNIQUE/);
  assert.doesNotMatch(OPENRECEIVE_POSTGRES_MIGRATION_SQL, /workflow_state TEXT/);

  assert.match(OPENRECEIVE_SQLITE_MIGRATION_SQL, /data TEXT NOT NULL/);
  assert.match(OPENRECEIVE_SQLITE_MIGRATION_SQL, /openreceive_meta/);
  assert.match(OPENRECEIVE_SQLITE_MIGRATION_SQL, /bolt11 TEXT NOT NULL UNIQUE/);
  assert.doesNotMatch(OPENRECEIVE_SQLITE_MIGRATION_SQL, /settled_at INTEGER/);
});

test("Node SQLite KV store owns records, indexes, revisions, and meta CAS", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const client = createOpenReceiveSqliteQueryClient(database);
    await migrateOpenReceiveSqlite(client);
    const store = createOpenReceiveSqliteKvStore({ client });
    await store.ensureSchema();
    assert.deepEqual(
      database.prepare("SELECT value FROM openreceive_meta WHERE key = 'schema_version'").all().map((row) => row.value),
      [OPENRECEIVE_DATABASE_SCHEMA_VERSION]
    );

    const record = invoiceRecord();
    const created = await store.putIfAbsent(record);
    const duplicate = await store.putIfAbsent(record);
    assert.equal(created.status, "created");
    assert.equal(duplicate.status, "conflict");
    assert.equal(duplicate.on, "idempotency_scope");
    assert.equal((await store.get(record.row.invoice_id)).row.payment_hash, record.row.payment_hash);
    assert.equal((await store.getByPaymentHash(record.row.payment_hash)).row.invoice_id, record.row.invoice_id);
    assert.equal((await store.getByBolt11Invoice(record.row.invoice)).row.invoice_id, record.row.invoice_id);
    assert.equal((await store.getByIdempotencyScope("node%3Atest:invoice.create:order-sqlite")).row.invoice_id, record.row.invoice_id);

    const stale = await store.put({
      ...record,
      rev: 1
    }, 99);
    assert.equal(stale.status, "conflict");

    const terminal = await store.put({
      rev: created.record.rev + 1,
      row: {
        ...created.record.row,
        transaction_state: "settled",
        workflow_state: "settlement_action_completed",
        settlement_action_state: "completed",
        settled_at: 1200,
        settlement_action_completed_at: 1201
      }
    }, created.record.rev);
    assert.equal(terminal.status, "ok");
    assert.deepEqual(await store.listOpen({ now: 1202, limit: 10 }), []);

    const meta = await store.casMeta("doctor", "one", null);
    assert.equal(meta.status, "ok");
    assert.equal((await store.casMeta("doctor", "two", meta.row.rev)).status, "ok");
    assert.equal((await store.casMeta("doctor", "stale", meta.row.rev)).status, "conflict");
  } finally {
    database.close();
  }
});

test("resolveOpenReceiveStore supports memory and local-sqlite stores", async () => {
  const memory = await resolveOpenReceiveStore("memory:");
  assert.equal(memory instanceof InMemoryInvoiceKvStore, true);

  const tempRoot = mkdtempSync(path.join(tmpdir(), "openreceive-store-uri-"));
  try {
    const local = await resolveOpenReceiveStore("local-sqlite", {
      cwd: tempRoot,
      namespace: "demo"
    });
    try {
      assert.equal(existsSync(path.join(tempRoot, ".openreceive", "demo.sqlite3")), true);
      const created = await local.putIfAbsent(invoiceRecord({
        invoice_id: "or_inv_local_sqlite",
        idempotency_key: "order-local",
        payment_hash: "7".repeat(64),
        invoice: "lnbc-local"
      }));
      assert.equal(created.status, "created");
    } finally {
      await local.close?.();
    }
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("Node CLI initializes worker-free config and doctors local-sqlite", async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "openreceive-node-cli-"));
  const stdout = [];
  const stderr = [];
  const io = (buffer) => ({
    write(message) {
      buffer.push(message);
    }
  });

  try {
    const initCode = await runOpenReceiveCli({
      argv: ["init"],
      cwd: tempRoot,
      stdout: io(stdout),
      stderr: io(stderr)
    });
    assert.equal(initCode, 0);
    assert.equal(existsSync(path.join(tempRoot, ".env.openreceive.example")), true);
    assert.equal(existsSync(path.join(tempRoot, "openreceive.config.mjs")), true);
    assert.equal(existsSync(path.join(tempRoot, "server/openreceive-routes.mjs")), true);
    assert.equal(existsSync(path.join(tempRoot, "scripts/openreceive-poll.mjs")), true);
    assert.equal(existsSync(path.join(tempRoot, "scripts/openreceive-worker.mjs")), false);
    assert.equal(existsSync(path.join(tempRoot, "scripts/openreceive-listen.mjs")), false);
    assert.match(readFileSync(path.join(tempRoot, ".gitignore"), "utf8"), /\.openreceive\//);
    assert.match(readFileSync(path.join(tempRoot, "openreceive.config.mjs"), "utf8"), /resolveOpenReceiveStore/);
    assert.match(readFileSync(path.join(tempRoot, "scripts/openreceive-poll.mjs"), "utf8"), /"--once"/);

    stdout.length = 0;
    stderr.length = 0;
    const configDatabase = new DatabaseSync(":memory:");
    const configStore = createOpenReceiveSqliteKvStore({
      client: createOpenReceiveSqliteQueryClient(configDatabase)
    });
    await configStore.ensureSchema();
    const doctorCode = await runOpenReceiveCli({
      argv: ["doctor"],
      cwd: tempRoot,
      env: {
        OPENRECEIVE_STORE: "local-sqlite",
        OPENRECEIVE_NAMESPACE: "doctor"
      },
      stdout: io(stdout),
      stderr: io(stderr),
      loadConfigModule: async () => ({
        openreceive: {
          store: configStore,
          client: {
            async preflight() {
              return {
                receiveCheckoutReady: true,
                methods: ["make_invoice", "lookup_invoice"],
                notifications: [],
                encryption: "nip44_v2",
                warnings: []
              };
            },
            async makeInvoice() {
              throw new Error("not needed");
            },
            async lookupInvoice() {
              throw new Error("not needed");
            }
          },
          merchantScope: () => "node:test"
        }
      })
    });
    configDatabase.close();
    assert.equal(doctorCode, 0);
    assert.match(stdout.join(""), /ok store local-sqlite namespace=doctor/);
    assert.match(stdout.join(""), /ok store putIfAbsent\/casMeta\/listOpen round-trip/);
    assert.doesNotMatch(stdout.join(""), /nostr\+walletconnect:\/\//);
    assert.equal(stderr.join(""), "");

    stdout.length = 0;
    const printCode = await runOpenReceiveCli({
      argv: ["migrate", "--store", "local-sqlite", "--print"],
      cwd: tempRoot,
      stdout: io(stdout),
      stderr: io(stderr)
    });
    assert.equal(printCode, 0);
    assert.match(stdout.join(""), /CREATE TABLE IF NOT EXISTS openreceive_invoices/);

    stderr.length = 0;
    const workerCode = await runOpenReceiveCli({
      argv: ["worker"],
      cwd: tempRoot,
      stdout: io(stdout),
      stderr: io(stderr)
    });
    assert.equal(workerCode, 1);
    assert.match(stderr.join(""), /worker was removed/);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("Node CLI runs poll --once from a server config module", async () => {
  const store = new InMemoryInvoiceKvStore();
  await store.putIfAbsent(invoiceRecord({
    invoice_id: "or_inv_poll_once",
    idempotency_key: "order-poll-once",
    payment_hash: "6".repeat(64),
    invoice: "lnbc-poll-once"
  }));
  await store.putIfAbsent(invoiceRecord({
    invoice_id: "or_inv_poll_later",
    idempotency_key: "order-poll-later",
    payment_hash: "7".repeat(64),
    invoice: "lnbc-poll-later",
    created_at: 1001
  }));
  const stdout = [];
  const stderr = [];
  let lookupCalls = 0;
  const io = (buffer) => ({
    write(message) {
      buffer.push(message);
    }
  });

  const code = await runOpenReceiveCli({
    argv: ["poll", "--once", "--config", "openreceive.config.mjs"],
    cwd: process.cwd(),
    env: {
      OPENRECEIVE_SWEEP_BATCH: "1"
    },
    stdout: io(stdout),
    stderr: io(stderr),
    loadConfigModule: async () => ({
      openreceive: {
        store,
        client: {
          async makeInvoice() {
            throw new Error("not needed");
          },
          async lookupInvoice(request) {
            lookupCalls += 1;
            assert.equal(request.payment_hash, "6".repeat(64));
            return {
              payment_hash: "6".repeat(64),
              state: "settled",
              settled_at: 1300
            };
          }
        },
        merchantScope: () => "node:test",
        settlementAction: async ({ invoice }) => {
          assert.equal(invoice.invoice_id, "or_inv_poll_once");
        }
      }
    })
  });

  assert.equal(code, 0);
  assert.equal(lookupCalls, 1);
  assert.match(stdout.join(""), /checked 1 wallet invoice/);
  assert.equal((await store.get("or_inv_poll_once")).row.workflow_state, "settlement_action_completed");
  assert.equal((await store.get("or_inv_poll_later")).row.workflow_state, "invoice_created");
  assert.equal(stderr.join(""), "");
});

function invoiceRecord(overrides = {}) {
  return {
    rev: 0,
    row: {
      invoice_id: "or_inv_node_sqlite",
      merchant_scope: "node:test",
      operation: "invoice.create",
      idempotency_key: "order-sqlite",
      idempotency_request_hash: `sha256:${"b".repeat(64)}`,
      payment_hash: "9".repeat(64),
      invoice: "lnbc-node-sqlite",
      amount_msats: 200000,
      transaction_state: "pending",
      workflow_state: "invoice_created",
      settlement_action_state: "pending",
      created_at: 1000,
      expires_at: 1600,
      metadata: {
        user_id: "user-1"
      },
      fiat_quote: null,
      ...overrides
    }
  };
}

function makeInvoiceRequestFromVector(input) {
  const request = {
    amount_msats: BigInt(input.amount_msats)
  };
  if (input.description !== undefined) request.description = input.description;
  if (input.description_hash !== undefined) {
    request.description_hash = input.description_hash;
  }
  if (input.metadata_note_length !== undefined) {
    request.metadata = {
      note: "x".repeat(input.metadata_note_length)
    };
  }
  return request;
}

function makeRequestResponseVectorRequest(input) {
  const request = { ...input };
  if (input.amount_msats !== undefined) {
    request.amount_msats = BigInt(input.amount_msats);
  }
  return request;
}

function makeComparableResult(result) {
  const comparable = { ...result };
  if (typeof comparable.amount_msats === "bigint") {
    comparable.amount_msats = Number(comparable.amount_msats);
  }
  return comparable;
}
