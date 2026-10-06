import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../packages/js/node/src/cli.ts";

test("skills install replaces both skills, preserves unrelated skills, and respects --dir", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "openreceive-skills-"));
  try {
    for (const dir of [".agents/skills", ".claude/skills", path.join(cwd, "absolute skills")]) {
      const target = path.resolve(cwd, dir);
      mkdirSync(path.join(target, "other"), { recursive: true });
      writeFileSync(path.join(target, "other/SKILL.md"), "keep");
      let out = "";
      const options = {
        argv: ["skills", "install", ...(dir === ".agents/skills" ? [] : ["--dir", dir])],
        cwd,
        stdout: {
          write: (text) => {
            out += text;
          },
        },
        stderr: { write: (text) => assert.fail(text) },
      };
      assert.equal(await runCli(options), 0);
      for (const name of ["integrate-openreceive", "debug-openreceive-payment"]) {
        const destination = path.join(target, name);
        assert.equal(
          readFileSync(path.join(destination, "SKILL.md"), "utf8"),
          readFileSync(new URL(`../skills/${name}/SKILL.md`, import.meta.url), "utf8"),
        );
        writeFileSync(path.join(destination, "obsolete.md"), "old");
        writeFileSync(path.join(destination, "SKILL.md"), "old");
        assert.ok(out.includes(destination));
      }
      assert.equal(await runCli(options), 0);
      assert.equal(readFileSync(path.join(target, "other/SKILL.md"), "utf8"), "keep");
      for (const name of ["integrate-openreceive", "debug-openreceive-payment"]) {
        assert.equal(existsSync(path.join(target, name, "obsolete.md")), false);
        assert.notEqual(readFileSync(path.join(target, name, "SKILL.md"), "utf8"), "old");
      }
      assert.ok(existsSync(path.join(target, "integrate-openreceive/references/fastapi.md")));
      assert.match(out, /--dir .claude\/skills/);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("skills install rejects invalid arguments before writing", async () => {
  for (const argv of [["skills"], ["skills", "remove"], ["skills", "install", "--dir"]]) {
    let error = "";
    assert.equal(
      await runCli({
        argv,
        stderr: {
          write: (text) => {
            error += text;
          },
        },
      }),
      1,
    );
    assert.match(error, /Usage:/);
  }
});
