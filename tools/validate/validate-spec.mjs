#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";
import { root } from "../shared/root.mjs";
import { walkFiles } from "../shared/walk-files.mjs";

function readJson(relativePath) {
  try {
    return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
  } catch (error) {
    throw new Error(`${relativePath}: ${error.message}`);
  }
}

function readYaml(relativePath) {
  try {
    return parseYaml(readFileSync(path.join(root, relativePath), "utf8"));
  } catch (error) {
    throw new Error(`${relativePath}: ${error.message}`);
  }
}

function walk(dir, extension) {
  return walkFiles(path.join(root, dir), {
    filter: (entry) => entry.endsWith(extension),
  }).map((file) => path.relative(root, file));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseDecimal(value) {
  assert(/^[0-9]+(\.[0-9]+)?$/.test(value), `invalid decimal: ${value}`);
  const [whole, fraction = ""] = value.split(".");
  return { integer: BigInt(`${whole}${fraction}`), scale: 10n ** BigInt(fraction.length) };
}

function ceilDiv(numerator, denominator) {
  return (numerator + denominator - 1n) / denominator;
}

function validateJson() {
  for (const file of [
    ...walk("spec", ".json"),
    ...walk("examples", ".json"),
    "docs/manifest.json",
  ]) {
    readJson(file);
  }
}

function validateSchemas() {
  const required = [
    "checkout.schema.json",
    "payment-event.schema.json",
    "rate-quote.schema.json",
    "error.schema.json",
    "provider-registry.schema.json",
    "swap-order.schema.json",
    "swap-data.schema.json",
  ];
  for (const name of required) {
    assert(existsSync(path.join(root, "spec/schemas", name)), `missing schema ${name}`);
  }
  assert(
    !existsSync(path.join(root, "spec/schemas/invoice-storage.schema.json")),
    "storage schema must be deleted",
  );
  for (const file of walk("spec/schemas", ".json")) {
    const schema = readJson(file);
    assert(schema.$schema && schema.$id, `${file}: missing JSON Schema metadata`);
    assert(schema.type === "object", `${file}: root schema must be object`);
  }
  const checkout = readJson("spec/schemas/checkout.schema.json");
  assert(checkout.properties.amount_msats.minimum === 1000, "checkout minimum amount drifted");
  assert(
    checkout.properties.amount_msats.maximum === 9007199254740991,
    "checkout maximum amount drifted",
  );
  assert(checkout.required.includes("payment_hash"), "checkout must expose payment_hash");
  const event = readJson("spec/schemas/payment-event.schema.json");
  assert(
    JSON.stringify(event.required) === JSON.stringify(["paymentHash", "paidAt"]),
    "payment event must stay minimal",
  );
}

// The engines are exercised against these vectors by tests/crosslang.test.mjs
// (JS) and tools/conformance/ruby-crosslang.rb (Ruby), each calling the real
// production functions. What is checked here is the vectors' own integrity —
// a third re-implementation of the math would just be one more thing to drift.
function validateMoneyVectors() {
  const vector = readJson("spec/test-vectors/fiat-to-msats.usd.json");
  const boundaries = readJson("spec/test-vectors/amount-boundaries.json");
  assert(boundaries.amount_msats?.maximum === 9007199254740991, "safe msat boundary drifted");
  assert(vector.cases.length > 0, "fiat vectors must not be empty");

  const maximum = BigInt(boundaries.amount_msats.maximum);
  const minimum = BigInt(boundaries.amount_msats?.minimum ?? 1);
  for (const item of vector.cases) {
    assert(
      BigInt(item.expected.amount_msats) === BigInt(item.expected.amount_sats) * 1000n,
      `${item.name}: msats must be sats * 1000`,
    );
    assert(
      BigInt(item.expected.amount_msats) >= minimum &&
        BigInt(item.expected.amount_msats) <= maximum,
      `${item.name}: expected amount is outside the declared bounds`,
    );
  }

  // Each refusal case must actually be out of contract, so a vector cannot
  // quietly demand that the engines reject something legitimate.
  for (const item of vector.invalid_cases ?? []) {
    const value = item.fiat.value;
    if (item.reason === "not_a_positive_decimal") {
      assert(!/^[0-9]+(\.[0-9]+)?$/.test(value), `${item.name}: value is a positive decimal`);
      continue;
    }
    const fiat = parseDecimal(value);
    const price = parseDecimal(vector.btc_fiat_price);
    const msats =
      ceilDiv(fiat.integer * price.scale * 100_000_000n, price.integer * fiat.scale) * 1000n;
    if (item.reason === "below_minimum") {
      assert(msats < minimum, `${item.name}: ${msats} is not below the minimum`);
    } else if (item.reason === "above_maximum") {
      assert(msats > maximum, `${item.name}: ${msats} is not above the maximum`);
    } else {
      assert(false, `${item.name}: unknown reason ${item.reason}`);
    }
  }
}

function validateSettlementVectors() {
  const vector = readJson("spec/test-vectors/settlement-detection.json");
  const cases = vector.cases ?? [];
  assert(
    cases.some(
      (item) => item.transaction?.settled_at !== undefined && item.expected?.settled === true,
    ),
    "missing settled_at authority vector",
  );
  assert(
    cases.some((item) => item.transaction?.preimage && item.expected?.settled === false),
    "preimage-alone vector must remain unsettled",
  );
  assert(
    cases.some((item) => item.transaction?.settled_at === 0 && item.expected?.settled === false),
    "settled_at:0 must be pinned as unsettled, not left implementation-defined",
  );
  // Every case pins the 4-way classification, not just the boolean.
  for (const item of cases) {
    assert(
      vector.statuses.includes(item.expected?.status),
      `${item.name}: expected.status must be one of ${vector.statuses.join(", ")}`,
    );
    assert(
      (item.expected.status === "settled") === item.expected.settled,
      `${item.name}: settled must agree with status`,
    );
  }
}

function validateContracts() {
  const openapi = readYaml("spec/openapi/openreceive-http.v1.yaml");
  assert(openapi.openapi === "3.1.0", "OpenAPI version must be 3.1.0");
  assert(
    openapi.info?.version === "0.4.0",
    "host-owned payment-attempt HTTP contract version mismatch",
  );
  const expectedPaths = [
    "/checkouts/prepare",
    "/checkouts",
    "/payments/check",
    "/swaps/quote",
    "/swaps",
    "/swaps/status",
    "/swaps/refunds",
    "/rates",
  ];
  assert(
    JSON.stringify(Object.keys(openapi.paths)) === JSON.stringify(expectedPaths),
    "HTTP route set drifted",
  );
  const create = openapi.components.schemas.CreateCheckoutRequest;
  assert(create.required.includes("order_id"), "checkout create requires order_id");
  assert(
    create.properties.amount === undefined && create.properties.amount_msats === undefined,
    "payer create request must not contain amount",
  );
  assert(
    openapi.components.schemas.Checkout.required.includes("payment_hash"),
    "checkout response requires payment_hash",
  );
  assert(
    openapi.components.securitySchemes === undefined,
    "OpenReceive must not mint authentication capabilities",
  );
  assert(
    JSON.stringify(openapi.components.schemas.PaymentCheckRequest.required) ===
      JSON.stringify(["order_id", "payment_hash"]),
    "payment checks must select an exact host-owned attempt",
  );
  assert(
    openapi.components.schemas.CreateSwapResponse.properties.swap_data === undefined,
    "swap_data must not be public",
  );
  const serializedOpenapi = JSON.stringify(openapi);
  assert(
    !/swap_recovery_token|order_access_token|confirmation_token|refund-confirmations/.test(
      serializedOpenapi,
    ),
    "removed browser token contracts must stay removed",
  );

  const asyncapi = readYaml("spec/asyncapi/openreceive-events.v1.yaml");
  assert(asyncapi.asyncapi === "3.0.0", "AsyncAPI version must be 3.0.0");
  assert(asyncapi.info?.version === "0.2.0", "AsyncAPI event contract version mismatch");
  assert(
    asyncapi.components.messages.paymentSettled.name === "payment.settled",
    "payment event name drifted",
  );
  assert(
    JSON.stringify(asyncapi.components.schemas.PaidPayment.required) ===
      JSON.stringify(["paymentHash", "paidAt"]),
    "paid event shape drifted",
  );
}

function validateStorageFreeTree() {
  const forbidden = [
    "packages/js/core/src/storage",
    "packages/js/core/src/runner",
    "packages/js/core/src/storage/index.ts",
    "packages/js/node/migrations",
    "packages/js/node/src/sqlite-store.ts",
    "packages/js/node/src/postgres-store.ts",
    "packages/js/node/src/migrations/001_init.sql",
    "packages/js/node/src/tokens.ts",
    "packages/js/http/src/tokens.ts",
    "packages/ruby/openreceive-server/lib/openreceive/server/active_record_store.rb",
    "packages/ruby/openreceive-server/lib/openreceive/server/tokens.rb",
    "spec/test-vectors/storage-kv.json",
    "spec/test-vectors/managed-platform-storage.json",
  ];
  for (const relative of forbidden) {
    assert(
      !existsSync(path.join(root, relative)),
      `${relative} must not exist (OpenReceive ships no separate store)`,
    );
  }
  const manifests = [
    "package.json",
    ...walk("packages", "package.json"),
    ...walk("examples", "package.json"),
  ];
  for (const manifest of manifests) {
    const text = JSON.stringify(readJson(manifest));
    assert(
      !/"(?:pg|sqlite3|better-sqlite3|@types\/pg)"/.test(text),
      `${manifest}: OpenReceive must not depend on a database driver`,
    );
  }
  const envExample = readFileSync(path.join(root, ".env.example"), "utf8");
  const envNames = [...envExample.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]);
  assert(
    JSON.stringify(envNames) ===
      JSON.stringify(["NWC_URI", "LSC_URI_PRIMARY", "LSC_URI_BACKUP", "LOG_LEVEL"]),
    ".env.example must contain the three secret URI variables plus LOG_LEVEL",
  );
  assert(
    /^LOG_LEVEL=(DEBUG|INFO|WARN|ERROR)$/m.test(envExample),
    ".env.example LOG_LEVEL must be DEBUG|INFO|WARN|ERROR",
  );
  assert(
    !/[?&]secret=[0-9a-fA-F]{64}/.test(envExample),
    ".env.example must not contain real-looking secrets",
  );
  const nodeExports = readFileSync(path.join(root, "packages/js/node/src/index.ts"), "utf8");
  assert(
    !/InvoiceStore|Sqlite|Postgres|Migration|StatelessToken|TokenKey/.test(nodeExports),
    "Node public exports must not expose persistence or token infrastructure",
  );

  const httpExports = readFileSync(path.join(root, "packages/js/http/src/index.ts"), "utf8");
  assert(
    httpExports.includes("createOpenReceiveHost") &&
      httpExports.includes("createOpenReceiveSqlPayments") &&
      httpExports.includes("OpenReceivePaymentRepository") &&
      httpExports.includes("openReceivePaymentsSchemaSql"),
    "@openreceive/http must expose the host integration and the library-owned payments repository",
  );
  for (const relative of [
    "packages/ruby/openreceive-rails/app/models/open_receive_payment.rb",
    "packages/ruby/openreceive-rails/lib/generators/openreceive/install/templates/migration.rb",
  ]) {
    assert(
      existsSync(path.join(root, relative)),
      `${relative}: engine-owned payment model and migration template are required`,
    );
  }
  const migration = readFileSync(
    path.join(
      root,
      "packages/ruby/openreceive-rails/lib/generators/openreceive/install/templates/migration.rb",
    ),
    "utf8",
  );
  assert(
    /add_index :openreceive_payments, :payment_hash, unique: true/.test(migration) &&
      !/order_id[^\n]*unique: true/.test(migration),
    "Rails migration must allow many attempts per order and uniquely index payment_hash",
  );
}

// Docs restate the spec's route/error tables, and the curated headless symbol
// surface, only through generated blocks; fail when any block drifted.
function validateGeneratedDocTables() {
  for (const generator of [
    "tools/docs/generate-spec-tables.mjs",
    "tools/docs/generate-headless-surface.mjs",
  ]) {
    execFileSync(process.execPath, [path.join(root, generator), "--check"], {
      cwd: root,
      stdio: ["ignore", "ignore", "inherit"],
    });
  }
}

/**
 * Executes the JSON Schemas against the data that actually ships, so a schema
 * and its instances cannot drift apart while both look fine in isolation.
 * Schemas are compiled first: an unusable schema is itself a failure.
 */
function validateSchemaInstances() {
  // The schemas declare draft 2020-12, so the matching Ajv build is required.
  const ajv = new Ajv2020({ allErrors: true, strict: false });

  // Memoized: Ajv registers each schema by its $id and rejects a second
  // compile of the same one.
  const compiled = new Map();
  const compile = (relativePath) => {
    const cached = compiled.get(relativePath);
    if (cached !== undefined) return cached;
    const schema = readJson(relativePath);
    try {
      const validate = ajv.compile(schema);
      compiled.set(relativePath, validate);
      return validate;
    } catch (error) {
      throw new Error(`${relativePath}: schema does not compile: ${error.message}`);
    }
  };

  const check = (validate, instance, label) => {
    if (validate(instance)) return;
    const detail = (validate.errors ?? [])
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    assert(false, `${label} violates its schema: ${detail}`);
  };

  // Shipped provider registry: every provider, plus the document itself.
  const registrySchema = compile("spec/schemas/provider-registry.schema.json");
  const registryPath = "packages/js/provider-data/src/data/openreceive-providers.v4.json";
  check(registrySchema, readJson(registryPath), registryPath);

  // Golden HTTP bodies: the error envelope every non-2xx response must match.
  const errorSchema = compile("spec/schemas/error.schema.json");
  for (const file of walk("spec/test-vectors/http-golden", ".json")) {
    const vector = readJson(file);
    const status = vector.expected?.status;
    const body = vector.expected?.body;
    if (typeof status !== "number" || status < 400 || body === undefined) continue;
    check(errorSchema, body, `${file} expected.body`);
  }

  // The remaining schemas must at least compile; instances are asserted where
  // the repository ships one.
  for (const file of walk("spec/schemas", ".json")) compile(file);
}

validateJson();
validateSchemas();
validateSchemaInstances();
validateMoneyVectors();
validateSettlementVectors();
validateContracts();
validateStorageFreeTree();
validateGeneratedDocTables();
console.log("OpenReceive host-owned payment contracts and vectors: ok");
