#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

const root = process.cwd();

function readJson(relativePath) {
  const filePath = path.join(root, relativePath);
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${relativePath}: ${error.message}`);
  }
}

function readYaml(relativePath) {
  const filePath = path.join(root, relativePath);
  try {
    return parseYaml(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${relativePath}: ${error.message}`);
  }
}

function walkJson(dir) {
  const files = [];
  for (const entry of readdirSync(path.join(root, dir))) {
    const full = path.join(root, dir, entry);
    const rel = path.relative(root, full);
    const stat = statSync(full);
    if (stat.isDirectory()) files.push(...walkJson(rel));
    if (stat.isFile() && entry.endsWith(".json")) files.push(rel);
  }
  return files;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseDecimal(value) {
  assert(/^[0-9]+(\.[0-9]+)?$/.test(value), `invalid decimal: ${value}`);
  const [whole, fraction = ""] = value.split(".");
  return {
    integer: BigInt(`${whole}${fraction}`),
    scale: BigInt(10) ** BigInt(fraction.length)
  };
}

function ceilDiv(numerator, denominator) {
  return (numerator + denominator - BigInt(1)) / denominator;
}

function quoteFiatToSats(fiatValue, btcFiatPrice) {
  const fiat = parseDecimal(fiatValue);
  const price = parseDecimal(btcFiatPrice);
  const numerator = fiat.integer * price.scale * BigInt(100_000_000);
  const denominator = price.integer * fiat.scale;
  return ceilDiv(numerator, denominator);
}

function validateJsonParsing() {
  for (const file of [...walkJson("spec"), ...walkJson("examples"), "docs/manifest.json"]) {
    readJson(file);
  }
}

function validateSchemas() {
  const schemaFiles = walkJson("spec/schemas");
  const required = new Set([
    "spec/schemas/invoice.schema.json",
    "spec/schemas/invoice-storage.schema.json",
    "spec/schemas/payment-event.schema.json",
    "spec/schemas/rate-quote.schema.json",
    "spec/schemas/error.schema.json",
    "spec/schemas/provider-registry.schema.json"
  ]);

  for (const file of required) {
    assert(schemaFiles.includes(file), `missing schema ${file}`);
  }

  for (const file of schemaFiles) {
    const schema = readJson(file);
    assert(schema.$schema, `${file}: missing $schema`);
    assert(schema.$id, `${file}: missing $id`);
    assert(schema.type === "object", `${file}: root schema must be object`);
    assert(schema.additionalProperties === false, `${file}: root must be strict`);
  }

  const invoice = readJson("spec/schemas/invoice.schema.json");
  assert(invoice.properties.amount_msats.minimum === 1000, "invoice amount_msats minimum must be 1000");
  assert(invoice.properties.amount_msats.maximum === 9007199254740991, "invoice amount_msats maximum mismatch");

  const quote = readJson("spec/schemas/rate-quote.schema.json");
  assert(quote.properties.amount_sats.maximum === 9007199254740, "amount_sats maximum mismatch");
}

function validateFiatVectors() {
  const vector = readJson("spec/test-vectors/fiat-to-msats.usd.json");
  for (const item of vector.cases) {
    const sats = quoteFiatToSats(item.fiat.value, vector.btc_fiat_price);
    const msats = sats * BigInt(1000);
    assert(sats === BigInt(item.expected.amount_sats), `${item.name}: amount_sats mismatch`);
    assert(msats === BigInt(item.expected.amount_msats), `${item.name}: amount_msats mismatch`);
    assert(msats >= BigInt(1000), `${item.name}: amount_msats below minimum`);
  }
}

function validateAmountBoundaries() {
  const boundaries = readJson("spec/test-vectors/amount-boundaries.json");
  assert(boundaries.amount_msats.minimum === 1000, "boundary minimum mismatch");
  assert(boundaries.amount_msats.maximum === 9007199254740991, "boundary maximum mismatch");

  for (const item of boundaries.cases) {
    const valid = item.amount_msats >= boundaries.amount_msats.minimum && item.amount_msats <= boundaries.amount_msats.maximum;
    assert(valid === item.valid, `${item.name}: validity mismatch`);
  }
}

function isSettled(result) {
  return result.settled_at !== undefined || result.state === "settled" || result.transaction_state === "settled";
}

function validateSettlementVectors() {
  const vector = readJson("spec/test-vectors/settlement-detection.json");
  for (const item of vector.cases) {
    assert(isSettled(item.lookup_invoice) === item.expected.settled, `${item.name}: settlement mismatch`);
  }
}

function validateLifecycleVectors() {
  const vector = readJson("spec/test-vectors/invoice-lifecycle.json");
  const transactionStates = new Set(vector.transaction_states);
  const workflowStates = new Set(vector.workflow_states);
  for (const state of workflowStates) {
    assert(!transactionStates.has(state), `workflow state overlaps transaction state: ${state}`);
  }
  for (const [from, to] of vector.allowed_transitions) {
    assert(workflowStates.has(from), `unknown workflow state: ${from}`);
    assert(workflowStates.has(to), `unknown workflow state: ${to}`);
  }
}

function validatePollingVectors() {
  const vector = readJson("spec/test-vectors/polling.backoff.json");
  let previousMax = -1;
  for (const band of vector.cadence) {
    assert(band.elapsed_seconds_min === previousMax + 1, "polling cadence has a gap");
    assert(band.elapsed_seconds_max >= band.elapsed_seconds_min, "polling cadence band is invalid");
    assert(band.delay_seconds > 0, "polling delay must be positive");
    previousMax = band.elapsed_seconds_max;
  }
  assert(vector.required_behaviors.includes("perform one final lookup at local expiry"), "missing final expiry lookup behavior");
}

function validateIdempotencyVectors() {
  const vector = readJson("spec/test-vectors/idempotency.json");
  assert(vector.canonical_scope.join("+") === "merchant_scope+operation+idempotency_key", "idempotency scope mismatch");
  for (const item of vector.cases) {
    const sameHash = item.first_request_hash === item.second_request_hash;
    assert((sameHash && item.expected.status === 200) || (!sameHash && item.expected.status === 409), `${item.name}: expected status mismatch`);
  }
}

function validateNwcVectors() {
  const vector = readJson("spec/test-vectors/nwc-uri-parse.json");
  for (const item of vector.cases) {
    if (item.expected_error) continue;
    assert(item.expected.secret_present === true, `${item.name}: expected secret_present`);
    assert(item.expected.redacted.includes("secret=[REDACTED]"), `${item.name}: redacted secret missing`);
    assert(!/[?&]secret=[0-9a-fA-F]{64}/.test(item.expected.redacted), `${item.name}: redacted output leaks secret`);
    assert(item.expected.relays.every((relay) => relay.startsWith("wss://")), `${item.name}: relay must be wss`);
  }
}

function validateProviderRegistryReferences() {
  const registry = readJson("spec/data/providers/openreceive-providers.v2.json");
  assert(registry.schema_version === "2.0.0", "provider registry schema version mismatch");
  assert(registry.generated === "2026-06-18", "provider registry generated date changed unexpectedly");
  assert(registry.assets_index.length === 18, "provider registry asset count mismatch");
  assert(Object.keys(registry.providers).length === 36, "provider registry provider count mismatch");
  assert(registry.crypto_routes.length === 15, "provider registry crypto route count mismatch");
  assert(Object.keys(registry.fiat_rails).length === 2, "provider registry fiat rail count mismatch");
  assert(registry.countries.length === 39, "provider registry country count mismatch");
  assert(registry.disqualified_providers.length === 7, "provider registry disqualified count mismatch");

  const providerIds = new Set(Object.keys(registry.providers || {}));
  const disqualifiedIds = new Set((registry.disqualified_providers || []).map((provider) => provider.id));
  const countryCodes = new Set((registry.countries || []).map((country) => country.code));
  const routeIds = new Set((registry.crypto_routes || []).map((route) => route.id));
  const assetRouteIds = new Set(
    (registry.assets_index || [])
      .map((asset) => asset.route)
      .filter((route) => route !== undefined)
  );

  for (const [id, provider] of Object.entries(registry.providers || {})) {
    assert(id === provider.id, `provider key/id mismatch for ${id}`);
    assert(/^[a-z0-9-]+$/.test(id), `provider ${id} has invalid id`);
    assert(provider.name && provider.url, `provider ${id} missing name or url`);
    assert(provider.url.startsWith("https://"), `provider ${id} url must be https`);
    assert(provider.pays_arbitrary_invoice === true, `provider ${id} must pay arbitrary invoice`);
    assert(["pay_invoice", "withdraw_to_invoice"].includes(provider.mechanism), `provider ${id} has invalid mechanism`);
    assert(!disqualifiedIds.has(id), `provider ${id} appears in disqualified providers`);

    const claimText = `${provider.blurb || ""} ${provider.caveat || ""}`.toLowerCase();
    if (provider.us === true) {
      assert(!claimText.includes("not available to us users"), `provider ${id} has contradictory US availability`);
      assert(!claimText.includes("us persons cannot"), `provider ${id} has contradictory US availability`);
      assert(!claimText.includes("blocked in us"), `provider ${id} has contradictory US availability`);
      assert(!claimText.includes("tos prohibits us users"), `provider ${id} has contradictory US availability`);
    }
  }

  for (const routeId of assetRouteIds) {
    assert(routeIds.has(routeId), `asset references missing route ${routeId}`);
  }

  for (const route of registry.crypto_routes || []) {
    assert(route.id && route.symbol && route.label, `crypto route ${route.id} missing id/symbol/label`);
    assert(Array.isArray(route.providers) && route.providers.length > 0, `crypto route ${route.id} needs providers`);
    let flagshipCount = 0;
    for (const ref of route.providers || []) {
      assert(providerIds.has(ref.provider), `crypto route ${route.id} references missing provider ${ref.provider}`);
      assert(!disqualifiedIds.has(ref.provider), `crypto route ${route.id} references disqualified provider ${ref.provider}`);
      if (ref.flagship === true) flagshipCount += 1;
    }
    assert(flagshipCount <= 1, `crypto route ${route.id} has more than one flagship provider`);
  }

  for (const country of registry.countries || []) {
    assert(/^[A-Z]{2}$/.test(country.code), `country ${country.code} is not ISO alpha-2 shaped`);
    assert(/^[A-Z]{3}$/.test(country.currency), `country ${country.code} currency is not ISO 4217 shaped`);
    assert(["deep", "thin", "sparse"].includes(country.coverage), `country ${country.code} coverage invalid`);
  }

  for (const [railId, rail] of Object.entries(registry.fiat_rails || {})) {
    for (const [countryCode, refs] of Object.entries(rail.countries || {})) {
      assert(/^[A-Z]{2}$/.test(countryCode), `fiat rail ${railId} has invalid country code ${countryCode}`);
      assert(countryCodes.has(countryCode), `fiat rail ${railId} references unknown country ${countryCode}`);
      assert(Array.isArray(refs) && refs.length > 0, `fiat rail ${railId}/${countryCode} needs providers`);
      let expectedRank = 1;
      for (const ref of refs) {
        assert(providerIds.has(ref.provider), `fiat rail ${railId}/${countryCode} references missing provider ${ref.provider}`);
        assert(!disqualifiedIds.has(ref.provider), `fiat rail ${railId}/${countryCode} references disqualified provider ${ref.provider}`);
        assert(ref.rank === expectedRank, `fiat rail ${railId}/${countryCode} ranks must be sequential`);
        expectedRank += 1;
      }
    }
  }

  for (const provider of registry.disqualified_providers || []) {
    assert(!providerIds.has(provider.id), `disqualified provider ${provider.id} also appears as included`);
    assert(provider.reason, `disqualified provider ${provider.id} missing reason`);
  }
}

function validateData() {
  const currencies = readJson("spec/data/fiat/supported-currencies.json");
  assert(currencies.currencies.includes("usd"), "supported currencies must include usd");
  assert(currencies.currencies.includes("eur"), "supported currencies must include eur");
  assert(currencies.currencies.includes("gbp"), "supported currencies must include gbp");

  const rates = readJson("spec/data/rates/price-sources.json");
  assert(rates.sources.some((source) => source.id === "static_mock"), "missing static_mock price source");
}

function validateOpenApi() {
  const openapi = readYaml("spec/openapi/openreceive-http.v1.yaml");
  assert(openapi.openapi === "3.1.0", "OpenAPI version must be 3.1.0");
  assert(openapi.info?.version === "0.1.0", "OpenAPI info.version mismatch");

  const paths = openapi.paths || {};
  const requiredOperations = [
    ["post", "/invoices"],
    ["get", "/invoices/{invoice_id}"],
    ["post", "/invoices/lookup"],
    ["get", "/invoices/{invoice_id}/events"],
    ["get", "/health"],
    ["get", "/capabilities"]
  ];

  for (const [method, pathName] of requiredOperations) {
    assert(paths[pathName]?.[method], `OpenAPI missing ${method.toUpperCase()} ${pathName}`);
  }

  const amountMsats =
    openapi.components?.schemas?.CreateInvoiceRequest?.properties?.amount_msats;
  assert(amountMsats?.minimum === 1000, "OpenAPI amount_msats minimum mismatch");
  assert(amountMsats?.maximum === 9007199254740991, "OpenAPI amount_msats maximum mismatch");
}

function validateAsyncApi() {
  const asyncapi = readYaml("spec/asyncapi/openreceive-events.v1.yaml");
  assert(asyncapi.asyncapi === "3.0.0", "AsyncAPI version must be 3.0.0");
  assert(asyncapi.info?.version === "0.1.0", "AsyncAPI info.version mismatch");

  const messages = asyncapi.channels?.invoiceEvents?.messages || {};
  for (const message of [
    "invoiceCreated",
    "invoiceVerifying",
    "invoiceSettled",
    "invoiceExpired",
    "invoiceFailed",
    "invoiceFulfilled",
    "invoiceCancelled"
  ]) {
    assert(messages[message], `AsyncAPI missing ${message}`);
  }

  assert(
    asyncapi.components?.schemas?.InvoiceEventPayload?.properties?.amount_msats?.minimum === 1000,
    "AsyncAPI amount_msats minimum mismatch"
  );
}

function main() {
  validateJsonParsing();
  validateSchemas();
  validateFiatVectors();
  validateAmountBoundaries();
  validateSettlementVectors();
  validateLifecycleVectors();
  validatePollingVectors();
  validateIdempotencyVectors();
  validateNwcVectors();
  validateProviderRegistryReferences();
  validateData();
  validateOpenApi();
  validateAsyncApi();
  console.log("v0.1 validation passed.");
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
