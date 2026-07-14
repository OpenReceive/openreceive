import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const secretScanner = path.join(process.cwd(), "tools/validate/scan-secrets.mjs");
const clientBundleScanner = path.join(process.cwd(), "tools/validate/scan-client-bundles.mjs");
const demoContainerValidator = path.join(process.cwd(), "tools/validate/check-demo-containers.mjs");
const invoiceStorageSchema = path.join(process.cwd(), "spec/schemas/invoice-storage.schema.json");
const storageKvVectors = path.join(process.cwd(), "spec/test-vectors/storage-kv.json");
const releaseReadinessValidator = path.join(
  process.cwd(),
  "tools/validate/check-release-readiness.mjs",
);
const npmReleaseHelper = path.join(process.cwd(), "tools/release/npm-release.mjs");
const workflowValidator = path.join(process.cwd(), "tools/validate/check-workflows.mjs");
const liveNwcSmoke = path.join(process.cwd(), "tools/live-nwc-test/index.mjs");
const rubyLiveNwcSmoke = path.join(process.cwd(), "tools/live-nwc-test/ruby-smoke.rb");
const liveExpectedCapabilities = path.join(
  process.cwd(),
  "tools/live-nwc-test/expected_capabilities.json",
);
const liveExpectedCapabilitiesExample = path.join(
  process.cwd(),
  "tools/live-nwc-test/expected_capabilities.example.json",
);
const exampleRoot = path.join(process.cwd(), "examples");
const textFileExtensions = new Set([
  "",
  ".css",
  ".env",
  ".example",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".rb",
  ".sh",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);
const generatedFolderNames = new Set([".next", "coverage", "dist", "node_modules"]);

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
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runClientBundleScanner(cwd) {
  return execFileSync(process.execPath, [clientBundleScanner], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function listTextFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (generatedFolderNames.has(entry.name)) continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTextFiles(fullPath));
      continue;
    }
    if (entry.isFile() && textFileExtensions.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

function runDemoContainerValidator() {
  return execFileSync(process.execPath, [demoContainerValidator], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("shipped route adapters exist and wrap @openreceive/http", () => {
  // The route-shipping re-architecture (re)introduces framework adapters over the shared
  // @openreceive/http handler. Each must exist, expose a root export, and depend on the handler.
  for (const name of ["http", "express", "fastify", "next"]) {
    const dir = path.join(process.cwd(), "packages/js", name);
    assert.equal(existsSync(dir), true, `packages/js/${name} must exist`);
    const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    assert.equal(manifest.name, `@openreceive/${name}`, `${name}: package name`);
    assert.ok(manifest.exports?.["."], `${name}: must expose a root export`);
    if (name !== "http") {
      assert.equal(
        manifest.dependencies?.["@openreceive/http"],
        "0.1.1",
        `${name}: adapter must depend on @openreceive/http`,
      );
    }
  }
});

test("examples do not use OpenReceive HTTP converter helpers", () => {
  const helperPrefix = ["toOpenReceive", "Http"].join("");
  const helperPattern = new RegExp(`${helperPrefix}(?:Checkout|Order)\\b`);
  for (const filePath of listTextFiles(exampleRoot)) {
    assert.doesNotMatch(readFileSync(filePath, "utf8"), helperPattern, filePath);
  }
});

function runReleaseReadinessValidator() {
  return execFileSync(process.execPath, [releaseReadinessValidator], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function nextPatchVersion(version) {
  const [major, minor, patch] = version.split(".").map((part) => Number(part));
  return `${major}.${minor}.${patch + 1}`;
}

function runWorkflowValidator() {
  return execFileSync(process.execPath, [workflowValidator], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runLiveNwcSmoke(env, options = {}) {
  const childEnv = {
    ...process.env,
    ...env,
  };
  for (const [key, value] of Object.entries(childEnv)) {
    if (value === undefined) delete childEnv[key];
  }

  return execFileSync(process.execPath, [liveNwcSmoke], {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runRubyLiveNwcSmoke(env, options = {}) {
  const childEnv = {
    ...process.env,
    ...env,
  };
  for (const [key, value] of Object.entries(childEnv)) {
    if (value === undefined) delete childEnv[key];
  }

  return execFileSync(
    "ruby",
    ["-I", path.join(process.cwd(), "packages/ruby/openreceive/lib"), rubyLiveNwcSmoke],
    {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

test("demo container validator accepts current Hello Fruit templates", () => {
  assert.match(runDemoContainerValidator(), /Demo container validation passed for 3 demo\(s\)\./);
});

test("release readiness validator accepts current v0.1 metadata", () => {
  assert.match(
    runReleaseReadinessValidator(),
    /Release readiness validation passed for 15 package\(s\)\./,
  );
});

test("npm release helper plans a patch release without editing files", () => {
  const currentVersion = JSON.parse(
    readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
  ).version;
  const nextVersion = nextPatchVersion(currentVersion);
  const output = execFileSync(process.execPath, [npmReleaseHelper, "plan", "--version", "patch"], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  assert.match(
    output,
    new RegExp(
      `OpenReceive npm release plan: ${currentVersion.replace(/\./g, "\\.")} -> ${nextVersion.replace(/\./g, "\\.")}`,
    ),
  );
  assert.match(
    output,
    new RegExp(`@openreceive/provider-data@${nextVersion.replace(/\./g, "\\.")}`),
  );
  assert.match(
    output,
    new RegExp(`npm run release:prepare -- --version ${nextVersion.replace(/\./g, "\\.")}`),
  );
  assert.match(output, /npm run release:publish -- --tag latest/);
});

test("npm release helper prepare dry-run lists versioned files", () => {
  const currentVersion = JSON.parse(
    readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
  ).version;
  const nextVersion = nextPatchVersion(currentVersion);
  const output = execFileSync(
    process.execPath,
    [npmReleaseHelper, "prepare", "--version", nextVersion, "--dry-run"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  assert.match(
    output,
    new RegExp(
      `Would prepare OpenReceive npm release: ${currentVersion.replace(/\./g, "\\.")} -> ${nextVersion.replace(/\./g, "\\.")}`,
    ),
  );
  assert.match(output, /package\.json/);
  assert.match(output, /packages\/js\/provider-data\/package\.json/);
  assert.match(output, /package-lock\.json/);
});

test("workflow validator accepts safe public workflow skeletons", () => {
  assert.match(runWorkflowValidator(), /Workflow validation passed for 7 workflow\(s\)\./);
});

test("storage schema and vectors cover KV coordination fields", () => {
  const schema = JSON.parse(readFileSync(invoiceStorageSchema, "utf8"));
  const vectors = JSON.parse(readFileSync(storageKvVectors, "utf8"));

  assert.equal(schema.properties.last_transaction_scan_at.minimum, 0);
  assert.equal(schema.properties.action_claimed_at.minimum, 0);
  assert.equal(schema.$defs.StoredRecord.properties.row.$ref, "#");
  assert.equal(schema.$defs.MetaRow.properties.value.type, "string");
  assert.deepEqual(schema.$defs.TransactionScanCursor.properties.until_cursor.type, [
    "integer",
    "null",
  ]);
  assert.equal(schema.$defs.TransactionScanCursor.properties.last_swept_at.minimum, 0);

  assert.deepEqual(vectors.methods, [
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
  ]);
  assert.equal(vectors.cases.length, 13);
  assert.equal(vectors.transaction_scan_cursor_shape.until_cursor, "unix seconds or null");
  assert.equal(vectors.certified_v0_1_transports.includes("postgres"), true);
  assert.equal(vectors.certified_v0_1_transports.includes("sqlite"), true);
  assert.equal(vectors.deferred_transport_targets.includes("redis"), false);
  assert.equal(vectors.unsupported_transport_targets.includes("redis"), true);
  assert.equal(vectors.unsupported_transport_targets.includes("s3"), true);
});

test("OpenReceive-owned invoice schemas do not add app-specific columns", () => {
  const schemaPaths = [
    "packages/js/node/src/postgres-store.ts",
    "packages/js/node/src/sqlite-store.ts",
    "packages/js/node/migrations/001_create_openreceive_invoices.postgres.sql",
    "packages/ruby/openreceive/lib/openreceive.rb",
  ];
  const appSpecificColumns = [
    /\buser_id\b/,
    /\bcart_id\b/,
    /\bproduct_id\b/,
    /\btenant_id\b/,
    /\bcustomer_id\b/,
    /\bfruit\b/,
  ];

  for (const relativePath of schemaPaths) {
    const source = readFileSync(path.join(process.cwd(), relativePath), "utf8");
    assert.match(
      source,
      /\bmetadata\b/,
      `${relativePath}: OpenReceive rows keep app references in metadata`,
    );
    for (const pattern of appSpecificColumns) {
      assert.doesNotMatch(
        source,
        pattern,
        `${relativePath}: must not add ${pattern} to OpenReceive invoice rows`,
      );
    }
  }
});

test("live NWC expected capabilities fixture matches the documented Rizful default", () => {
  const fixture = JSON.parse(readFileSync(liveExpectedCapabilities, "utf8"));
  const example = JSON.parse(readFileSync(liveExpectedCapabilitiesExample, "utf8"));

  assert.deepEqual(fixture, example);
  assert.equal(fixture.wallet_profile, "rizful");
  assert.deepEqual(fixture.required_methods, ["get_info", "make_invoice", "list_transactions"]);
  assert.deepEqual(Object.keys(fixture).sort(), [
    "fallback_encryption",
    "optional_methods",
    "preferred_encryption",
    "required_methods",
    "wallet_profile",
  ]);
  assert.equal(fixture.fallback_encryption, "nip04");
});

test("secret scanner rejects force-added env files", () => {
  withGitRepo((dir) => {
    writeFileSync(path.join(dir, ".env.local"), "OPENRECEIVE_NWC=replace-me\n");
    execFileSync("git", ["add", "-f", ".env.local"], { cwd: dir, stdio: "ignore" });

    assert.throws(
      () => runSecretScanner(dir),
      (error) => {
        assert.match(String(error.stderr), /\.env\.local: tracked env file is forbidden/);
        return true;
      },
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
      },
    );
  });
});

test("secret scanner rejects tracked env-like deployment filenames", () => {
  withGitRepo((dir) => {
    writeFileSync(path.join(dir, "prod.env.local"), "OPENRECEIVE_NWC=replace-me\n");
    execFileSync("git", ["add", "prod.env.local"], { cwd: dir, stdio: "ignore" });

    assert.throws(
      () => runSecretScanner(dir),
      (error) => {
        assert.match(String(error.stderr), /prod\.env\.local: tracked env file is forbidden/);
        return true;
      },
    );
  });
});

test("secret scanner allows tracked openreceive.yml examples", () => {
  withGitRepo((dir) => {
    writeFileSync(path.join(dir, "openreceive.yml.example"), 'OPENRECEIVE_NWC: ""\n');
    execFileSync("git", ["add", "openreceive.yml.example"], { cwd: dir, stdio: "ignore" });

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
        assert.match(
          String(error.stderr),
          /examples\/demo\/dist\/assets\/app\.js: OPENRECEIVE_NWC marker/,
        );
        return true;
      },
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
        mappings: "",
      }),
    );

    assert.throws(
      () => runClientBundleScanner(dir),
      (error) => {
        assert.match(
          String(error.stderr),
          /examples\/demo\/dist\/assets\/app\.js\.map: OPENRECEIVE_NWC marker/,
        );
        return true;
      },
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
        assert.match(
          String(error.stderr),
          /examples\/demo\/dist\/assets\/app\.js: NWC connection URI/,
        );
        assert.match(
          String(error.stderr),
          /examples\/demo\/dist\/assets\/app\.js: NWC code query value/,
        );
        return true;
      },
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
        assert.match(
          String(error.stderr),
          /examples\/demo\/\.next\/static\/chunks\/app\.js: OPENRECEIVE_NWC marker/,
        );
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("live NWC smoke reports canonical URI parse errors before wallet calls", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "openreceive-live-yml-"));
  const badNwc =
    "nostr+walletconnect://" +
    "a".repeat(64) +
    "?relay=wss%3A%2F%2Frelay.example.com&secret=not-secret";

  try {
    writeFileSync(path.join(dir, "openreceive.yml"), `OPENRECEIVE_NWC: ${JSON.stringify(badNwc)}\n`);

    assert.throws(
      () => runLiveNwcSmoke({}, { cwd: dir }),
      (error) => {
        assert.match(String(error.stderr), /NWC client secret must be 64 hex characters\./);
        assert.doesNotMatch(String(error.stderr), /not-secret/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("live NWC smoke loads openreceive.yml without leaking parse secrets", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "openreceive-live-yml-"));
  const badNwc =
    "nostr+walletconnect://" +
    "a".repeat(64) +
    "?relay=wss%3A%2F%2Frelay.example.com&secret=not-secret";

  try {
    writeFileSync(path.join(dir, "openreceive.yml"), `OPENRECEIVE_NWC: ${JSON.stringify(badNwc)}\n`);

    assert.throws(
      () =>
        runLiveNwcSmoke(
          {
            OPENRECEIVE_WALLET_PROFILE: "alby",
          },
          { cwd: dir },
        ),
      (error) => {
        assert.match(String(error.stderr), /NWC client secret must be 64 hex characters\./);
        assert.doesNotMatch(String(error.stderr), /not-secret/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Ruby live NWC smoke skips clearly when unset", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "openreceive-ruby-live-yml-"));
  try {
    assert.match(
      runRubyLiveNwcSmoke({}, { cwd: dir }),
      /OPENRECEIVE_NWC is not set in openreceive\.yml; skipping Ruby live NWC smoke test\./,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Ruby live NWC smoke redacts fake URI before skipping wallet calls", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "openreceive-ruby-live-yml-"));
  const uri = `nostr+walletconnect://${"a".repeat(64)}?relay=wss%3A%2F%2Frelay.example.com&secret=${"b".repeat(64)}`;
  try {
    writeFileSync(path.join(dir, "openreceive.yml"), `OPENRECEIVE_NWC: ${JSON.stringify(uri)}\n`);
    const output = runRubyLiveNwcSmoke(
      {
        OPENRECEIVE_RUBY_NWC_DISABLE_GEM: "1",
      },
      { cwd: dir },
    );

    assert.match(output, /Ruby NWC URI parsed for wallet profile: rizful/);
    assert.match(output, /Wallet pubkey prefix: aaaaaaaa\.\.\./);
    assert.match(output, /secret=\[REDACTED\]/);
    assert.match(output, /nwc-ruby gem is not installed; skipping live Ruby wallet calls/);
    assert.doesNotMatch(output, new RegExp("b".repeat(64)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
