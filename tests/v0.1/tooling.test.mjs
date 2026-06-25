import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const secretScanner = path.join(process.cwd(), "tools/validate/scan-secrets.mjs");
const clientBundleScanner = path.join(process.cwd(), "tools/validate/scan-client-bundles.mjs");
const demoContainerValidator = path.join(process.cwd(), "tools/validate/check-demo-containers.mjs");
const demoDeployValidator = path.join(process.cwd(), "tools/validate/check-demo-deploy.mjs");
const demoDeploymentDocs = path.join(process.cwd(), "docs/internal/demo-deployment.md");
const supportedDatabaseDocs = path.join(process.cwd(), "docs/guides/storage.md");
const nodeQuickstartDocs = path.join(process.cwd(), "docs/guides/quickstart-node.md");
const authorizationDocs = path.join(process.cwd(), "docs/guides/authorization.md");
const invoiceStorageSchema = path.join(process.cwd(), "spec/schemas/invoice-storage.schema.json");
const storageKvVectors = path.join(process.cwd(), "spec/test-vectors/storage-kv.json");
const releaseReadinessValidator = path.join(process.cwd(), "tools/validate/check-release-readiness.mjs");
const workflowValidator = path.join(process.cwd(), "tools/validate/check-workflows.mjs");
const liveNwcSmoke = path.join(process.cwd(), "tools/live-nwc-test/index.mjs");
const rubyLiveNwcSmoke = path.join(process.cwd(), "tools/live-nwc-test/ruby-smoke.rb");
const liveExpectedCapabilities = path.join(
  process.cwd(),
  "tools/live-nwc-test/expected_capabilities.json"
);
const liveExpectedCapabilitiesExample = path.join(
  process.cwd(),
  "tools/live-nwc-test/expected_capabilities.example.json"
);

function withGitRepo(callback) {
  const dir = mkdtempSync(path.join(tmpdir(), "openreceive-secret-scan-"));

  try {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    callback(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runSecretScanner(cwd) {
  return execFileSync(process.execPath, [secretScanner], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function runClientBundleScanner(cwd) {
  return execFileSync(process.execPath, [clientBundleScanner], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function runDemoContainerValidator() {
  return execFileSync(process.execPath, [demoContainerValidator], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function runDemoDeployValidator() {
  return execFileSync(process.execPath, [demoDeployValidator], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

test("workspace metadata does not reference removed express or next packages", () => {
  assert.equal(existsSync(path.join(process.cwd(), "packages/js/express")), false);
  assert.equal(existsSync(path.join(process.cwd(), "packages/js/next")), false);

  for (const relativePath of [
    "package.json",
    "package-lock.json",
    "packages/js/node/package.json",
    "examples/hello-fruit/server/node-express/package.json",
    "examples/hello-fruit/server/static-html-small-api/package.json",
    "examples/hello-fruit/server/nextjs-fullstack/package.json",
    "docs/internal/release-process.md",
    "docs/internal/scope-lock.md"
  ]) {
    const text = readFileSync(path.join(process.cwd(), relativePath), "utf8");
    assert.doesNotMatch(text, /@openreceive\/express|packages\/js\/express|@openreceive\/next|packages\/js\/next/, relativePath);
  }
});

test("public Node guides show app routes without OpenReceive error class imports", () => {
  for (const filePath of [nodeQuickstartDocs, authorizationDocs]) {
    const source = readFileSync(filePath, "utf8");
    assert.doesNotMatch(source, /OpenReceiveServiceError/, filePath);
    assert.doesNotMatch(source, /order_uuid:|optional_invoice_description:|total_fiat/, filePath);
    assert.match(source, /orderUuid:/, filePath);
    assert.match(source, /optionalInvoiceDescription:/, filePath);
    assert.match(source, /totalAmount/, filePath);
    assert.match(source, /import \{ createOpenReceive \} from "@openreceive\/node";/, filePath);
  }
});

test("Node quickstart covers all shipped frontend framework adapters", () => {
  const source = readFileSync(nodeQuickstartDocs, "utf8");

  for (const heading of ["## React", "## Vue", "## Svelte", "## Angular"]) {
    assert.match(source, new RegExp(heading), `${heading}: quickstart section exists`);
  }
  assert.match(source, /@openreceive\/angular\/checkout-component/);
  assert.doesNotMatch(
    source.slice(source.indexOf("## Angular"), source.indexOf("## Optional Scheduler")),
    /@openreceive\/vue|createOpenReceiveVue/
  );
});

function runReleaseReadinessValidator() {
  return execFileSync(process.execPath, [releaseReadinessValidator], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function runWorkflowValidator() {
  return execFileSync(process.execPath, [workflowValidator], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function runLiveNwcSmoke(env) {
  const childEnv = {
    ...process.env,
    ...env
  };
  for (const [key, value] of Object.entries(childEnv)) {
    if (value === undefined) delete childEnv[key];
  }

  return execFileSync(process.execPath, [liveNwcSmoke], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function runRubyLiveNwcSmoke(env) {
  const childEnv = {
    ...process.env,
    ...env
  };
  for (const [key, value] of Object.entries(childEnv)) {
    if (value === undefined) delete childEnv[key];
  }

  return execFileSync(
    "ruby",
    ["-Ipackages/ruby/openreceive/lib", rubyLiveNwcSmoke],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
}

test("demo container validator accepts current Hello Fruit templates", () => {
  assert.match(runDemoContainerValidator(), /Demo container validation passed for 4 demo\(s\)\./);
});

test("demo deployment validator accepts public deploy templates", () => {
  assert.match(runDemoDeployValidator(), /Demo deployment validation passed for 3 demo\(s\)\./);
});

test("demo deployment docs preserve public edge and runner boundaries", () => {
  const docs = readFileSync(demoDeploymentDocs, "utf8");

  assert.match(docs, /separate demo edge or node/);
  assert.match(docs, /Do not route stable demos through the private apex app/);
  assert.match(docs, /Caddy with the Cloudflare DNS module and ACME DNS-01/);
  assert.match(docs, /Keep build\/test runners separate from deploy runners/);
  assert.match(docs, /Never mount the host Docker socket/);
  assert.match(docs, /Never commit:\n\n- `OPENRECEIVE_NWC`/);
});

test("release readiness validator accepts current v0.1 metadata", () => {
  assert.match(runReleaseReadinessValidator(), /Release readiness validation passed for 10 package\(s\)\./);
});

test("workflow validator accepts safe public workflow skeletons", () => {
  assert.match(runWorkflowValidator(), /Workflow validation passed for 7 workflow\(s\)\./);
});

test("supported database docs keep invoice storage boundaries narrow", () => {
  const docs = readFileSync(supportedDatabaseDocs, "utf8");
  const quickstart = readFileSync(nodeQuickstartDocs, "utf8");

  assert.match(docs, /\| `postgres:\/\/\.\.\.` \| Supported for Node \|/);
  assert.match(docs, /\| `sqlite:\/path\/to\/openreceive\.sqlite3` \| Supported for Node \|/);
  assert.match(docs, /\| `local-sqlite` \| Supported for Node \|/);
  assert.match(docs, /Cloudflare Workers KV/);
  assert.match(docs, /OpenReceive owns its invoice storage/);
  assert.match(docs, /Your app keeps orders, carts, users/);
  assert.match(quickstart, /OpenReceive-managed Postgres or SQLite invoice/);
});

test("storage schema and vectors cover KV coordination fields", () => {
  const schema = JSON.parse(readFileSync(invoiceStorageSchema, "utf8"));
  const vectors = JSON.parse(readFileSync(storageKvVectors, "utf8"));

  assert.equal(schema.properties.last_lookup_at.minimum, 0);
  assert.equal(schema.properties.action_claimed_at.minimum, 0);
  assert.equal(schema.$defs.StoredRecord.properties.row.$ref, "#");
  assert.equal(schema.$defs.MetaRow.properties.value.type, "string");
  assert.equal(schema.$defs.LookupBucket.properties.tokens.minimum, 0);

  assert.deepEqual(vectors.methods, [
    "putIfAbsent",
    "put",
    "get",
    "getByPaymentHash",
    "getByBolt11Invoice",
    "getByIdempotencyScope",
    "listOpen",
    "getMeta",
    "casMeta"
  ]);
  assert.equal(vectors.cases.length, 12);
  assert.equal(vectors.certified_v0_1_transports.includes("postgres"), true);
  assert.equal(vectors.certified_v0_1_transports.includes("sqlite"), true);
  assert.equal(vectors.deferred_transport_targets.includes("redis"), true);
  assert.equal(vectors.unsupported_transport_targets.includes("s3"), true);
});

test("OpenReceive-owned invoice schemas do not add app-specific columns", () => {
  const schemaPaths = [
    "packages/js/node/src/postgres-store.ts",
    "packages/js/node/src/sqlite-store.ts",
    "packages/js/node/migrations/001_create_openreceive_invoices.postgres.sql",
    "packages/ruby/openreceive-rails/lib/openreceive/rails.rb"
  ];
  const appSpecificColumns = [
    /\buser_id\b/,
    /\border_id\b/,
    /\bcart_id\b/,
    /\bproduct_id\b/,
    /\btenant_id\b/,
    /\bcustomer_id\b/,
    /\bfruit\b/
  ];

  for (const relativePath of schemaPaths) {
    const source = readFileSync(path.join(process.cwd(), relativePath), "utf8");
    assert.match(source, /\bmetadata\b/, `${relativePath}: OpenReceive rows keep app references in metadata`);
    for (const pattern of appSpecificColumns) {
      assert.doesNotMatch(source, pattern, `${relativePath}: must not add ${pattern} to OpenReceive invoice rows`);
    }
  }
});

test("live NWC expected capabilities fixture matches the documented Rizful default", () => {
  const fixture = JSON.parse(readFileSync(liveExpectedCapabilities, "utf8"));
  const example = JSON.parse(readFileSync(liveExpectedCapabilitiesExample, "utf8"));

  assert.deepEqual(fixture, example);
  assert.equal(fixture.wallet_profile, "rizful");
  assert.deepEqual(fixture.required_methods, [
    "get_info",
    "make_invoice",
    "lookup_invoice"
  ]);
  assert.equal(fixture.required_notifications.includes("payment_received"), true);
  assert.equal(fixture.fallback_encryption, "nip04");
});

test("secret scanner rejects force-added non-example env files", () => {
  withGitRepo((dir) => {
    writeFileSync(path.join(dir, ".env.local"), "OPENRECEIVE_NWC=replace-me\n");
    execFileSync("git", ["add", "-f", ".env.local"], { cwd: dir, stdio: "ignore" });

    assert.throws(
      () => runSecretScanner(dir),
      (error) => {
        assert.match(String(error.stderr), /\.env\.local: tracked env file is forbidden/);
        return true;
      }
    );
  });
});

test("secret scanner rejects force-added root env files without echoing secrets", () => {
  withGitRepo((dir) => {
    const uri = `nostr+walletconnect://${"a".repeat(64)}?relay=wss%3A%2F%2Frelay.example.com&secret=${"b".repeat(64)}`;
    writeFileSync(path.join(dir, ".env"), `OPENRECEIVE_NWC=${uri}\n`);
    execFileSync("git", ["add", "-f", ".env"], { cwd: dir, stdio: "ignore" });

    assert.throws(
      () => runSecretScanner(dir),
      (error) => {
        assert.match(String(error.stderr), /\.env: tracked env file is forbidden/);
        assert.match(String(error.stderr), /\.env: NWC URI with 64 hex secret/);
        assert.doesNotMatch(String(error.stderr), new RegExp("b".repeat(64)));
        return true;
      }
    );
  });
});

test("secret scanner rejects tracked env-like deployment filenames", () => {
  withGitRepo((dir) => {
    const deployDir = path.join(dir, "demos", "deploy");
    mkdirSync(deployDir, { recursive: true });
    writeFileSync(path.join(deployDir, "prod.env.local"), "OPENRECEIVE_NWC=replace-me\n");
    execFileSync("git", ["add", "demos/deploy/prod.env.local"], { cwd: dir, stdio: "ignore" });

    assert.throws(
      () => runSecretScanner(dir),
      (error) => {
        assert.match(String(error.stderr), /demos\/deploy\/prod\.env\.local: tracked env file is forbidden/);
        return true;
      }
    );
  });
});

test("secret scanner allows tracked env examples", () => {
  withGitRepo((dir) => {
    writeFileSync(path.join(dir, ".env.example"), "OPENRECEIVE_NWC=\n");
    execFileSync("git", ["add", ".env.example"], { cwd: dir, stdio: "ignore" });

    assert.match(runSecretScanner(dir), /Secret scan passed\./);
  });
});

test("client bundle scanner allows safe generated bundles", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "openreceive-bundle-scan-"));

  try {
    const assetsDir = path.join(dir, "examples", "demo", "dist", "assets");
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(path.join(assetsDir, "app.js"), "console.log('openreceive checkout');\n");

    assert.match(runClientBundleScanner(dir), /Client bundle secret scan passed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("client bundle scanner rejects NWC markers in generated bundles", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "openreceive-bundle-scan-"));

  try {
    const assetsDir = path.join(dir, "examples", "demo", "dist", "assets");
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(path.join(assetsDir, "app.js"), "const leaked = 'OPENRECEIVE_NWC';\n");

    assert.throws(
      () => runClientBundleScanner(dir),
      (error) => {
        assert.match(String(error.stderr), /examples\/demo\/dist\/assets\/app\.js: OPENRECEIVE_NWC marker/);
        return true;
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("client bundle scanner rejects NWC markers in generated source maps", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "openreceive-bundle-scan-"));

  try {
    const assetsDir = path.join(dir, "examples", "demo", "dist", "assets");
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(path.join(assetsDir, "app.js"), "console.log('safe');\n");
    writeFileSync(
      path.join(assetsDir, "app.js.map"),
      JSON.stringify({
        version: 3,
        sources: ["src/app.ts"],
        sourcesContent: ["const leaked = 'OPENRECEIVE_NWC';"],
        mappings: ""
      })
    );

    assert.throws(
      () => runClientBundleScanner(dir),
      (error) => {
        assert.match(String(error.stderr), /examples\/demo\/dist\/assets\/app\.js\.map: OPENRECEIVE_NWC marker/);
        return true;
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("client bundle scanner rejects real-looking NWC URIs in generated bundles", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "openreceive-bundle-scan-"));

  try {
    const assetsDir = path.join(dir, "examples", "demo", "dist", "assets");
    const uri = `nostr+walletconnect://${"a".repeat(64)}?secret=${"b".repeat(64)}`;
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(path.join(assetsDir, "app.js"), `const leaked = '${uri}';\n`);

    assert.throws(
      () => runClientBundleScanner(dir),
      (error) => {
        assert.match(String(error.stderr), /examples\/demo\/dist\/assets\/app\.js: NWC connection URI/);
        assert.match(String(error.stderr), /examples\/demo\/dist\/assets\/app\.js: NWC code query value/);
        return true;
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("client bundle scanner rejects NWC markers in Next static output", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "openreceive-bundle-scan-"));

  try {
    const assetsDir = path.join(dir, "examples", "demo", ".next", "static", "chunks");
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(path.join(assetsDir, "app.js"), "const leaked = 'OPENRECEIVE_NWC';\n");

    assert.throws(
      () => runClientBundleScanner(dir),
      (error) => {
        assert.match(String(error.stderr), /examples\/demo\/\.next\/static\/chunks\/app\.js: OPENRECEIVE_NWC marker/);
        return true;
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("live NWC smoke reports canonical URI parse errors before wallet calls", () => {
  const badNwc =
    "nostr+walletconnect://" +
    "a".repeat(64) +
    "?relay=wss%3A%2F%2Frelay.example.com&secret=not-secret";

  assert.throws(
    () => runLiveNwcSmoke({ OPENRECEIVE_NWC: badNwc }),
    (error) => {
      assert.match(String(error.stderr), /NWC client secret must be 64 hex characters\./);
      assert.doesNotMatch(String(error.stderr), /not-secret/);
      return true;
    }
  );
});

test("live NWC smoke loads gitignored env file without leaking parse secrets", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "openreceive-live-env-"));
  const envPath = path.join(dir, "wallet.env");
  const badNwc =
    "nostr+walletconnect://" +
    "a".repeat(64) +
    "?relay=wss%3A%2F%2Frelay.example.com&secret=not-secret";

  try {
    writeFileSync(
      envPath,
      `OPENRECEIVE_NWC=${badNwc}\nOPENRECEIVE_WALLET_PROFILE=alby\n`
    );

    assert.throws(
      () =>
        runLiveNwcSmoke({
          OPENRECEIVE_ENV_FILE: envPath,
          OPENRECEIVE_NWC: undefined,
          OPENRECEIVE_WALLET_PROFILE: undefined
        }),
      (error) => {
        assert.match(String(error.stderr), /NWC client secret must be 64 hex characters\./);
        assert.doesNotMatch(String(error.stderr), /not-secret/);
        return true;
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Ruby live NWC smoke skips clearly when unset", () => {
  assert.match(
    runRubyLiveNwcSmoke({
      OPENRECEIVE_NWC: undefined,
      OPENRECEIVE_ENV_FILE: undefined
    }),
    /OPENRECEIVE_NWC is not set; skipping Ruby live NWC smoke test\./
  );
});

test("Ruby live NWC smoke redacts fake URI before skipping wallet calls", () => {
  const uri = `nostr+walletconnect://${"a".repeat(64)}?relay=wss%3A%2F%2Frelay.example.com&secret=${"b".repeat(64)}`;
  const output = runRubyLiveNwcSmoke({
    OPENRECEIVE_NWC: uri,
    OPENRECEIVE_RUBY_NWC_DISABLE_GEM: "1"
  });

  assert.match(output, /Ruby NWC URI parsed for wallet profile: rizful/);
  assert.match(output, /Wallet pubkey prefix: aaaaaaaa\.\.\./);
  assert.match(output, /secret=\[REDACTED\]/);
  assert.match(output, /nwc-ruby gem is not installed; skipping live Ruby wallet calls/);
  assert.doesNotMatch(output, new RegExp("b".repeat(64)));
});
