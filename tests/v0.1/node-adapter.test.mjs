import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  InMemoryInvoiceKvStore,
  StaticPriceProvider
} from "../../packages/js/core/src/index.ts";
import {
  OpenReceiveError,
  ReceiveCheckoutValidationError,
  OPENRECEIVE_DATABASE_SCHEMA_VERSION,
  OPENRECEIVE_POSTGRES_MIGRATION_SQL,
  OPENRECEIVE_SQLITE_MIGRATION_SQL,
  createNwcReceiveClient,
  createOpenReceive,
  createOpenReceiveSqliteKvStore,
  createOpenReceiveSqliteQueryClient,
  migrateOpenReceiveSqlite,
  normalizeNwcWalletError,
  OpenReceiveConfigError,
  resolveOpenReceiveStore,
  summarizeWalletCapabilities
} from "../../packages/js/node/src/index.ts";
import { runOpenReceiveCli } from "../../packages/js/node/src/cli.ts";
import {
  assertOpenReceiveStoreConfiguration
} from "../../packages/js/node/src/storage-guard.ts";

const BuiltInSqliteDatabaseSync = await loadBuiltInSqliteDatabaseSync();

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

async function loadBuiltInSqliteDatabaseSync() {
  try {
    const sqlite = await import(`node:${"sqlite"}`);
    return sqlite.DatabaseSync;
  } catch {
    return undefined;
  }
}

function sqliteTest(name, fn) {
  test(
    name,
    {
      skip: BuiltInSqliteDatabaseSync === undefined
        ? "built-in SQLite is unavailable in this Node runtime"
        : false
    },
    async () => fn(BuiltInSqliteDatabaseSync)
  );
}

class FakeAlbyClient {
  makeInvoiceParams = [];
  listTransactionsParams = [];
  nextResponse = undefined;
  info = {
    capabilities: ["get_info", "make_invoice", "list_transactions"],
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

  async listTransactions(params) {
    this.listTransactionsParams.push(params);
    if (this.nextResponse !== undefined) return this.nextResponse;
    return {
      transactions: [{
        type: "incoming",
        invoice: "lnbc-fake",
        payment_hash: "a".repeat(64),
        amount: 200000,
        state: "SETTLED",
        settled_at: 1200,
        preimage: "b".repeat(64)
      }]
    };
  }
}

test("preflight rejects spend-capable NWC codes", async () => {
  const fake = new FakeAlbyClient();
  fake.info.capabilities = ["get_info", "make_invoice", "list_transactions", "pay_invoice"];
  const client = createNwcReceiveClient({
    connectionString: NWC_URI,
    client: fake
  });

  await assert.rejects(
    () => client.preflight(),
    (error) => {
      assert.equal(error.name, "WalletPreflightError");
      assert.equal(error.code, "spend_capability_advertised");
      assert.equal(error.summary.spendCapabilityAdvertised, true);
      assert.match(error.summary.warnings[0], /pay_invoice/);
      return true;
    }
  );

  const summary = summarizeWalletCapabilities(client.connection, fake.info);
  assert.equal(summary.receiveCheckoutReady, true);
  assert.equal(summary.encryption, "nip44_v2");
  assert.equal(summary.spendCapabilityAdvertised, true);
  assert.match(summary.warnings[0], /pay_invoice/);
});

test("summarizes NWC info vectors for readiness and encryption", () => {
  const connection = createNwcReceiveClient({
    connectionString: NWC_URI,
    client: new FakeAlbyClient(),
    requirePreflight: false
  }).connection;

  for (const vector of NWC_INFO_VECTORS.cases) {
    const summary = summarizeWalletCapabilities(connection, vector.raw_info);
    assert.deepEqual(summary.methods, vector.expected.methods, vector.name);
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
    const client = createNwcReceiveClient({
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
    } else if (vector.method === "list_transactions") {
      const result = await client.listTransactions(request);
      assert.deepEqual(
        fake.listTransactionsParams[0],
        vector.expected_nip47_request,
        vector.name
      );
      assert.deepEqual(
        makeComparableResult(result),
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
    const client = createNwcReceiveClient({
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

  const client = createNwcReceiveClient({
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
  const client = createNwcReceiveClient({
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
  const client = createNwcReceiveClient({
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

sqliteTest("Node SQLite KV store owns records, indexes, revisions, and meta CAS", async (DatabaseSync) => {
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

    const meta = await store.casMeta("schema_probe", "one", null);
    assert.equal(meta.status, "ok");
    assert.equal((await store.casMeta("schema_probe", "two", meta.row.rev)).status, "ok");
    assert.equal((await store.casMeta("schema_probe", "stale", meta.row.rev)).status, "conflict");
  } finally {
    database.close();
  }
});

sqliteTest("resolveOpenReceiveStore rejects memory URI and supports local-sqlite stores", async () => {
  await assertConfigError(
    () => resolveOpenReceiveStore("memory:"),
    "UNSUPPORTED_STORE_URI"
  );
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

test("resolveOpenReceiveStore rejects Redis as permanently unsupported", async () => {
  await assertConfigError(
    () => resolveOpenReceiveStore("redis://localhost:6379/0"),
    "UNSUPPORTED_STORE_REDIS"
  );
  await assertConfigError(
    () => resolveOpenReceiveStore("rediss://localhost:6379/0"),
    "UNSUPPORTED_STORE_REDIS"
  );
});

sqliteTest("resolveOpenReceiveStore defaults to local-sqlite when OPENRECEIVE_STORE is omitted", async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "openreceive-store-default-"));
  try {
    const store = await resolveOpenReceiveStore(undefined, {
      cwd: tempRoot,
      namespace: "defaulted"
    });
    try {
      assert.equal(existsSync(path.join(tempRoot, ".openreceive", "defaulted.sqlite3")), true);
    } finally {
      await store.close?.();
    }
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("managed platform storage guard rejects unsafe local SQLite before disk writes", async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "openreceive-platform-"));
  try {
    await withEnv({
      OPENRECEIVE_STORE: undefined,
      OPENRECEIVE_PLATFORM: undefined,
      VERCEL: "1",
      NODE_ENV: undefined
    }, async () => {
      await assertConfigError(
        () => resolveOpenReceiveStore(undefined, { cwd: tempRoot }),
        "EPHEMERAL_STORE_UNSAFE"
      );
      assert.equal(existsSync(path.join(tempRoot, ".openreceive")), false);
    });
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("managed platform storage guard follows canonical platform policies", () => {
  assertConfigErrorSync(
    () => assertOpenReceiveStoreConfiguration({
      storeUri: "sqlite:/data/x.sqlite3",
      env: { VERCEL: "1" }
    }),
    "EPHEMERAL_STORE_UNSAFE"
  );
  assertConfigErrorSync(
    () => assertOpenReceiveStoreConfiguration({
      storeUri: undefined,
      env: { DYNO: "web.1" }
    }),
    "EPHEMERAL_STORE_UNSAFE"
  );
  assert.doesNotThrow(() => assertOpenReceiveStoreConfiguration({
    storeUri: "sqlite:/data/x.sqlite3",
    env: { FLY_APP_NAME: "openreceive-demo" }
  }));
  assertConfigErrorSync(
    () => assertOpenReceiveStoreConfiguration({
      storeUri: "sqlite:relative.db",
      env: { FLY_APP_NAME: "openreceive-demo" }
    }),
    "EPHEMERAL_STORE_UNSAFE"
  );
  assertConfigErrorSync(
    () => assertOpenReceiveStoreConfiguration({
      storeUri: undefined,
      env: { FLY_APP_NAME: "openreceive-demo" }
    }),
    "EPHEMERAL_STORE_UNSAFE"
  );
  assertConfigErrorSync(
    () => assertOpenReceiveStoreConfiguration({
      storeUri: "sqlite:/x.sqlite3",
      env: { OPENRECEIVE_PLATFORM: "heroku" }
    }),
    "EPHEMERAL_STORE_UNSAFE"
  );
  assert.doesNotThrow(() => assertOpenReceiveStoreConfiguration({
    storeUri: "sqlite:/app/storage/x.sqlite3",
    env: { OPENRECEIVE_PLATFORM: "coolify" }
  }));
  assert.doesNotThrow(() => assertOpenReceiveStoreConfiguration({
    storeUri: undefined,
    env: { OPENRECEIVE_PLATFORM: "vps" }
  }));
});

test("createOpenReceive builds service methods from a client and store", async () => {
  const store = new InMemoryInvoiceKvStore();
  const client = {
    async preflight() {
      return {
        receiveCheckoutReady: true,
        methods: ["make_invoice", "list_transactions"],
        encryption: "nip44_v2",
        warnings: []
      };
    },
    async makeInvoice(request) {
      return {
        invoice: "lnbc-create-openreceive",
        payment_hash: "9".repeat(64),
        amount_msats: BigInt(request.amount_msats),
        created_at: 1000,
        expires_at: 1600
      };
    },
    async listTransactions() {
      return { transactions: [] };
    }
  };
  const openreceive = await createOpenReceive({
    client,
    store,
    namespace: "node_test",
    clock: () => 1000,
    priceProviders: [new StaticPriceProvider()]
  });

  const body = await openreceive.createCheckout({
    orderId: "create-openreceive-order",
    amount: { msats: 200000 },
    memo: "Factory invoice"
  });

  assert.equal(body.active.bolt11, "lnbc-create-openreceive");
  assert.equal(typeof openreceive.getOrder, "function");
});

sqliteTest("Node CLI keeps init removed while migrate and doctor remain", async () => {
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
    assert.equal(initCode, 1);
    assert.match(stderr.join(""), /Unknown OpenReceive command: init/);

    stdout.length = 0;
    stderr.length = 0;
    const doctorCode = await runOpenReceiveCli({
      argv: ["doctor"],
      cwd: tempRoot,
      stdout: io(stdout),
      stderr: io(stderr)
    });
    assert.equal(doctorCode, 1);
    assert.match(stdout.join(""), /OpenReceive doctor/);
    assert.match(stdout.join(""), /nwc: missing/);
    assert.doesNotMatch(stdout.join(""), /nostr\+walletconnect:\/\//);
    assert.equal(stderr.join(""), "");

    stdout.length = 0;
    stderr.length = 0;
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
    assert.match(stderr.join(""), /Unknown OpenReceive command: worker/);

    stderr.length = 0;
    const pollCode = await runOpenReceiveCli({
      argv: ["poll", "--once"],
      cwd: tempRoot,
      stdout: io(stdout),
      stderr: io(stderr)
    });
    assert.equal(pollCode, 1);
    assert.match(stderr.join(""), /Unknown OpenReceive command: poll/);
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
});

function invoiceRecord(overrides = {}) {
  return {
    rev: 0,
    row: {
      invoice_id: "or_inv_node_sqlite",
      namespace: "node:test",
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
        order_uuid: "order-sqlite",
        checkout_id: "checkout-sqlite",
        user_id: "user-1"
      },
      fiat_quote: null,
      ...overrides
    }
  };
}

async function assertConfigError(action, code) {
  await assert.rejects(
    action,
    (error) => {
      assert.equal(error instanceof OpenReceiveConfigError, true);
      assert.equal(error.code, code);
      return true;
    }
  );
}

function assertConfigErrorSync(action, code) {
  assert.throws(
    action,
    (error) => {
      assert.equal(error instanceof OpenReceiveConfigError, true);
      assert.equal(error.code, code);
      return true;
    }
  );
}

async function withEnv(updates, callback) {
  const original = new Map(
    Object.keys(updates).map((key) => [key, process.env[key]])
  );
  try {
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    return await callback();
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
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
  if (typeof result === "bigint") return Number(result);
  if (Array.isArray(result)) return result.map(makeComparableResult);
  if (typeof result !== "object" || result === null) return result;
  return Object.fromEntries(
    Object.entries(result).map(([key, value]) => [
      key,
      makeComparableResult(value)
    ])
  );
}
