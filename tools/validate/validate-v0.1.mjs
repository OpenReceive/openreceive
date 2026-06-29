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

function assertFile(relativePath) {
  try {
    assert(statSync(path.join(root, relativePath)).isFile(), `${relativePath}: expected file`);
  } catch {
    throw new Error(`${relativePath}: expected file`);
  }
}

function parseDecimal(value) {
  assert(/^[0-9]+(\.[0-9]+)?$/.test(value), `invalid decimal: ${value}`);
  const [whole, fraction = ""] = value.split(".");
  return {
    integer: BigInt(`${whole}${fraction}`),
    scale: BigInt(10) ** BigInt(fraction.length),
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
    "spec/schemas/provider-registry.schema.json",
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
  assert(
    invoice.properties.amount_msats.minimum === 1000,
    "invoice amount_msats minimum must be 1000",
  );
  assert(
    invoice.properties.amount_msats.maximum === 9007199254740991,
    "invoice amount_msats maximum mismatch",
  );

  const invoiceStorage = readJson("spec/schemas/invoice-storage.schema.json");
  assert(
    invoiceStorage.required.includes("operation"),
    "invoice-storage schema must require operation for canonical idempotency scope",
  );
  assert(
    JSON.stringify(invoiceStorage.properties.operation.enum) ===
      JSON.stringify(["invoice.create", "invoice.renew"]),
    "invoice-storage operation enum mismatch",
  );
  assert(
    invoiceStorage["x-openreceive-invariants"].some((invariant) =>
      invariant.includes("namespace + operation + idempotency_key"),
    ),
    "invoice-storage schema must document canonical idempotency scope",
  );
  assert(
    invoiceStorage.properties.last_transaction_scan_at?.minimum === 0,
    "invoice-storage schema must include last_transaction_scan_at for status refresh scan attempts",
  );
  assert(
    invoiceStorage.properties.action_claimed_at?.minimum === 0,
    "invoice-storage schema must include action_claimed_at for settlement leases",
  );
  assert(
    invoiceStorage.$defs?.StoredRecord?.properties?.row?.$ref === "#",
    "invoice-storage schema must define StoredRecord",
  );
  assert(
    invoiceStorage.$defs?.MetaRow?.properties?.value?.type === "string",
    "invoice-storage schema must define MetaRow",
  );
  assert(
    invoiceStorage.$defs?.TransactionScanCursor?.properties?.offset?.minimum === 0,
    "invoice-storage schema must define TransactionScanCursor",
  );

  const quote = readJson("spec/schemas/rate-quote.schema.json");
  assert(quote.properties.amount_sats.maximum === 9007199254740, "amount_sats maximum mismatch");

  const error = readJson("spec/schemas/error.schema.json");
  const requiredErrorCodes = [
    "NOT_IMPLEMENTED",
    "RESTRICTED",
    "UNAUTHORIZED",
    "RATE_LIMITED",
    "QUOTA_EXCEEDED",
    "INTERNAL",
    "UNSUPPORTED_ENCRYPTION",
    "INSUFFICIENT_BALANCE",
    "PAYMENT_FAILED",
    "OTHER",
    "NOT_FOUND",
    "TIMEOUT",
    "INVALID_REQUEST",
    "WALLET_UNAVAILABLE",
    "INVOICE_EXPIRED",
    "UNSUPPORTED_METHOD",
    "CONFLICT",
  ];
  const errorCodes = error.properties?.code?.enum || [];
  for (const code of requiredErrorCodes) {
    assert(errorCodes.includes(code), `error schema missing code ${code}`);
  }
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
    const valid =
      item.amount_msats >= boundaries.amount_msats.minimum &&
      item.amount_msats <= boundaries.amount_msats.maximum;
    assert(valid === item.valid, `${item.name}: validity mismatch`);
  }
}

function validateMakeInvoiceValidationVectors() {
  const vector = readJson("spec/test-vectors/make-invoice-validation.json");
  assert(Array.isArray(vector.cases), "make invoice validation vectors must include cases");

  const names = new Set(vector.cases.map((item) => item.name));
  assert(
    names.has("description and description hash conflict"),
    "missing description conflict vector",
  );
  assert(names.has("description hash must be 64 hex"), "missing invalid description_hash vector");
  assert(names.has("metadata over NWC guard is invalid"), "missing metadata guard vector");

  for (const item of vector.cases) {
    const request = item.request || {};
    assert(Number.isSafeInteger(request.amount_msats), `${item.name}: amount_msats is required`);
    if (request.description_hash !== undefined) {
      const validHash = /^[0-9a-fA-F]{64}$/.test(request.description_hash);
      assert(
        validHash === item.expected.valid || item.expected.error === "description_conflict",
        `${item.name}: description_hash expectation mismatch`,
      );
    }
    if (request.metadata_note_length !== undefined) {
      const bytes = Buffer.byteLength(
        JSON.stringify({ note: "x".repeat(request.metadata_note_length) }),
        "utf8",
      );
      assert(bytes > 3900, `${item.name}: metadata guard vector must exceed 3900 bytes`);
      assert(
        item.expected.error === "metadata_too_large",
        `${item.name}: metadata guard error mismatch`,
      );
    }
  }
}

function isSettled(result) {
  return (
    result.settled_at !== undefined ||
    result.state === "settled" ||
    result.transaction_state === "settled"
  );
}

function validateSettlementVectors() {
  const vector = readJson("spec/test-vectors/settlement-detection.json");
  for (const item of vector.cases) {
    assert(
      isSettled(item.transaction) === item.expected.settled,
      `${item.name}: settlement mismatch`,
    );
  }
}

function validateErrorNormalizationVectors() {
  const vector = readJson("spec/test-vectors/error-normalization.json");
  const errorCodes = new Set(readJson("spec/schemas/error.schema.json").properties.code.enum);
  assert(Array.isArray(vector.cases), "error normalization vectors must include cases");

  const names = new Set(vector.cases.map((item) => item.name));
  assert(
    names.has("receive-only path still normalizes send payment failure"),
    "missing send-payment error normalization vector",
  );
  assert(
    names.has("network error name beats generic OTHER code"),
    "missing network error normalization vector",
  );

  for (const item of vector.cases) {
    assert(
      item.raw_error && typeof item.raw_error === "object",
      `${item.name}: raw_error must be an object`,
    );
    assert(
      errorCodes.has(item.expected?.code),
      `${item.name}: expected error code is not canonical`,
    );
    assert(
      typeof item.expected?.message === "string" && item.expected.message.length > 0,
      `${item.name}: expected message is required`,
    );
    assert(
      typeof item.expected?.retryable === "boolean",
      `${item.name}: expected retryable is required`,
    );
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

function validateTransactionScanVectors() {
  const vector = readJson("spec/test-vectors/transaction-scan-pagination.json");
  assert(vector.default_gate_seconds === 2, "transaction scan default gate mismatch");
  assert(vector.default_limit === 20, "transaction scan default limit mismatch");
  assert(
    vector.required_behaviors.includes(
      "each claimed refresh performs at most one incoming unpaid list_transactions page",
    ),
    "missing one-page status refresh behavior",
  );

  const firstPage = vector.examples.find((item) => item.name === "first page");
  assert(firstPage?.request?.offset === 0, "transaction scan first page must start at offset 0");
  assert(firstPage?.cursor_after?.offset === 20, "transaction scan full page must advance offset");

  const shortPage = vector.examples.find((item) => item.name === "short page starts next cycle");
  assert(shortPage?.cursor_after?.offset === 0, "transaction scan short page must reset offset");
  assert(shortPage?.cursor_after?.cycle === 1, "transaction scan short page must increment cycle");

  const timeout = vector.examples.find((item) => item.name === "timeout keeps cursor stable");
  assert(
    JSON.stringify(timeout?.cursor_before) === JSON.stringify(timeout?.cursor_after),
    "transaction scan timeout must not advance cursor",
  );
}

function validateIdempotencyVectors() {
  const vector = readJson("spec/test-vectors/idempotency.json");
  assert(
    vector.canonical_scope.join("+") === "namespace+operation+idempotency_key",
    "idempotency scope mismatch",
  );
  for (const item of vector.cases) {
    const sameHash = item.first_request_hash === item.second_request_hash;
    assert(
      (sameHash && item.expected.status === 200) || (!sameHash && item.expected.status === 409),
      `${item.name}: expected status mismatch`,
    );
  }
}

function validateStorageKvVectors() {
  const vector = readJson("spec/test-vectors/storage-kv.json");
  const expectedMethods = [
    "putIfAbsent",
    "put",
    "get",
    "getByPaymentHash",
    "getByBolt11Invoice",
    "getByIdempotencyScope",
    "listByOrderId",
    "listByCheckoutId",
    "listOpen",
    "getMeta",
    "casMeta",
  ];
  assert(
    JSON.stringify(vector.methods) === JSON.stringify(expectedMethods),
    "storage KV vector methods must match OpenReceiveInvoiceKvStore",
  );
  assert(
    vector.record_shape?.rev === "non-negative integer",
    "storage KV vector must define StoredRecord.rev",
  );
  assert(
    vector.meta_shape?.rev === "non-negative integer",
    "storage KV vector must define MetaRow.rev",
  );
  assert(
    vector.transaction_scan_cursor_shape?.offset === "non-negative integer",
    "storage KV vector must define transaction scan cursor",
  );
  assert(
    vector.certified_v0_1_transports.includes("postgres"),
    "storage KV vector must include Postgres certification",
  );
  assert(
    vector.certified_v0_1_transports.includes("sqlite"),
    "storage KV vector must include SQLite certification",
  );
  assert(
    !vector.deferred_transport_targets.includes("redis"),
    "storage KV vector must not defer Redis",
  );
  assert(
    vector.unsupported_transport_targets.includes("redis"),
    "storage KV vector must keep Redis unsupported",
  );
  assert(
    vector.unsupported_transport_targets.includes("s3"),
    "storage KV vector must keep S3 unsupported",
  );
  assert(
    vector.unsupported_transport_targets.includes("workers_kv"),
    "storage KV vector must keep Workers KV unsupported",
  );

  const caseNames = new Set(vector.cases.map((item) => item.name));
  for (const required of [
    "putIfAbsent atomic uniqueness conflicts name the collided key",
    "idempotency scope precedence returns replay or conflict before wallet-value conflicts",
    "put rejects stale rev and accepts current rev",
    "casMeta is atomic and rejects stale rev",
    "concurrent identical creates store exactly one invoice for the idempotency scope",
    "listOpen returns only non-terminal records and honors limit",
    "secondary indexes stay consistent across create and transition",
    "ownership guard accepts OpenReceive tables and refuses foreign or newer schemas",
    "global transaction scan gate allows at most one wallet page per interval",
    "transaction scan cursor advances offset on full pages",
    "transaction scan cursor resets offset and increments cycle on short pages",
    "transaction scan cursor is not advanced on wallet errors",
    "settlement action lease prevents concurrent execution and recovers expired claims",
  ]) {
    assert(caseNames.has(required), `storage KV vector missing case: ${required}`);
  }
}

function validateManagedPlatformStorageVectors() {
  const vector = readJson("spec/test-vectors/managed-platform-storage.json");
  assert(
    vector.sqlite_policies.includes("never"),
    "managed platform vector must include never policy",
  );
  assert(
    vector.sqlite_policies.includes("explicit-mounted-only"),
    "managed platform vector must include mounted-volume policy",
  );
  assert(
    vector.sqlite_policies.includes("allow-local"),
    "managed platform vector must include raw-host policy",
  );
  for (const code of [
    "EPHEMERAL_STORE_UNSAFE",
    "UNSUPPORTED_STORE_REDIS",
    "UNSAFE_MEMORY_STORE",
    "STORE_MUST_BE_EXPLICIT",
    "STORE_NOT_IMPLEMENTED",
    "UNSUPPORTED_STORE_URI",
  ]) {
    assert(vector.error_codes.includes(code), `managed platform vector missing error code ${code}`);
  }

  const policies = new Map(vector.platforms.map((item) => [item.id, item.policy]));
  assert(policies.get("vercel") === "never", "Vercel must be Postgres-only");
  assert(
    policies.get("fly") === "explicit-mounted-only",
    "Fly must require explicit mounted SQLite",
  );
  assert(policies.get("vps") === "allow-local", "VPS override must allow local SQLite");
  assert(policies.get("unknown") === "allow-local", "unknown local dev policy mismatch");

  const cases = new Map(vector.cases.map((item) => [item.name, item.expected]));
  assert(
    cases.get("memory URI is not selectable")?.code === "UNSUPPORTED_STORE_URI",
    "memory URI case mismatch",
  );
  assert(
    cases.get("redis is permanently unsupported")?.code === "UNSUPPORTED_STORE_REDIS",
    "redis case mismatch",
  );
  assert(
    cases.get("vercel unset store is unsafe even outside NODE_ENV production")?.code ===
      "EPHEMERAL_STORE_UNSAFE",
    "vercel unset case mismatch",
  );
  assert(
    cases.get("fly allows absolute sqlite")?.allowed === true,
    "fly absolute sqlite case mismatch",
  );
  assert(
    cases.get("manual vps override permits implicit local sqlite")?.allowed === true,
    "vps override case mismatch",
  );
}

function validateNwcVectors() {
  const vector = readJson("spec/test-vectors/nwc-uri-parse.json");
  for (const item of vector.cases) {
    if (item.expected_error) continue;
    assert(item.expected.secret_present === true, `${item.name}: expected secret_present`);
    assert(
      item.expected.redacted.includes("secret=[REDACTED]"),
      `${item.name}: redacted secret missing`,
    );
    assert(
      !/[?&]secret=[0-9a-fA-F]{64}/.test(item.expected.redacted),
      `${item.name}: redacted output leaks secret`,
    );
    assert(
      item.expected.relays.every((relay) => relay.startsWith("wss://")),
      `${item.name}: relay must be wss`,
    );
  }
}

function validateNwcInfoVectors() {
  const vector = readJson("spec/test-vectors/nwc-info.json");
  assert(Array.isArray(vector.cases), "NWC info vectors must include cases");

  const names = new Set(vector.cases.map((item) => item.name));
  assert(
    names.has("advertised NIP-44 is preferred over NIP-04"),
    "missing NIP-44 preference vector",
  );
  assert(names.has("missing encryption falls back to NIP-04"), "missing NIP-04 fallback vector");

  for (const item of vector.cases) {
    const expected = item.expected || {};
    assert(
      item.raw_info && typeof item.raw_info === "object",
      `${item.name}: raw_info must be an object`,
    );
    assert(Array.isArray(expected.methods), `${item.name}: expected methods are required`);
    assert(
      expected.methods.includes("make_invoice"),
      `${item.name}: make_invoice expectation missing`,
    );
    assert(
      ["nip04", "nip44_v2"].includes(expected.encryption),
      `${item.name}: expected encryption invalid`,
    );
    assert(
      typeof expected.receive_checkout_ready === "boolean",
      `${item.name}: receive readiness is required`,
    );
  }
}

function validateLiveNwcExpectedCapabilities() {
  const expected = readJson("tools/live-nwc-test/expected_capabilities.json");
  const example = readJson("tools/live-nwc-test/expected_capabilities.example.json");

  assert(
    JSON.stringify(expected) === JSON.stringify(example),
    "default live NWC expected capabilities must match the documented example",
  );
  assert(expected.wallet_profile === "rizful", "default live NWC wallet profile must be rizful");
  assert(
    JSON.stringify(expected.required_methods) ===
      JSON.stringify(["get_info", "make_invoice", "list_transactions"]),
    "default live NWC required methods mismatch",
  );
  assert(
    expected.optional_methods.includes("get_balance"),
    "default live NWC optional methods mismatch",
  );
  assert(
    JSON.stringify(Object.keys(expected).sort()) ===
      JSON.stringify([
        "fallback_encryption",
        "optional_methods",
        "preferred_encryption",
        "required_methods",
        "wallet_profile",
      ]),
    "default live NWC expected capabilities contain unexpected keys",
  );
  assert(
    expected.preferred_encryption === "nip44_v2",
    "default live NWC preferred encryption mismatch",
  );
  assert(expected.fallback_encryption === "nip04", "default live NWC fallback encryption mismatch");
}

function validateNwcRequestResponseVectors() {
  const vector = readJson("spec/test-vectors/nwc-request-response.json");
  assert(Array.isArray(vector.cases), "NWC request/response vectors must include cases");

  const methods = new Set(vector.cases.map((item) => item.method));
  assert(methods.has("make_invoice"), "missing make_invoice request/response vector");
  assert(methods.has("list_transactions"), "missing list_transactions request/response vector");

  for (const item of vector.cases) {
    assert(
      ["make_invoice", "list_transactions"].includes(item.method),
      `${item.name}: unknown method`,
    );
    assert(
      item.openreceive_request && typeof item.openreceive_request === "object",
      `${item.name}: openreceive_request required`,
    );
    assert(
      item.expected_nip47_request && typeof item.expected_nip47_request === "object",
      `${item.name}: expected_nip47_request required`,
    );
    assert(
      item.raw_response && typeof item.raw_response === "object",
      `${item.name}: raw_response required`,
    );
    assert(
      item.expected_openreceive_response && typeof item.expected_openreceive_response === "object",
      `${item.name}: expected response required`,
    );

    if (item.method === "make_invoice") {
      assert(
        item.expected_nip47_request.amount === item.openreceive_request.amount_msats,
        `${item.name}: make_invoice must map amount_msats to NIP-47 amount`,
      );
      assert(
        item.expected_openreceive_response.amount_msats === item.expected_nip47_request.amount,
        `${item.name}: make_invoice response amount mismatch`,
      );
    }

    if (item.method === "list_transactions") {
      assert(
        item.expected_nip47_request.type === "incoming",
        `${item.name}: list_transactions must request incoming`,
      );
      assert(
        item.expected_nip47_request.unpaid === true,
        `${item.name}: list_transactions must include unpaid invoices`,
      );
      assert(
        item.expected_nip47_request.limit === 20,
        `${item.name}: list_transactions page limit mismatch`,
      );
      assert(
        Array.isArray(item.expected_openreceive_response.transactions),
        `${item.name}: expected transactions array missing`,
      );
    }
  }
}

function validateProviderRegistryReferences() {
  const registry = readJson("packages/js/provider-data/src/data/openreceive-providers.v4.json");
  assert(registry.schema_version === "4.0.0", "provider registry schema version mismatch");
  assert(
    registry.generated === "2026-06-20",
    "provider registry generated date changed unexpectedly",
  );
  assert(
    Object.keys(registry.fiat_rails).length === 2,
    "provider registry fiat rail count mismatch",
  );

  const providerIds = new Set(Object.keys(registry.providers || {}));
  const disqualifiedIds = new Set(
    (registry.disqualified_providers || []).map((provider) => provider.id),
  );
  const countryCodes = new Set((registry.countries || []).map((country) => country.code));
  const routeIds = new Set((registry.crypto_routes || []).map((route) => route.id));
  const railIds = new Set(Object.keys(registry.fiat_rails || {}));
  const assetRouteIds = new Set(
    (registry.assets_index || [])
      .map((asset) => asset.route)
      .filter((route) => route !== undefined),
  );
  for (const duplicate of findDuplicates(Object.keys(registry.providers || {}))) {
    assert(false, `provider id ${duplicate} is duplicated`);
  }
  for (const duplicate of findDuplicates((registry.crypto_routes || []).map((route) => route.id))) {
    assert(false, `crypto route id ${duplicate} is duplicated`);
  }
  for (const duplicate of findDuplicates(
    (registry.countries || []).map((country) => country.code),
  )) {
    assert(false, `country code ${duplicate} is duplicated`);
  }

  for (const [id, provider] of Object.entries(registry.providers || {})) {
    assert(id === provider.id, `provider key/id mismatch for ${id}`);
    assert(/^[a-z0-9-]+$/.test(id), `provider ${id} has invalid id`);
    assert(provider.name && provider.url, `provider ${id} missing name or url`);
    assert(provider.url.startsWith("https://"), `provider ${id} url must be https`);
    assert(
      provider.icon_path?.startsWith("assets/provider-icons/"),
      `provider ${id} icon path must be repo-local`,
    );
    assert(
      provider.lightning_docs_url === null || provider.lightning_docs_url.startsWith("https://"),
      `provider ${id} docs url must be https or null`,
    );
    assert(
      provider.pays_arbitrary_invoice === undefined,
      `provider ${id} must not expose v2 pays_arbitrary_invoice in v4`,
    );
    assert(provider.mechanism === undefined, `provider ${id} must not expose v2 mechanism in v4`);
    assert(provider.blurb === undefined, `provider ${id} must not expose v2 blurb in v4`);
    assert(provider.caveat === undefined, `provider ${id} must not expose v2 caveat in v4`);
    assert(!disqualifiedIds.has(id), `provider ${id} appears in disqualified providers`);
    if (provider.tutorials !== undefined) {
      let expectedIndex = 1;
      for (const tutorial of provider.tutorials) {
        assert(tutorial.index === expectedIndex, `provider ${id} tutorials must be sequential`);
        assert(
          tutorial.path.startsWith("assets/pay_tutorials/"),
          `provider ${id} tutorial ${tutorial.index} path must be repo-local`,
        );
        assert(
          Boolean(tutorial.caption),
          `provider ${id} tutorial ${tutorial.index} missing caption`,
        );
        expectedIndex += 1;
      }
    }
  }

  for (const routeId of assetRouteIds) {
    assert(routeIds.has(routeId), `asset references missing route ${routeId}`);
  }

  for (const route of registry.crypto_routes || []) {
    assert(
      route.id && route.symbol && route.label,
      `crypto route ${route.id} missing id/symbol/label`,
    );
    assert(
      route.summary === undefined,
      `crypto route ${route.id} must not expose v2 summary in v4`,
    );
    assert(
      Array.isArray(route.providers) && route.providers.length > 0,
      `crypto route ${route.id} needs providers`,
    );
    let expectedRank = 1;
    const routeHasRanks = route.providers.some((ref) => ref.rank !== undefined);
    const routeProviderIds = new Set();
    for (const ref of route.providers || []) {
      assert(
        providerIds.has(ref.provider),
        `crypto route ${route.id} references missing provider ${ref.provider}`,
      );
      assert(
        !disqualifiedIds.has(ref.provider),
        `crypto route ${route.id} references disqualified provider ${ref.provider}`,
      );
      assert(
        !routeProviderIds.has(ref.provider),
        `crypto route ${route.id} references provider ${ref.provider} more than once`,
      );
      routeProviderIds.add(ref.provider);
      assert(
        ref.blurb_override === undefined,
        `crypto route ${route.id} must not expose v2 blurb_override in v4`,
      );
      if (routeHasRanks) {
        assert(ref.rank === expectedRank, `crypto route ${route.id} ranks must be sequential`);
        expectedRank += 1;
      }
    }
  }

  for (const country of registry.countries || []) {
    assert(/^[A-Z]{2}$/.test(country.code), `country ${country.code} is not ISO alpha-2 shaped`);
    assert(
      /^[A-Z]{3}$/.test(country.currency),
      `country ${country.code} currency is not ISO 4217 shaped`,
    );
    assert(
      ["deep", "thin", "sparse"].includes(country.coverage),
      `country ${country.code} coverage invalid`,
    );
  }

  for (const [railId, rail] of Object.entries(registry.fiat_rails || {})) {
    assert(railIds.has(railId), `fiat rail ${railId} missing from rail id set`);
    assert(Boolean(rail.label), `fiat rail ${railId} missing label`);
    for (const [countryCode, refs] of Object.entries(rail.countries || {})) {
      assert(
        /^[A-Z]{2}$/.test(countryCode),
        `fiat rail ${railId} has invalid country code ${countryCode}`,
      );
      assert(
        countryCodes.has(countryCode),
        `fiat rail ${railId} references unknown country ${countryCode}`,
      );
      assert(
        Array.isArray(refs) && refs.length > 0,
        `fiat rail ${railId}/${countryCode} needs providers`,
      );
      let expectedRank = 1;
      const railProviderIds = new Set();
      for (const ref of refs) {
        assert(
          providerIds.has(ref.provider),
          `fiat rail ${railId}/${countryCode} references missing provider ${ref.provider}`,
        );
        assert(
          !disqualifiedIds.has(ref.provider),
          `fiat rail ${railId}/${countryCode} references disqualified provider ${ref.provider}`,
        );
        assert(
          !railProviderIds.has(ref.provider),
          `fiat rail ${railId}/${countryCode} references provider ${ref.provider} more than once`,
        );
        railProviderIds.add(ref.provider);
        assert(
          ref.rank === expectedRank,
          `fiat rail ${railId}/${countryCode} ranks must be sequential`,
        );
        expectedRank += 1;
      }
    }
  }

  for (const provider of registry.disqualified_providers || []) {
    assert(
      !providerIds.has(provider.id),
      `disqualified provider ${provider.id} also appears as included`,
    );
    assert(provider.reason, `disqualified provider ${provider.id} missing reason`);
  }
}

function findDuplicates(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    } else {
      seen.add(value);
    }
  }
  return [...duplicates];
}

function validateProviderRouteVectors() {
  const registry = readJson("packages/js/provider-data/src/data/openreceive-providers.v4.json");
  const providerIds = new Set(Object.keys(registry.providers || {}));
  const routeIds = new Set((registry.crypto_routes || []).map((route) => route.id));
  const assetSymbols = new Set((registry.assets_index || []).map((asset) => asset.symbol));
  const railIds = new Set(Object.keys(registry.fiat_rails || {}));
  const countryCodes = new Set((registry.countries || []).map((country) => country.code));

  const crypto = readJson("spec/test-vectors/provider-route.crypto-usdt.json");
  assert(crypto.request?.asset === "USDT", "crypto provider-route vector must request USDT");
  assert(crypto.expected?.kind === "crypto", "crypto provider-route vector kind mismatch");
  assert(
    assetSymbols.has(crypto.expected.asset_symbol),
    "crypto provider-route asset missing from registry",
  );
  assert(
    routeIds.has(crypto.expected.route_id),
    "crypto provider-route route missing from registry",
  );
  assert(crypto.expected.length === 1, "crypto provider-route vector must resolve one route");
  assert(
    Array.isArray(crypto.expected.provider_ids),
    "crypto provider-route provider_ids required",
  );
  for (const providerId of crypto.expected.provider_ids) {
    assert(
      providerIds.has(providerId),
      `crypto provider-route references missing provider ${providerId}`,
    );
  }
  for (const providerId of crypto.expected.flagship_provider_ids || []) {
    assert(
      crypto.expected.provider_ids.includes(providerId),
      `crypto provider-route flagship provider ${providerId} must be in provider_ids`,
    );
  }

  const fiat = readJson("spec/test-vectors/provider-route.fiat-us-card.json");
  assert(fiat.request?.rail === "card", "fiat provider-route vector must request card rail");
  assert(fiat.request?.country === "US", "fiat provider-route vector must request US");
  assert(fiat.expected?.kind === "fiat", "fiat provider-route vector kind mismatch");
  assert(railIds.has(fiat.expected.rail_id), "fiat provider-route rail missing from registry");
  assert(
    countryCodes.has(fiat.expected.country_code),
    "fiat provider-route country missing from registry",
  );
  assert(fiat.expected.length === 1, "fiat provider-route vector must resolve one route");
  assert(
    Array.isArray(fiat.expected.provider_ranks),
    "fiat provider-route provider_ranks required",
  );
  let expectedRank = 1;
  for (const [providerId, rank] of fiat.expected.provider_ranks) {
    assert(
      providerIds.has(providerId),
      `fiat provider-route references missing provider ${providerId}`,
    );
    assert(rank === expectedRank, "fiat provider-route ranks must be sequential");
    expectedRank += 1;
  }
}

function validateData() {
  const currencies = readJson("spec/data/fiat/supported-currencies.json");
  assert(currencies.currencies.includes("usd"), "supported currencies must include usd");
  assert(currencies.currencies.includes("eur"), "supported currencies must include eur");
  assert(currencies.currencies.includes("gbp"), "supported currencies must include gbp");

  const rates = readJson("spec/data/rates/price-sources.json");
  const priceFeedVsCurrencies =
    "usd,aed,ars,aud,bdt,bhd,bmd,brl,cad,chf,clp,cny,czk,dkk,eur,gbp,gel,hkd,huf,idr,ils,inr,jpy,krw,kwd,lkr,mmk,mxn,myr,ngn,nok,nzd,php,pkr,pln,rub,sar,sek,sgd,thb,try,twd,uah,vef,vnd,zar";
  assert(
    rates.sources.some((source) => source.id === "static_mock"),
    "missing static_mock price source",
  );
  assert(rates.cache_seconds === 60, "price-feed cache window must be 60 seconds");
  assert(rates.primary_timeout_ms === 5000, "primary price-feed timeout must be 5000ms");
  assert(
    JSON.stringify(rates.sources.map((source) => source.id)) ===
      JSON.stringify(["static_mock", "primary", "fallback"]),
    "price source order mismatch",
  );
  assert(
    rates.sources.find((source) => source.id === "primary")?.url ===
      `https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=${priceFeedVsCurrencies}`,
    "primary price-feed URL mismatch",
  );
  assert(
    rates.sources.find((source) => source.id === "fallback")?.url ===
      `https://openreceive.org/api/v3/simple/price?ids=bitcoin&vs_currencies=${priceFeedVsCurrencies}`,
    "fallback price-feed URL mismatch",
  );

  const demoSpec = readJson("spec/data/demo/fruits.json");
  const demoProduct = readJson("examples/hello-fruit/shared/product.json");
  const demoFruits = readJson("examples/hello-fruit/shared/fruits.json");

  assert(demoSpec.schema_version === "0.1.0", "demo data schema version mismatch");
  assert(
    demoProduct.schema_version === demoSpec.schema_version,
    "Hello Fruit product schema version drift",
  );
  assert(
    demoFruits.schema_version === demoSpec.schema_version,
    "Hello Fruit fruit schema version drift",
  );
  assert(demoProduct.product_id === demoSpec.product_id, "Hello Fruit product id drift");
  assert(demoFruits.product_id === demoSpec.product_id, "Hello Fruit fruit product id drift");
  assert(demoProduct.name === demoSpec.name, "Hello Fruit product name drift");
  assert(demoProduct.description === demoSpec.description, "Hello Fruit product description drift");
  assert(
    !Object.hasOwn(demoProduct, "fulfillment"),
    "Hello Fruit product must not define fulfillment",
  );
  assert(
    Array.isArray(demoSpec.fruits) && demoSpec.fruits.length > 0,
    "canonical demo fruits missing",
  );
  assert(demoFruits.fruits.length === demoSpec.fruits.length, "Hello Fruit fruit count drift");

  for (const [index, fruit] of demoSpec.fruits.entries()) {
    const sharedFruit = demoFruits.fruits[index];
    assert(sharedFruit?.id === fruit.id, `Hello Fruit id drift at index ${index}`);
    assert(sharedFruit?.name === fruit.name, `Hello Fruit name drift for ${fruit.id}`);
    assert(
      JSON.stringify(sharedFruit?.fiat) === JSON.stringify(fruit.fiat),
      `Hello Fruit fiat price drift for ${fruit.id}`,
    );
    assert(sharedFruit.fiat.currency === "USD", `Hello Fruit fiat currency drift for ${fruit.id}`);
    assert(
      /^[0-9]+\.[0-9]{2}$/.test(sharedFruit.fiat.value),
      `Hello Fruit fiat value shape drift for ${fruit.id}`,
    );
    assert(
      quoteFiatToSats(sharedFruit.fiat.value, "50000.00") <= BigInt(400),
      `Hello Fruit fiat price too high for ${fruit.id}`,
    );
    assert(
      sharedFruit?.sticker === `stickers/${fruit.id}.svg`,
      `Hello Fruit sticker path drift for ${fruit.id}`,
    );
    assertFile(`examples/hello-fruit/shared/${sharedFruit.sticker}`);
  }
}

function validateOpenApi() {
  const openapi = readYaml("spec/openapi/openreceive-http.v1.yaml");
  assert(openapi.openapi === "3.1.0", "OpenAPI version must be 3.1.0");
  assert(openapi.info?.version === "0.1.0", "OpenAPI info.version mismatch");

  const paths = openapi.paths || {};
  const requiredOperations = [
    ["post", "/orders/{order_id}/checkouts"],
    ["get", "/checkouts/{checkout_id}"],
    ["post", "/orders/{order_id}/status"],
    ["get", "/rates"],
    ["post", "/rates/quote"],
  ];

  for (const [method, pathName] of requiredOperations) {
    assert(paths[pathName]?.[method], `OpenAPI missing ${method.toUpperCase()} ${pathName}`);
  }

  const amountMsats = openapi.components?.schemas?.CreateCheckoutRequest?.properties?.amount_msats;
  const createCheckoutRequest = openapi.components?.schemas?.CreateCheckoutRequest;
  assert(amountMsats?.minimum === 1000, "OpenAPI amount_msats minimum mismatch");
  assert(amountMsats?.maximum === 9007199254740991, "OpenAPI amount_msats maximum mismatch");
  assert(
    openapi.components?.parameters?.OrderId?.schema?.maxLength === 200,
    "OpenAPI order_id path parameter must be bounded",
  );
  assert(
    createCheckoutRequest?.properties?.order_id?.maxLength === 200,
    "OpenAPI create checkout request must accept optional order_id",
  );
  assert(
    createCheckoutRequest?.properties?.amount?.$ref === "#/components/schemas/BitcoinAmount",
    "OpenAPI create checkout request must allow direct Bitcoin amount input",
  );
  assert(
    JSON.stringify(openapi.components?.schemas?.BitcoinAmount?.properties?.currency?.enum) ===
      JSON.stringify(["BTC", "SAT", "SATS"]),
    "OpenAPI BitcoinAmount currency enum mismatch",
  );
  assert(
    createCheckoutRequest?.not?.required?.includes("optional_invoice_description") &&
      createCheckoutRequest?.not?.required?.includes("description_hash"),
    "OpenAPI create checkout request must reject optional_invoice_description with description_hash",
  );
  assert(
    openapi.components?.schemas?.Checkout?.properties?.checkout_id?.pattern ===
      "^or_chk_[a-z0-9_]+$",
    "OpenAPI checkout_id pattern mismatch",
  );
  assert(
    openapi.components?.schemas?.Checkout?.properties?.active?.$ref ===
      "#/components/schemas/Invoice",
    "OpenAPI checkout response must include an active invoice shape",
  );
  assert(
    openapi.components?.schemas?.Order?.properties?.paid_checkout?.$ref ===
      "#/components/schemas/Checkout",
    "OpenAPI order response must group the paid checkout",
  );
  assert(
    openapi.components?.schemas?.Invoice?.properties?.refreshed_from_invoice_id?.pattern ===
      "^or_inv_[a-z0-9_]+$",
    "OpenAPI invoice refreshed_from_invoice_id pattern mismatch",
  );
  assert(
    openapi.components?.schemas?.Invoice?.properties?.settlement_action_completed_at?.minimum === 0,
    "OpenAPI invoice settlement_action_completed_at timestamp missing",
  );
  assert(
    openapi.components?.schemas?.Invoice?.required?.includes("settlement_action_state"),
    "OpenAPI invoice settlement_action_state must be required",
  );
  assert(
    JSON.stringify(
      openapi.components?.schemas?.Invoice?.properties?.settlement_action_state?.enum,
    ) === JSON.stringify(["pending", "completed", "failed"]),
    "OpenAPI invoice settlement_action_state enum mismatch",
  );
  assert(
    openapi.components?.schemas?.Invoice?.properties?.fulfillment === undefined,
    "OpenAPI invoice must not expose fulfillment object",
  );
  assert(
    openapi.components?.schemas?.Invoice?.properties?.fulfilled_at === undefined,
    "OpenAPI invoice must not expose fulfilled_at",
  );
  assert(
    openapi.components?.schemas?.QuoteRateRequest?.required?.includes("fiat"),
    "OpenAPI quote rate request must require fiat",
  );
  assert(
    openapi.components?.schemas?.BtcFiatRateMap?.properties?.bitcoin,
    "OpenAPI BTC fiat rate map schema missing bitcoin rates",
  );

  const canonicalErrorCodes = readJson("spec/schemas/error.schema.json").properties.code.enum;
  assert(
    JSON.stringify(openapi.components?.schemas?.Error?.properties?.code?.enum) ===
      JSON.stringify(canonicalErrorCodes),
    "OpenAPI error codes must match shared error schema",
  );
}

function validateAsyncApi() {
  const asyncapi = readYaml("spec/asyncapi/openreceive-events.v1.yaml");
  assert(asyncapi.asyncapi === "3.0.0", "AsyncAPI version must be 3.0.0");
  assert(asyncapi.info?.version === "0.1.0", "AsyncAPI info.version mismatch");

  const messages = asyncapi.channels?.invoiceLifecycleEvents?.messages || {};
  for (const message of [
    "invoiceCreated",
    "invoiceVerifying",
    "invoiceSettled",
    "invoiceSettlementActionCompleted",
    "invoiceExpired",
    "invoiceFailed",
    "invoiceCancelled",
  ]) {
    assert(messages[message], `AsyncAPI missing ${message}`);
  }

  assert(
    asyncapi.components?.schemas?.InvoiceEventPayload?.properties?.amount_msats?.minimum === 1000,
    "AsyncAPI amount_msats minimum mismatch",
  );
  assert(
    asyncapi.components?.schemas?.InvoiceEventPayload?.required?.includes(
      "settlement_action_state",
    ),
    "AsyncAPI settlement_action_state must be required",
  );
}

function main() {
  validateJsonParsing();
  validateSchemas();
  validateFiatVectors();
  validateAmountBoundaries();
  validateMakeInvoiceValidationVectors();
  validateSettlementVectors();
  validateErrorNormalizationVectors();
  validateLifecycleVectors();
  validateTransactionScanVectors();
  validateIdempotencyVectors();
  validateStorageKvVectors();
  validateManagedPlatformStorageVectors();
  validateNwcVectors();
  validateNwcInfoVectors();
  validateLiveNwcExpectedCapabilities();
  validateNwcRequestResponseVectors();
  validateProviderRegistryReferences();
  validateProviderRouteVectors();
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
