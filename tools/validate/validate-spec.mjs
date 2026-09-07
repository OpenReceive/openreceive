#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";
import { root } from "../shared/root.mjs";
import { walkFiles } from "../shared/walk-files.mjs";
import { checkVectorCoverage } from "./vector-coverage.mjs";

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
    openapi.info?.version === "0.4.1",
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
  assert(create.required.includes("reference"), "checkout create requires reference");
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
      JSON.stringify(["reference", "payment_hash"]),
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
  // One payload, two spellings: the JS engine emits camelCase and the Ruby
  // engine snake_case, so the schema is a oneOf over both branches. Pin the
  // FIELDS on each branch — that is the contract; the casing follows the host
  // language.
  assert(
    JSON.stringify(
      asyncapi.components.schemas.PaidPayment.oneOf?.map((branch) => branch.required),
    ) ===
      JSON.stringify([
        ["paymentHash", "paidAt"],
        ["payment_hash", "paid_at"],
      ]),
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
  const driverPattern = /"(?:pg|sqlite3|better-sqlite3|@types\/pg)"/;
  const manifests = [...walk("packages", "package.json"), ...walk("examples", "package.json")];
  for (const manifest of manifests) {
    const text = JSON.stringify(readJson(manifest));
    assert(
      !driverPattern.test(text),
      `${manifest}: OpenReceive must not depend on a database driver`,
    );
  }
  // The root workspace manifest is checked on its runtime dependencies only:
  // the test:orms lane carries real ORMs and their sqlite driver as
  // devDependencies precisely to test against them, and nothing dev-only
  // ships. Package and example manifests above stay strict in full.
  const rootManifest = readJson("package.json");
  assert(
    !driverPattern.test(JSON.stringify(rootManifest.dependencies ?? {})),
    "package.json: OpenReceive must not depend on a database driver at runtime",
  );
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
    httpExports.includes("createHost") &&
      httpExports.includes("createSqlPayments") &&
      httpExports.includes("PaymentRepository") &&
      httpExports.includes("paymentsSchemaSql"),
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
      !/reference[^\n]*unique: true/.test(migration),
    "Rails migration must allow many attempts per reference and uniquely index payment_hash",
  );
}

// spec/data/kernel-tables.json is the one hand-edited copy of the vocabularies
// every engine shares. The OpenAPI document and the JSON Schemas restate some of
// them as enums; the vectors restate two numbers. All of those must agree.
function validateKernelTables() {
  const tables = readJson("spec/data/kernel-tables.json");
  const openapi = readYaml("spec/openapi/openreceive-http.v1.yaml");
  const schemas = openapi.components.schemas;
  const swapOrder = readJson("spec/schemas/swap-order.schema.json");
  const same = (left, right, label) =>
    assert(JSON.stringify(left) === JSON.stringify(right), `${label} drifted from kernel-tables`);

  const assets = tables.swap.pay_in_assets.map((asset) => asset.pay_in_asset);
  const states = tables.swap.states.map((state) => state.state);
  const attentionReasons = tables.swap.attention_reasons.map((row) => row.reason);
  same(schemas.SwapPayInAsset.enum, assets, "OpenAPI SwapPayInAsset");
  same(schemas.SwapProviderState.enum, states, "OpenAPI SwapProviderState");
  same(swapOrder.properties.pay_in_asset.enum, assets, "swap-order.schema pay_in_asset");
  same(swapOrder.properties.provider_state.enum, states, "swap-order.schema provider_state");
  same(
    swapOrder.properties.attention_reason.enum,
    attentionReasons,
    "swap-order.schema attention_reason",
  );
  same(
    swapOrder.properties.refund_reason.enum,
    tables.swap.refund_reasons,
    "swap-order.schema refund_reason",
  );
  assert(new Set(assets).size === assets.length, "pay_in_assets must be unique");
  assert(new Set(states).size === states.length, "swap states must be unique");
  for (const asset of tables.swap.pay_in_assets) {
    assert(
      asset.pay_in_asset === `${asset.coin}_${asset.pay_in_asset.split("_")[1]}`,
      `${asset.pay_in_asset}: pay_in_asset must be COIN_NETWORK`,
    );
  }
  const completed = tables.swap.states.find((state) => state.state === "completed");
  assert(
    completed?.terminal === false,
    "completed must stay non-terminal (provider completion is not settlement)",
  );

  const retryable = tables.errors.retryable_codes;
  const errorCodes = readJson("spec/schemas/error.schema.json").properties.code.enum;
  for (const code of retryable) {
    assert(errorCodes.includes(code), `retryable code ${code} is not an error code`);
  }

  const reconciliation = readJson("spec/test-vectors/attempt-reconciliation.json");
  assert(
    reconciliation.expiry_grace_seconds === tables.attempts.expiry_grace_seconds,
    "attempt-reconciliation expiry_grace_seconds drifted from kernel-tables",
  );
  const scan = readJson("spec/test-vectors/wallet-scan-truncation.json");
  assert(
    scan.page_limit === tables.nwc.transaction_page_limit,
    "wallet-scan-truncation page_limit drifted from kernel-tables",
  );

  // swap-state: emitted attention reasons ⊆ the table, and every non-reserved
  // reason in the table is produced by at least one case.
  const swapState = readJson("spec/test-vectors/swap-state.json");
  const emitted = new Set();
  for (const item of swapState.cases) {
    assert(
      states.includes(item.expected.state),
      `${item.name}: unknown state ${item.expected.state}`,
    );
    if (item.expected.attention_reason !== undefined) {
      assert(
        item.expected.state === "attention",
        `${item.name}: attention_reason on a non-attention state`,
      );
      assert(
        item.expected.attention === true,
        `${item.name}: attention state must carry attention: true`,
      );
      assert(
        attentionReasons.includes(item.expected.attention_reason),
        `${item.name}: attention_reason ${item.expected.attention_reason} is not in kernel-tables`,
      );
      emitted.add(item.expected.attention_reason);
    }
    if (item.expected.refund_reason !== undefined) {
      assert(
        tables.swap.refund_reasons.includes(item.expected.refund_reason),
        `${item.name}: refund_reason ${item.expected.refund_reason} is not in kernel-tables`,
      );
    }
  }
  for (const row of tables.swap.attention_reasons) {
    if (row.reserved === true) continue;
    assert(
      emitted.has(row.reason),
      `attention reason ${row.reason} has no swap-state vector producing it`,
    );
  }
}

// spec/data/swap-state-table.json is the one hand-edited copy of the FixedFloat
// status → state/reason mapping; every engine's normalizer interprets its
// rendering. Checked here: row shape, vocabularies ⊆ kernel-tables, a
// catch-all last row, and — through a reference interpreter of the DATA — that
// the table still reproduces every swap-state vector case. The engines'
// production interpreters are what the vector tests exercise; this one only
// stops a table edit from reaching them broken.
function validateSwapStateTable() {
  const table = readJson("spec/data/swap-state-table.json");
  const kernel = readJson("spec/data/kernel-tables.json");
  const states = kernel.swap.states.map((state) => state.state);
  const attentionReasons = kernel.swap.attention_reasons.map((row) => row.reason);
  const refundReasons = kernel.swap.refund_reasons;
  const upper = (value) => typeof value === "string" && value === value.toUpperCase();
  assert(table.provider === "fixedfloat", "swap-state-table provider drifted");
  assert(Array.isArray(table.how_to_read) && table.how_to_read.length > 0, "how_to_read required");

  const rows = table.status_rows;
  assert(Array.isArray(rows) && rows.length > 0, "status_rows required");
  const ROW_KEYS = new Set([
    "status",
    "status_contains",
    "refund_tx_present",
    "choice",
    "state",
    "attention_reason",
    "refund_reason_from_emergency",
    "note",
  ]);
  rows.forEach((row, index) => {
    const label = `status_rows[${index}]`;
    for (const key of Object.keys(row)) assert(ROW_KEYS.has(key), `${label}: unknown key ${key}`);
    assert(upper(row.status), `${label}: status must be an upper-cased string or "*"`);
    if (row.status_contains !== undefined) {
      assert(row.status === "*", `${label}: status_contains requires status "*"`);
      assert(upper(row.status_contains), `${label}: status_contains must be upper-cased`);
    }
    assert(
      [true, false, "any"].includes(row.refund_tx_present),
      `${label}: refund_tx_present must be true, false or "any"`,
    );
    assert(
      ["REFUND", "EXCHANGE", "NONE", "absent", "any"].includes(row.choice),
      `${label}: choice must be REFUND, EXCHANGE, NONE, "absent" or "any"`,
    );
    assert(states.includes(row.state), `${label}: unknown state ${row.state}`);
    if (row.attention_reason !== undefined) {
      assert(row.state === "attention", `${label}: attention_reason on a non-attention state`);
      assert(
        attentionReasons.includes(row.attention_reason),
        `${label}: attention_reason ${row.attention_reason} is not in kernel-tables`,
      );
    } else {
      assert(row.state !== "attention", `${label}: attention state needs an attention_reason`);
    }
    if (row.refund_reason_from_emergency !== undefined) {
      assert(
        row.refund_reason_from_emergency === true,
        `${label}: refund_reason_from_emergency is true or absent`,
      );
      assert(row.status === "EMERGENCY", `${label}: only EMERGENCY rows derive a refund reason`);
    }
  });
  const last = rows[rows.length - 1];
  assert(
    last.status === "*" &&
      last.status_contains === undefined &&
      last.refund_tx_present === "any" &&
      last.choice === "any",
    'the last status row must be a catch-all (status "*", refund_tx_present any, choice any)',
  );

  const aliases = table.emergency_status_aliases;
  assert(aliases !== null && typeof aliases === "object", "emergency_status_aliases required");
  for (const [from, to] of Object.entries(aliases)) {
    assert(upper(from) && upper(to), `alias ${from} → ${to} must be upper-cased`);
    assert(!(to in aliases), `alias target ${to} must be canonical, not itself an alias`);
  }
  const reasonRows = table.refund_reason_rows;
  assert(Array.isArray(reasonRows) && reasonRows.length > 0, "refund_reason_rows required");
  reasonRows.forEach((row, index) => {
    const label = `refund_reason_rows[${index}]`;
    assert(
      Array.isArray(row.all_of) && row.all_of.length > 0 && row.all_of.every(upper),
      `${label}: all_of must be a non-empty list of upper-cased statuses`,
    );
    for (const status of row.all_of) {
      assert(!(status in aliases), `${label}: ${status} is an alias; name its canonical form`);
    }
    assert(
      refundReasons.includes(row.refund_reason),
      `${label}: refund_reason ${row.refund_reason} is not in kernel-tables`,
    );
  });
  for (const reason of refundReasons) {
    assert(
      reasonRows.some((row) => row.refund_reason === reason),
      `refund reason ${reason} has no refund_reason_rows entry producing it`,
    );
  }

  // Reference interpreter over the data, run against the shared vector.
  const refundReasonFor = (statuses) => {
    const present = new Set(statuses.map((s) => s.toUpperCase()).map((s) => aliases[s] ?? s));
    return reasonRows.find((row) => row.all_of.every((s) => present.has(s)))?.refund_reason;
  };
  const matchIndex = (status, emergency, refundTxPresent) => {
    const normalized = status.toUpperCase();
    const choice =
      typeof emergency?.choice === "string" ? emergency.choice.toUpperCase() : undefined;
    return rows.findIndex(
      (candidate) =>
        (candidate.status === "*"
          ? candidate.status_contains === undefined ||
            normalized.includes(candidate.status_contains)
          : candidate.status === normalized) &&
        (candidate.refund_tx_present === "any" ||
          candidate.refund_tx_present === refundTxPresent) &&
        (candidate.choice === "any" ||
          (choice === undefined ? candidate.choice === "absent" : candidate.choice === choice)),
    );
  };
  const interpret = (row, emergency) => {
    const result = { state: row.state };
    if (row.attention_reason !== undefined) {
      result.attention = true;
      result.attention_reason = row.attention_reason;
    }
    if (row.refund_reason_from_emergency === true) {
      const raw = emergency?.status;
      const reason = refundReasonFor(Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]);
      if (reason !== undefined) result.refund_reason = reason;
    }
    return result;
  };
  const vector = readJson("spec/test-vectors/swap-state.json");
  const hit = new Set();
  for (const item of vector.cases) {
    const index = matchIndex(item.status, item.emergency, item.refund_tx_present);
    hit.add(index);
    const actual = interpret(rows[index], item.emergency);
    assert(
      JSON.stringify(actual) === JSON.stringify(item.expected),
      `swap-state-table does not reproduce vector case "${item.name}": ` +
        `expected ${JSON.stringify(item.expected)}, table gives ${JSON.stringify(actual)}`,
    );
  }
  // Every row must be reachable: a row no vector case hits is either dead or unpinned.
  rows.forEach((row, index) => {
    assert(
      hit.has(index),
      `status_rows[${index}] (${row.status} → ${row.state}) is hit by no swap-state vector case; add one or delete the row`,
    );
  });
}

// Every vector family must have a consumer in every engine, or a written
// exclusion (spec/test-vectors/coverage.json).
function validateVectorCoverage() {
  const { failures, report } = checkVectorCoverage();
  for (const line of report) console.log(`vector coverage: ${line}`);
  assert(failures.length === 0, failures.join("\n"));
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
validateKernelTables();
validateSwapStateTable();
validateVectorCoverage();
validateStorageFreeTree();
validateGeneratedDocTables();
console.log("OpenReceive host-owned payment contracts and vectors: ok");
