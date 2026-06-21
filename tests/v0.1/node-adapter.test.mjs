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
import { InMemoryInvoiceStore } from "../../packages/js/core/src/index.ts";
import {
  OpenReceiveError,
  ReceiveCheckoutValidationError,
  OPENRECEIVE_DATABASE_SCHEMA_VERSION,
  OPENRECEIVE_POSTGRES_MIGRATION_SQL,
  OPENRECEIVE_SQLITE_MIGRATION_SQL,
  createAlbyNwcReceiveClient,
  createOpenReceivePostgresInvoiceStore,
  createOpenReceivePostgresInvoiceStoreFromPool,
  createOpenReceiveSqliteInvoiceStore,
  createOpenReceiveSqliteQueryClient,
  migrateOpenReceiveSqlite,
  normalizeNwcWalletError,
  summarizeWalletCapabilities,
  startPaymentNotificationListener
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

test("Node Postgres store owns invoice persistence and recovery semantics", async () => {
  const db = new FakePostgresClient();
  const store = createOpenReceivePostgresInvoiceStore({ client: db });
  const row = invoiceRow();

  assert.match(OPENRECEIVE_POSTGRES_MIGRATION_SQL, /CREATE TABLE IF NOT EXISTS openreceive_invoices/);
  assert.match(OPENRECEIVE_POSTGRES_MIGRATION_SQL, /CREATE TABLE IF NOT EXISTS openreceive_schema_migrations/);
  assert.match(OPENRECEIVE_POSTGRES_MIGRATION_SQL, new RegExp(`VALUES \\('${OPENRECEIVE_DATABASE_SCHEMA_VERSION}'\\)`));
  assert.match(OPENRECEIVE_POSTGRES_MIGRATION_SQL, /openreceive_invoices_idempotency_scope_idx/);
  assert.match(OPENRECEIVE_POSTGRES_MIGRATION_SQL, /amount_msats >= 1000/);

  const created = await store.createInvoice(row);
  const replayed = await store.createInvoice(row);
  const recoverable = await store.listRecoverableInvoices({ now: 1001 });
  const recoverableAfterLocalExpiry = await store.listRecoverableInvoices({
    now: row.expires_at + 3600,
    grace_seconds: 15
  });

  assert.equal(created.status, "created");
  assert.equal(replayed.status, "replayed");
  assert.equal((await store.getInvoice(row.invoice_id)).payment_hash, row.payment_hash);
  assert.equal((await store.getInvoiceByPaymentHash(row.payment_hash)).invoice_id, row.invoice_id);
  assert.equal((await store.getInvoiceByBolt11Invoice(row.invoice)).invoice_id, row.invoice_id);
  assert.deepEqual(recoverable.map((invoice) => invoice.invoice_id), [row.invoice_id]);
  assert.deepEqual(recoverableAfterLocalExpiry.map((invoice) => invoice.invoice_id), [row.invoice_id]);

  const settled = await store.markSettled({
    invoice_id: row.invoice_id,
    settled_at: 1200
  });
  const completed = await store.markSettlementActionCompleted({
    invoice_id: row.invoice_id,
    settlement_action_completed_at: 1201
  });

  assert.equal(settled.transaction_state, "settled");
  assert.equal(settled.workflow_state, "settlement_action_pending");
  assert.equal(completed.workflow_state, "settlement_action_completed");
  assert.equal(completed.settlement_action_state, "completed");
  assert.equal((await store.listRecoverableInvoices({ now: 1202 })).length, 0);

  await assert.rejects(
    () =>
      store.createInvoice({
        ...row,
        idempotency_request_hash: `sha256:${"c".repeat(64)}`
      }),
    /different request body/
  );
});

test("Node Postgres pool helper owns migration setup before store queries", async () => {
  const calls = [];
  const readyVersions = [];
  const pool = {
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [] };
    }
  };

  const store = createOpenReceivePostgresInvoiceStoreFromPool({
    pool,
    onReady(schemaVersion) {
      readyVersions.push(schemaVersion);
    }
  });

  assert.equal(await store.getInvoice("or_inv_missing"), undefined);
  assert.match(calls[0].sql, /CREATE TABLE IF NOT EXISTS openreceive_invoices/);
  assert.match(calls[0].sql, new RegExp(`VALUES \\('${OPENRECEIVE_DATABASE_SCHEMA_VERSION}'\\)`));
  assert.deepEqual(readyVersions, [OPENRECEIVE_DATABASE_SCHEMA_VERSION]);
  assert.match(calls.at(-1).sql, /SELECT \* FROM "?openreceive_invoices"?/);
  assert.deepEqual(calls.at(-1).values, ["or_inv_missing"]);
});

test("Node SQLite store owns invoice persistence and recovery semantics", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const client = createOpenReceiveSqliteQueryClient(database);
    await migrateOpenReceiveSqlite(client);
    assert.deepEqual(
      database.prepare("SELECT version FROM openreceive_schema_migrations").all().map((row) => row.version),
      [OPENRECEIVE_DATABASE_SCHEMA_VERSION]
    );
    const store = createOpenReceiveSqliteInvoiceStore({ client });
    const row = invoiceRow({
      invoice_id: "or_inv_node_sqlite",
      idempotency_key: "order-sqlite",
      payment_hash: "8".repeat(64),
      invoice: "lnbc-node-sqlite"
    });

    assert.match(OPENRECEIVE_SQLITE_MIGRATION_SQL, /CREATE TABLE IF NOT EXISTS openreceive_invoices/);
    assert.match(OPENRECEIVE_SQLITE_MIGRATION_SQL, /CREATE TABLE IF NOT EXISTS openreceive_schema_migrations/);
    assert.match(OPENRECEIVE_SQLITE_MIGRATION_SQL, new RegExp(`VALUES \\('${OPENRECEIVE_DATABASE_SCHEMA_VERSION}'\\)`));
    assert.match(OPENRECEIVE_SQLITE_MIGRATION_SQL, /openreceive_invoices_idempotency_scope_idx/);
    assert.match(OPENRECEIVE_SQLITE_MIGRATION_SQL, /amount_msats >= 1000/);

    const created = await store.createInvoice(row);
    const replayed = await store.createInvoice(row);
    const recoverable = await store.listRecoverableInvoices({ now: 1001 });
    const recoverableAfterLocalExpiry = await store.listRecoverableInvoices({
      now: row.expires_at + 3600,
      grace_seconds: 15
    });

    assert.equal(created.status, "created");
    assert.equal(replayed.status, "replayed");
    assert.equal((await store.getInvoice(row.invoice_id)).payment_hash, row.payment_hash);
    assert.equal((await store.getInvoiceByPaymentHash(row.payment_hash)).invoice_id, row.invoice_id);
    assert.equal((await store.getInvoiceByBolt11Invoice(row.invoice)).invoice_id, row.invoice_id);
    assert.deepEqual(recoverable.map((invoice) => invoice.invoice_id), [row.invoice_id]);
    assert.deepEqual(recoverableAfterLocalExpiry.map((invoice) => invoice.invoice_id), [row.invoice_id]);

    const settled = await store.markSettled({
      invoice_id: row.invoice_id,
      settled_at: 1200
    });
    const completed = await store.markSettlementActionCompleted({
      invoice_id: row.invoice_id,
      settlement_action_completed_at: 1201
    });

    assert.equal(settled.transaction_state, "settled");
    assert.equal(settled.workflow_state, "settlement_action_pending");
    assert.equal(completed.workflow_state, "settlement_action_completed");
    assert.equal(completed.settlement_action_state, "completed");
    assert.equal((await store.listRecoverableInvoices({ now: 1202 })).length, 0);

    await assert.rejects(
      () =>
        store.createInvoice({
          ...row,
          idempotency_request_hash: `sha256:${"c".repeat(64)}`
        }),
      /different request body/
    );
  } finally {
    database.close();
  }
});

test("Node CLI initializes, migrates, and doctors SQLite setup", async () => {
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
    assert.equal(existsSync(path.join(tempRoot, "openreceive.config.example.mjs")), true);
    assert.equal(existsSync(path.join(tempRoot, "openreceive.config.mjs")), true);
    assert.equal(existsSync(path.join(tempRoot, "server/openreceive-routes.mjs")), true);
    assert.equal(existsSync(path.join(tempRoot, "scripts/openreceive-worker.mjs")), true);
    assert.equal(existsSync(path.join(tempRoot, "scripts/openreceive-poll.mjs")), true);
    assert.equal(existsSync(path.join(tempRoot, "scripts/openreceive-listen.mjs")), true);
    const generatedConfig = readFileSync(
      path.join(tempRoot, "openreceive.config.mjs"),
      "utf8"
    );
    assert.match(generatedConfig, /createOpenReceiveSqliteInvoiceStore/);
    assert.match(generatedConfig, /formatOpenReceiveMissingNwcMessage/);
    assert.match(generatedConfig, /formatOpenReceiveInvalidNwcMessage/);
    assert.match(generatedConfig, /parseNwcConnectionUri/);
    assert.match(
      readFileSync(path.join(tempRoot, "server/openreceive-routes.mjs"), "utf8"),
      /mountOpenReceiveExpressRoutes\(app, openreceive\)/
    );
    assert.match(
      readFileSync(path.join(tempRoot, "scripts/openreceive-worker.mjs"), "utf8"),
      /"worker"/
    );
    assert.match(
      readFileSync(path.join(tempRoot, "scripts/openreceive-poll.mjs"), "utf8"),
      /"poll"/
    );
    assert.doesNotMatch(
      readFileSync(path.join(tempRoot, "scripts/openreceive-poll.mjs"), "utf8"),
      /--config/
    );
    assert.match(
      readFileSync(path.join(tempRoot, "scripts/openreceive-listen.mjs"), "utf8"),
      /"listen"/
    );
    assert.doesNotMatch(
      readFileSync(path.join(tempRoot, "scripts/openreceive-listen.mjs"), "utf8"),
      /--config/
    );

    const sqlitePath = path.join(tempRoot, "storage", "openreceive.sqlite3");
    const migrateCode = await runOpenReceiveCli({
      argv: ["migrate", "--sqlite", sqlitePath],
      env: {},
      stdout: io(stdout),
      stderr: io(stderr)
    });
    assert.equal(migrateCode, 0);

    const doctorCode = await runOpenReceiveCli({
      argv: ["doctor", "--sqlite", sqlitePath],
      env: {},
      stdout: io(stdout),
      stderr: io(stderr)
    });
    assert.equal(doctorCode, 0);
    assert.match(stdout.join(""), /ok migration openreceive_invoices/);
    assert.doesNotMatch(stdout.join(""), /nostr\+walletconnect:\/\//);
    assert.equal(stderr.join(""), "");

    stdout.length = 0;
    stderr.length = 0;
    const configStoreDatabase = new DatabaseSync(sqlitePath);
    const config = {
      client: {
        async preflight() {
          return {
            receiveCheckoutReady: true,
            methods: ["make_invoice", "lookup_invoice"],
            notifications: ["payment_received"],
            encryption: "nip44_v2",
            warnings: [
              `spend capability advertised by nostr+walletconnect://${"a".repeat(64)}?secret=${"b".repeat(64)}`
            ]
          };
        },
        async makeInvoice() {
          throw new Error("not needed");
        },
        async lookupInvoice() {
          throw new Error("not needed");
        },
        async subscribeToPaymentReceived() {
          return () => {};
        }
      },
      store: createOpenReceiveSqliteInvoiceStore({
        client: createOpenReceiveSqliteQueryClient(configStoreDatabase)
      }),
      merchantScope: () => "merchant:test"
    };
    const configDoctorCalls = {
      handlers: 0,
      poll: 0
    };
    const configDoctorCode = await runOpenReceiveCli({
      argv: ["doctor", "--sqlite", sqlitePath],
      cwd: tempRoot,
      env: {},
      stdout: io(stdout),
      stderr: io(stderr),
      loadConfigModule: async (specifier) => {
        assert.match(specifier, /^file:/);
        return { openreceive: config };
      },
      loadExpressRunners: async () => ({
        createOpenReceiveExpressHandlers(openreceive) {
          configDoctorCalls.handlers += 1;
          assert.equal(openreceive, config);
          return {};
        },
        createOpenReceiveExpressSettlementPollingRunner(openreceive, runnerOptions) {
          configDoctorCalls.poll += 1;
          assert.equal(openreceive, config);
          assert.deepEqual(runnerOptions, { recoveryIntervalSeconds: 1 });
          return {
            async recoverOpenInvoices() {
              return { recovered: 0, invoice_ids: [] };
            },
            start() {},
            stop() {}
          };
        },
        async startOpenReceiveExpressPaymentNotificationRunner() {
          throw new Error("doctor should not start the listener");
        }
      })
    });
    configStoreDatabase.close();
    assert.equal(configDoctorCode, 0);
    assert.equal(configDoctorCalls.handlers, 1);
    assert.equal(configDoctorCalls.poll, 1);
    assert.match(stdout.join(""), /ok config loaded/);
    assert.match(stdout.join(""), /ok store package-owned durable invoice store configured/);
    assert.match(stdout.join(""), /ok routes route wiring accepts configured store/);
    assert.match(stdout.join(""), /ok runner poll can be constructed from config/);
    assert.match(stdout.join(""), /ok runner listen can be started; polling remains the settlement fallback/);
    assert.match(stdout.join(""), /ok NWC preflight completed/);
    assert.match(stdout.join(""), /\[REDACTED_NWC\]/);
    assert.doesNotMatch(stdout.join(""), /nostr\+walletconnect:\/\//);
    assert.doesNotMatch(stdout.join(""), /secret=b{64}/);
    assert.equal(stderr.join(""), "");

    const loadNoopExpressDiagnostics = async () => ({
      createOpenReceiveExpressHandlers() {
        return {};
      },
      createOpenReceiveExpressSettlementPollingRunner() {
        return {
          async recoverOpenInvoices() {
            return { recovered: 0, invoice_ids: [] };
          },
          start() {},
          stop() {}
        };
      },
      async startOpenReceiveExpressPaymentNotificationRunner() {
        throw new Error("doctor should not start the listener");
      }
    });

    stdout.length = 0;
    stderr.length = 0;
    const missingStoreDoctorCode = await runOpenReceiveCli({
      argv: ["doctor", "--sqlite", sqlitePath, "--config", "openreceive.config.mjs"],
      cwd: tempRoot,
      env: {},
      stdout: io(stdout),
      stderr: io(stderr),
      loadConfigModule: async () => ({
        openreceive: {
          client: config.client,
          merchantScope: config.merchantScope
        }
      }),
      loadExpressRunners: loadNoopExpressDiagnostics
    });
    assert.equal(missingStoreDoctorCode, 1);
    assert.match(stderr.join(""), /must set a package-owned durable invoice store/);

    stdout.length = 0;
    stderr.length = 0;
    const inMemoryStoreDoctorCode = await runOpenReceiveCli({
      argv: ["doctor", "--sqlite", sqlitePath, "--config", "openreceive.config.mjs"],
      cwd: tempRoot,
      env: {},
      stdout: io(stdout),
      stderr: io(stderr),
      loadConfigModule: async () => ({
        openreceive: {
          client: config.client,
          store: new InMemoryInvoiceStore(),
          merchantScope: config.merchantScope
        }
      }),
      loadExpressRunners: loadNoopExpressDiagnostics
    });
    assert.equal(inMemoryStoreDoctorCode, 1);
    assert.match(stderr.join(""), /uses InMemoryInvoiceStore/);

    stdout.length = 0;
    stderr.length = 0;
    const productionMissingAuthDatabase = new DatabaseSync(sqlitePath);
    const productionMissingAuthCode = await runOpenReceiveCli({
      argv: ["doctor", "--sqlite", sqlitePath, "--config", "openreceive.config.mjs"],
      cwd: tempRoot,
      env: { NODE_ENV: "production" },
      stdout: io(stdout),
      stderr: io(stderr),
      loadConfigModule: async () => ({
        openreceive: {
          client: config.client,
          store: createOpenReceiveSqliteInvoiceStore({
            client: createOpenReceiveSqliteQueryClient(productionMissingAuthDatabase)
          }),
          merchantScope: config.merchantScope
        }
      }),
      loadExpressRunners: loadNoopExpressDiagnostics
    });
    productionMissingAuthDatabase.close();
    assert.equal(productionMissingAuthCode, 1);
    assert.match(stderr.join(""), /missing authorization hooks: create, read, lookup, refresh/);
    assert.match(stderr.join(""), /must protect invoice events/);

    stdout.length = 0;
    stderr.length = 0;
    const productionSecuredDatabase = new DatabaseSync(sqlitePath);
    const productionSecuredCode = await runOpenReceiveCli({
      argv: ["doctor", "--sqlite", sqlitePath, "--config", "openreceive.config.mjs"],
      cwd: tempRoot,
      env: { NODE_ENV: "production" },
      stdout: io(stdout),
      stderr: io(stderr),
      loadConfigModule: async () => ({
        openreceive: {
          client: config.client,
          store: createOpenReceiveSqliteInvoiceStore({
            client: createOpenReceiveSqliteQueryClient(productionSecuredDatabase)
          }),
          merchantScope: config.merchantScope,
          auth: {
            create: () => true,
            read: () => true,
            lookup: () => true,
            refresh: () => true,
            events: () => true
          }
        }
      }),
      loadExpressRunners: loadNoopExpressDiagnostics
    });
    productionSecuredDatabase.close();
    assert.equal(productionSecuredCode, 0);
    assert.match(stdout.join(""), /ok production auth and event authorization diagnostics passed/);
    assert.match(stdout.join(""), /warn production config has no csrf\.verify hook/);
    assert.equal(stderr.join(""), "");

    const database = new DatabaseSync(sqlitePath);
    try {
      database.exec("DROP INDEX openreceive_invoices_recovery_idx");
    } finally {
      database.close();
    }
    stdout.length = 0;
    stderr.length = 0;

    const brokenDoctorCode = await runOpenReceiveCli({
      argv: ["doctor", "--sqlite", sqlitePath],
      env: {},
      stdout: io(stdout),
      stderr: io(stderr)
    });
    assert.equal(brokenDoctorCode, 1);
    assert.match(stderr.join(""), /missing indexes: openreceive_invoices_recovery_idx/);

    const repairedDatabase = new DatabaseSync(sqlitePath);
    try {
      repairedDatabase.exec(
        "CREATE INDEX IF NOT EXISTS openreceive_invoices_recovery_idx ON openreceive_invoices (workflow_state, transaction_state, expires_at)"
      );
    } finally {
      repairedDatabase.close();
    }
    stdout.length = 0;
    stderr.length = 0;

    const versionlessDatabase = new DatabaseSync(sqlitePath);
    try {
      versionlessDatabase.exec("DELETE FROM openreceive_schema_migrations");
    } finally {
      versionlessDatabase.close();
    }
    const versionlessDoctorCode = await runOpenReceiveCli({
      argv: ["doctor", "--sqlite", sqlitePath],
      env: {},
      stdout: io(stdout),
      stderr: io(stderr)
    });
    assert.equal(versionlessDoctorCode, 1);
    assert.match(stderr.join(""), /missing migration versions: v0\.1/);

    const restoredVersionDatabase = new DatabaseSync(sqlitePath);
    try {
      restoredVersionDatabase
        .prepare("INSERT INTO openreceive_schema_migrations (version) VALUES (?)")
        .run(OPENRECEIVE_DATABASE_SCHEMA_VERSION);
    } finally {
      restoredVersionDatabase.close();
    }
    stdout.length = 0;
    stderr.length = 0;

    const leakyNwc =
      `nostr+walletconnect://${"c".repeat(64)}` +
      `?relay=wss%3A%2F%2Frelay.example.com&secret=${"d".repeat(64)}`;
    const leakyConfigDoctorCode = await runOpenReceiveCli({
      argv: ["doctor", "--sqlite", sqlitePath, "--config", "openreceive.config.mjs"],
      cwd: tempRoot,
      env: {},
      stdout: io(stdout),
      stderr: io(stderr),
      loadConfigModule: async () => ({
        openreceive: {
          client: {
            async preflight() {
              throw new Error(`wallet rejected ${leakyNwc}`);
            },
            async makeInvoice() {
              throw new Error("not needed");
            },
            async lookupInvoice() {
              throw new Error("not needed");
            }
          },
          store: {},
          merchantScope: () => "merchant:test"
        }
      }),
      loadExpressRunners: async () => ({
        createOpenReceiveExpressHandlers() {
          throw new Error(`route setup saw ${leakyNwc}`);
        },
        createOpenReceiveExpressSettlementPollingRunner() {
          return {
            async recoverOpenInvoices() {
              return { recovered: 0, invoice_ids: [] };
            },
            start() {},
            stop() {}
          };
        },
        async startOpenReceiveExpressPaymentNotificationRunner() {
          throw new Error("doctor should not start the listener");
        }
      })
    });
    assert.equal(leakyConfigDoctorCode, 1);
    assert.match(stderr.join(""), /\[REDACTED_NWC\]/);
    assert.doesNotMatch(stderr.join(""), /nostr\+walletconnect:\/\//);
    assert.doesNotMatch(stderr.join(""), /secret=d{64}/);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("Node CLI runs poll and listen from a server config module", async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "openreceive-node-runners-"));
  const stdout = [];
  const stderr = [];
  const io = (buffer) => ({
    write(message) {
      buffer.push(message);
    }
  });
  const config = {
    marker: "openreceive-config"
  };
  const calls = {
    config: [],
    pollCreated: 0,
    pollRecovered: 0,
    pollStarted: 0,
    pollStopped: 0,
    listenStarted: 0,
    listenStopped: 0
  };

  const loadConfigModule = async (specifier) => {
    calls.config.push(specifier);
    assert.match(specifier, /^file:/);
    return { openreceive: config };
  };
  const loadExpressRunners = async () => ({
    createOpenReceiveExpressSettlementPollingRunner(openreceive, runnerOptions) {
      calls.pollCreated += 1;
      assert.equal(openreceive, config);
      if (runnerOptions.recoveryIntervalSeconds === undefined) {
        assert.deepEqual(runnerOptions, {});
      } else {
        assert.deepEqual(runnerOptions, { recoveryIntervalSeconds: 7 });
      }
      return {
        async recoverOpenInvoices() {
          calls.pollRecovered += 1;
          return {
            recovered: 2,
            invoice_ids: ["or_inv_1", "or_inv_2"]
          };
        },
        start() {
          calls.pollStarted += 1;
        },
        stop() {
          calls.pollStopped += 1;
        },
      };
    },
    async startOpenReceiveExpressPaymentNotificationRunner(openreceive) {
      calls.listenStarted += 1;
      assert.equal(openreceive, config);
      return {
        async stop() {
          calls.listenStopped += 1;
        }
      };
    }
  });

  try {
    const pollCode = await runOpenReceiveCli({
      argv: [
        "poll",
        "--config",
        "server/openreceive.js",
        "--once",
        "--recovery-interval-seconds",
        "7"
      ],
      cwd: tempRoot,
      env: {},
      stdout: io(stdout),
      stderr: io(stderr),
      loadConfigModule,
      loadExpressRunners
    });
    assert.equal(pollCode, 0);
    assert.match(stdout.join(""), /OpenReceive poll recovered 2 invoice\(s\)\./);

    const listenCode = await runOpenReceiveCli({
      argv: ["listen", "--config", "server/openreceive.js", "--ready-only"],
      cwd: tempRoot,
      env: {},
      stdout: io(stdout),
      stderr: io(stderr),
      loadConfigModule,
      loadExpressRunners
    });
    assert.equal(listenCode, 0);
    assert.match(stdout.join(""), /OpenReceive listen runner readiness verified\./);

    const workerCode = await runOpenReceiveCli({
      argv: ["worker", "--ready-only"],
      cwd: tempRoot,
      env: {},
      stdout: io(stdout),
      stderr: io(stderr),
      loadConfigModule,
      loadExpressRunners
    });
    assert.equal(workerCode, 0);
    assert.match(stdout.join(""), /OpenReceive worker readiness verified\./);
    assert.equal(stderr.join(""), "");
    assert.equal(calls.pollCreated, 2);
    assert.equal(calls.pollRecovered, 1);
    assert.equal(calls.pollStarted, 1);
    assert.equal(calls.pollStopped, 1);
    assert.equal(calls.listenStarted, 2);
    assert.equal(calls.listenStopped, 2);
    assert.equal(calls.config.length, 3);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("payment notification listener dedupes trusted settlement notifications", async () => {
  const client = new FakeNotificationClient();
  const settled = [];
  const listener = await startPaymentNotificationListener({
    client,
    onSettledInvoice: (event) => settled.push(event)
  });

  await client.emit({
    payment_hash: "d".repeat(64),
    amount_msats: 200000n,
    settled_at: 1300
  });
  await client.emit({
    payment_hash: "d".repeat(64),
    amount_msats: 200000n,
    settled_at: 1300
  });

  assert.equal(client.lookupCalls, 0);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].notification.settled_at, 1300);
  assert.equal(listener.seenPaymentHashes.has("d".repeat(64)), true);

  await listener.stop();
  assert.equal(client.unsubscribed, true);
});

test("payment notification listener is safe to start without a subscription method", async () => {
  const listener = await startPaymentNotificationListener({
    client: {
      async makeInvoice() {
        throw new Error("not needed");
      },
      async lookupInvoice() {
        throw new Error("not needed");
      }
    },
    onSettledInvoice: () => {
      throw new Error("should not be called");
    }
  });

  assert.equal(listener.seenPaymentHashes.size, 0);
  await listener.stop();
});

test("payment notification listener trusts notifications without settled_at", async () => {
  const client = new FakeNotificationClient();
  const settled = [];
  await startPaymentNotificationListener({
    client,
    onSettledInvoice: (event) => settled.push(event)
  });

  await client.emit({
    payment_hash: "c".repeat(64)
  });

  assert.equal(client.lookupCalls, 0);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].notification.payment_hash, "c".repeat(64));
});

test("payment notification listener retries redelivery after a transient action error", async () => {
  const settled = [];
  const errors = [];
  let actionCalls = 0;
  const client = {
    handler: undefined,
    async subscribeToPaymentReceived(handler) {
      this.handler = handler;
      return () => {};
    }
  };

  const listener = await startPaymentNotificationListener({
    client,
    onSettledInvoice: (event) => {
      actionCalls += 1;
      if (actionCalls === 1) {
        throw new Error("transient database timeout");
      }
      settled.push(event);
    },
    onError: (error) => errors.push(error)
  });

  const notification = { payment_hash: "a".repeat(64), amount_msats: 200000n };
  // At-least-once: the first delivery fails the local action and must NOT mark
  // the hash seen, so the redelivery can still credit the invoice.
  await client.handler(notification);
  await client.handler(notification);

  assert.equal(actionCalls, 2);
  assert.equal(errors.length, 1);
  assert.equal(settled.length, 1);
  assert.equal(listener.seenPaymentHashes.has("a".repeat(64)), true);

  // A third delivery after a credited settlement is now deduped.
  await client.handler(notification);
  assert.equal(actionCalls, 2);
  assert.equal(settled.length, 1);
});

test("payment notification listener does not dedupe notifications that were not applied", async () => {
  const settled = [];
  const client = {
    handler: undefined,
    async subscribeToPaymentReceived(handler) {
      this.handler = handler;
      return () => {};
    }
  };

  const listener = await startPaymentNotificationListener({
    client,
    onSettledInvoice: (event) => {
      settled.push(event);
      return settled.length > 1;
    }
  });

  const notification = { payment_hash: "e".repeat(64), amount_msats: 200000n };
  await client.handler(notification);
  assert.equal(listener.seenPaymentHashes.has("e".repeat(64)), false);

  await client.handler(notification);
  assert.equal(settled.length, 2);
  assert.equal(listener.seenPaymentHashes.has("e".repeat(64)), true);
});

test("receive client normalizes legacy boolean settled/paid lookup variants", async () => {
  const fake = new FakeAlbyClient();
  const client = createAlbyNwcReceiveClient({
    connectionString: NWC_URI,
    client: fake
  });

  fake.nextResponse = {
    invoice: "lnbc-bool",
    payment_hash: "a".repeat(64),
    amount_msats: 200000,
    settled: true
  };
  const settledLookup = await client.lookupInvoice({ payment_hash: "a".repeat(64) });
  assert.equal(settledLookup.transaction_state, "settled");
  assert.equal(settledLookup.state, undefined);

  fake.nextResponse = {
    invoice: "lnbc-paid",
    payment_hash: "b".repeat(64),
    amount_msats: 200000,
    paid: true
  };
  const paidLookup = await client.lookupInvoice({ payment_hash: "b".repeat(64) });
  assert.equal(paidLookup.transaction_state, "settled");
  assert.equal(paidLookup.state, undefined);
});

class FakeNotificationClient {
  handler = undefined;
  lookupCalls = 0;
  lookupState = "settled";
  unsubscribed = false;

  async preflight() {
    return {
      walletPubkey: "f".repeat(64),
      relays: ["wss://relay.example.com"],
      methods: ["make_invoice", "lookup_invoice"],
      notifications: ["payment_received"],
      encryption: "nip04",
      spendCapabilityAdvertised: false,
      receiveCheckoutReady: true,
      warnings: []
    };
  }

  async makeInvoice() {
    throw new Error("not needed");
  }

  async lookupInvoice(request) {
    this.lookupCalls += 1;
    return {
      invoice: "lnbc-fake",
      payment_hash: request.payment_hash,
      amount_msats: 200000n,
      state: this.lookupState,
      settled_at: this.lookupState === "settled" ? 1300 : undefined
    };
  }

  async subscribeToPaymentReceived(handler) {
    this.handler = handler;
    return () => {
      this.unsubscribed = true;
    };
  }

  async emit(notification) {
    await this.handler(notification);
  }
}

class FakePostgresClient {
  rows = [];

  async query(sql, values = []) {
    if (sql.includes("WHERE merchant_scope = $1")) {
      const [merchantScope, operation, idempotencyKey] = values;
      return {
        rows: this.rows.filter(
          (row) =>
            row.merchant_scope === merchantScope &&
            row.operation === operation &&
            row.idempotency_key === idempotencyKey
        ).slice(0, 1)
      };
    }

    if (sql.includes("WHERE invoice_id = $1 LIMIT")) {
      return {
        rows: this.rows.filter((row) => row.invoice_id === values[0]).slice(0, 1)
      };
    }

    if (sql.includes("WHERE payment_hash = $1")) {
      return {
        rows: this.rows.filter((row) => row.payment_hash === values[0]).slice(0, 1)
      };
    }

    if (sql.includes("WHERE invoice = $1")) {
      return {
        rows: this.rows.filter((row) => row.invoice === values[0]).slice(0, 1)
      };
    }

    if (sql.includes("INSERT INTO")) {
      const row = {
        invoice_id: values[0],
        merchant_scope: values[1],
        operation: values[2],
        idempotency_key: values[3],
        idempotency_request_hash: values[4],
        payment_hash: values[5],
        invoice: values[6],
        amount_msats: values[7],
        transaction_state: values[8],
        workflow_state: values[9],
        settlement_action_state: values[10],
        created_at: values[11],
        expires_at: values[12],
        settled_at: values[13],
        settlement_action_completed_at: values[14],
        refreshed_from_invoice_id: values[15],
        metadata: values[16],
        fiat_quote: values[17]
      };
      if (
        this.rows.some(
          (item) =>
            item.invoice_id === row.invoice_id ||
            item.payment_hash === row.payment_hash ||
            item.invoice === row.invoice
        )
      ) {
        throw { code: "23505" };
      }
      this.rows.push(row);
      return { rows: [structuredClone(row)] };
    }

    if (sql.includes("ORDER BY created_at")) {
      return {
        rows: this.rows
          .filter((row) => isRecoverableFakeRow(row))
          .sort((left, right) => left.created_at - right.created_at)
          .map((row) => structuredClone(row))
      };
    }

    if (sql.includes("settlement_action_completed_at = COALESCE")) {
      const row = this.requireRow(values[0]);
      row.workflow_state = "settlement_action_completed";
      row.settlement_action_state = "completed";
      row.settlement_action_completed_at ??= values[1];
      return { rows: [structuredClone(row)] };
    }

    if (sql.includes("settlement_action_state = 'failed'")) {
      const row = this.requireRow(values[0]);
      row.workflow_state = "settlement_action_pending";
      row.settlement_action_state = "failed";
      return { rows: [structuredClone(row)] };
    }

    if (sql.includes("SET transaction_state = 'settled'")) {
      const row = this.requireRow(values[0]);
      row.transaction_state = "settled";
      if (row.workflow_state !== "settlement_action_completed") {
        row.workflow_state = "settlement_action_pending";
      }
      row.settled_at ??= values[1];
      return { rows: [structuredClone(row)] };
    }

    if (sql.includes("ELSE 'expired'")) {
      const row = this.requireRow(values[0]);
      if (row.transaction_state !== "settled") {
        row.transaction_state = "expired";
        row.workflow_state = "expired_closed";
      }
      return { rows: [structuredClone(row)] };
    }

    if (sql.includes("ELSE 'failed'")) {
      const row = this.requireRow(values[0]);
      if (row.transaction_state !== "settled") {
        row.transaction_state = "failed";
        row.workflow_state = "failed_closed";
      }
      return { rows: [structuredClone(row)] };
    }

    if (sql.includes("THEN 'expiry_pending_verification'")) {
      const row = this.requireRow(values[0]);
      if (!["settled", "expired", "failed"].includes(row.transaction_state)) {
        row.workflow_state = "expiry_pending_verification";
      }
      return { rows: [structuredClone(row)] };
    }

    if (sql.includes("THEN 'verifying'")) {
      const row = this.requireRow(values[0]);
      if (
        row.transaction_state !== "settled" &&
        ["invoice_created", "expiry_pending_verification"].includes(row.workflow_state)
      ) {
        row.workflow_state = "verifying";
      }
      return { rows: [structuredClone(row)] };
    }

    if (sql.includes("SET workflow_state = 'settlement_action_pending'")) {
      const row = this.requireRow(values[0]);
      row.workflow_state = "settlement_action_pending";
      return { rows: [structuredClone(row)] };
    }

    throw new Error(`Unhandled fake Postgres query: ${sql}`);
  }

  requireRow(invoiceId) {
    const row = this.rows.find((item) => item.invoice_id === invoiceId);
    if (row === undefined) return undefined;
    return row;
  }
}

function isRecoverableFakeRow(row) {
  if (
    [
      "settlement_action_completed",
      "expired_closed",
      "failed_closed",
      "cancelled"
    ].includes(row.workflow_state)
  ) {
    return false;
  }
  if (row.transaction_state === "settled") {
    return row.settlement_action_state !== "completed";
  }
  if (["expired", "failed"].includes(row.transaction_state)) return false;
  return true;
}

function invoiceRow(overrides = {}) {
  return {
    invoice_id: "or_inv_node_pg",
    merchant_scope: "node:test",
    operation: "invoice.create",
    idempotency_key: "order-pg",
    idempotency_request_hash: `sha256:${"b".repeat(64)}`,
    payment_hash: "9".repeat(64),
    invoice: "lnbc-node-pg",
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
