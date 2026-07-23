#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

const root = process.cwd();

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
  const absolute = path.join(root, dir);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute).flatMap((entry) => {
    const relative = path.join(dir, entry);
    const stat = statSync(path.join(root, relative));
    return stat.isDirectory() ? walk(relative, extension) : entry.endsWith(extension) ? [relative] : [];
  });
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
  for (const file of [...walk("spec", ".json"), ...walk("examples", ".json"), "docs/manifest.json"]) {
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
  assert(!existsSync(path.join(root, "spec/schemas/invoice-storage.schema.json")), "storage schema must be deleted");
  for (const file of walk("spec/schemas", ".json")) {
    const schema = readJson(file);
    assert(schema.$schema && schema.$id, `${file}: missing JSON Schema metadata`);
    assert(schema.type === "object", `${file}: root schema must be object`);
  }
  const checkout = readJson("spec/schemas/checkout.schema.json");
  assert(checkout.properties.amount_msats.minimum === 1000, "checkout minimum amount drifted");
  assert(checkout.properties.amount_msats.maximum === 9007199254740991, "checkout maximum amount drifted");
  assert(checkout.required.includes("payment_hash"), "checkout must expose payment_hash");
  const event = readJson("spec/schemas/payment-event.schema.json");
  assert(JSON.stringify(event.required) === JSON.stringify(["paymentHash", "paidAt"]), "payment event must stay minimal");
}

function validateMoneyVectors() {
  const vector = readJson("spec/test-vectors/fiat-to-msats.usd.json");
  for (const item of vector.cases) {
    const fiat = parseDecimal(item.fiat.value);
    const price = parseDecimal(vector.btc_fiat_price);
    const sats = ceilDiv(fiat.integer * price.scale * 100_000_000n, price.integer * fiat.scale);
    assert(sats === BigInt(item.expected.amount_sats), `${item.name}: sats mismatch`);
    assert(sats * 1000n === BigInt(item.expected.amount_msats), `${item.name}: msats mismatch`);
  }
  const boundaries = readJson("spec/test-vectors/amount-boundaries.json");
  assert(boundaries.amount_msats?.maximum === 9007199254740991, "safe msat boundary drifted");
}

function validateSettlementVectors() {
  const vector = readJson("spec/test-vectors/settlement-detection.json");
  const cases = vector.cases ?? [];
  assert(cases.some((item) => item.transaction?.settled_at !== undefined && item.expected?.settled === true), "missing settled_at authority vector");
  assert(cases.some((item) => item.transaction?.preimage && item.expected?.settled === false), "preimage-alone vector must remain unsettled");
  const pagination = readJson("spec/test-vectors/transaction-scan-pagination.json");
  const serialized = JSON.stringify(pagination);
  assert(serialized.includes("20"), "transaction scan vectors must cover NIP-47 page size 20");
}

function validateContracts() {
  const openapi = readYaml("spec/openapi/openreceive-http.v1.yaml");
  assert(openapi.openapi === "3.1.0", "OpenAPI version must be 3.1.0");
  assert(openapi.info?.version === "0.3.0", "host-owned swap-data HTTP contract version mismatch");
  const expectedPaths = [
    "/checkouts",
    "/payments/check",
    "/swaps/quote",
    "/swaps",
    "/swaps/status",
    "/swaps/refunds",
    "/rates",
  ];
  assert(JSON.stringify(Object.keys(openapi.paths)) === JSON.stringify(expectedPaths), "HTTP route set drifted");
  const create = openapi.components.schemas.CreateCheckoutRequest;
  assert(create.required.includes("order_id"), "checkout create requires order_id");
  assert(create.properties.amount === undefined && create.properties.amount_msats === undefined, "payer create request must not contain amount");
  assert(openapi.components.schemas.Checkout.required.includes("payment_hash"), "checkout response requires payment_hash");
  assert(openapi.components.securitySchemes === undefined, "OpenReceive must not mint authentication capabilities");
  assert(openapi.components.schemas.PaymentCheckRequest.required.includes("order_id"), "payment checks resolve host orders");
  assert(openapi.components.schemas.CreateSwapResponse.properties.swap_data === undefined, "swap_data must not be public");
  const serializedOpenapi = JSON.stringify(openapi);
  assert(!/swap_recovery_token|order_access_token|confirmation_token|refund-confirmations/.test(serializedOpenapi), "removed browser token contracts must stay removed");

  const asyncapi = readYaml("spec/asyncapi/openreceive-events.v1.yaml");
  assert(asyncapi.asyncapi === "3.0.0", "AsyncAPI version must be 3.0.0");
  assert(asyncapi.info?.version === "0.2.0", "storage-free event contract version mismatch");
  assert(asyncapi.components.messages.paymentSettled.name === "payment.settled", "payment event name drifted");
  assert(JSON.stringify(asyncapi.components.schemas.PaidPayment.required) === JSON.stringify(["paymentHash", "paidAt"]), "paid event shape drifted");
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
    assert(!existsSync(path.join(root, relative)), `${relative} must not exist in the storage-free design`);
  }
  const manifests = ["package.json", ...walk("packages", "package.json"), ...walk("examples", "package.json")];
  for (const manifest of manifests) {
    const text = JSON.stringify(readJson(manifest));
    assert(!/"(?:pg|sqlite3|better-sqlite3|@types\/pg)"/.test(text), `${manifest}: OpenReceive must not depend on a database driver`);
  }
  const config = readYaml("openreceive.yml.example");
  assert(config.store === undefined && config.storage === undefined && config.namespace === undefined, "openreceive.yml.example must not expose storage configuration");
  const nodeExports = readFileSync(path.join(root, "packages/js/node/src/index.ts"), "utf8");
  assert(!/InvoiceStore|Sqlite|Postgres|Migration|StatelessToken|TokenKey/.test(nodeExports), "Node public exports must not expose persistence or token infrastructure");
}

validateJson();
validateSchemas();
validateMoneyVectors();
validateSettlementVectors();
validateContracts();
validateStorageFreeTree();
console.log("OpenReceive storage-free contracts and vectors: ok");
