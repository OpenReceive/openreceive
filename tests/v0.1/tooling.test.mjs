import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const secretScanner = path.join(process.cwd(), "tools/validate/scan-secrets.mjs");
const clientBundleScanner = path.join(process.cwd(), "tools/validate/scan-client-bundles.mjs");
const liveNwcSmoke = path.join(process.cwd(), "tools/live-nwc-test/index.mjs");

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
        assert.match(String(error.stderr), /examples\/demo\/dist\/assets\/app\.js: NWC secret query value/);
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
