import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("skills generator rejects an integration reference missing from the router", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "openreceive-skill-generator-"));
  try {
    for (const name of ["skills", "docs/agents", "docs/manifest.json"]) {
      const target = path.join(cwd, name);
      mkdirSync(path.dirname(target), { recursive: true });
      cpSync(new URL(`../${name}`, import.meta.url), target, { recursive: true });
    }
    const script = new URL("../tools/docs/generate-skills.mjs", import.meta.url);
    const generate = () =>
      spawnSync(process.execPath, [script.pathname], { cwd, encoding: "utf8" });
    let result = generate();
    assert.equal(result.status, 0, result.stderr);
    writeFileSync(
      path.join(cwd, "skills/integrate-openreceive/references/new-stack.md"),
      "A new stack",
    );
    result = generate();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not link references\/new-stack.md/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
