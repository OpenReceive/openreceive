import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const builder = fileURLToPath(new URL("../tools/docs/build-index.mjs", import.meta.url));
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "openreceive-docs-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const tree of ["agents", "guides", "internal", "recipes"])
    mkdirSync(path.join(root, "docs", tree), { recursive: true });
  const write = (file, content) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  };
  const docs = [
    {
      slug: "start",
      title: "Start",
      source_path: "docs/guides/start.md",
      category: "guide",
      audience: "developer",
      public: true,
    },
    {
      slug: "agent-directions-node",
      title: "Node",
      source_path: "docs/agents/node.md",
      category: "agents",
      audience: "developer",
      public: true,
    },
    {
      slug: "private",
      title: "Internal",
      source_path: "docs/internal/private.md",
      category: "internal",
      audience: "contributor",
      public: false,
    },
  ];
  for (const doc of docs)
    write(
      doc.source_path,
      `# ${doc.title}\n\n${doc.public ? "Public text" : "INTERNAL_CONTENT_MUST_NOT_SHIP"}\n`,
    );
  write("packages/plugin/README.md", "# Plugin\n\nPlugin installation instructions\n");
  write("docs/assets/picture.png", Buffer.from([1, 2, 3]));
  write("spec/openapi.yaml", "openapi: 3.1.0\n");
  write("docs/manifest.json", JSON.stringify({ version: "1", docs }));
  const contract = {
    contract_version: 6,
    release_version: "0.4.5",
    publish: [
      {
        path: "/guides/start",
        markdown_path: "/guides/start.md",
        source: docs[0].source_path,
        slug: "start",
        title: "Start",
        category: "guide",
      },
      { path: "/agent-directions/node.md", source: docs[1].source_path, copy_button: true },
      {
        path: "/plugin",
        markdown_path: "/plugin.md",
        source: "packages/plugin/README.md",
        slug: "plugin",
        title: "Plugin",
        category: "plugin",
      },
    ],
    assets: [{ path: "/assets/picture.png", source: "docs/assets/picture.png" }],
    agent_discovery: { artifacts: [{ path: "/openapi.yaml", source: "spec/openapi.yaml" }] },
    never_publish: [{ source: docs[2].source_path }],
  };
  const run = () => {
    write("docs/site-contract.json", JSON.stringify(contract));
    return spawnSync(process.execPath, [builder], { cwd: root, encoding: "utf8" });
  };
  return { root, contract, run };
}

test("docs archive contains every public source byte and a public-only search index", (t) => {
  const { root, run } = fixture(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const archive = path.join(root, "dist/openreceive-docs-0.4.5.tar.gz");
  const extracted = path.join(root, "extracted");
  mkdirSync(extracted);
  execFileSync("tar", ["-xzf", archive, "-C", extracted]);
  const metadata = JSON.parse(readFileSync(path.join(extracted, "bundle.json")));
  assert.equal(metadata.bundle_version, 1);
  assert.equal(metadata.release_version, "0.4.5");
  assert.equal(metadata.files.length, 7);
  for (const file of metadata.files) {
    const bytes = readFileSync(path.join(extracted, file.path));
    assert.equal(bytes.length, file.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
    if (file.path.startsWith("sources/"))
      assert.deepEqual(bytes, readFileSync(path.join(root, file.path.slice(8))));
  }
  const index = JSON.parse(readFileSync(path.join(extracted, "public-search-index.json")));
  assert.deepEqual(
    index.docs.map((doc) => doc.path),
    ["/guides/start", "/plugin"],
  );
  assert.doesNotMatch(JSON.stringify(index), /INTERNAL_CONTENT/);
  assert.equal(existsSync(path.join(extracted, "sources/docs/internal")), false);
  assert.equal(existsSync(path.join(extracted, "search-index.json")), false);
  assert.equal(existsSync(path.join(extracted, "manifest.json")), false);
});

test("missing assets and internal publish entries stop the docs archive build", (t) => {
  const missing = fixture(t);
  assert.equal(missing.run().status, 0);
  missing.contract.assets[0].source = "docs/assets/missing.png";
  assert.notEqual(missing.run().status, 0);
  assert.equal(existsSync(path.join(missing.root, "dist/openreceive-docs-0.4.5.tar.gz")), false);
  const internal = fixture(t);
  internal.contract.publish.push({
    path: "/oops",
    source: "docs/internal/private.md",
    copy_button: true,
  });
  const result = internal.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /internal document cannot enter the public bundle/);
  assert.equal(existsSync(path.join(internal.root, "dist/openreceive-docs-0.4.5.tar.gz")), false);
});
