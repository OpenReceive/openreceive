import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkStoreModule,
  descriptionProblems,
  ODOO_SERIES,
  publishTrees,
  seriesManifest,
  writeStoreTree,
} from "../tools/release/odoo-apps.mjs";
import { root } from "../tools/shared/root.mjs";

const moduleDir = path.join(root, "packages/python/odoo/payment_openreceive");
const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version.split(
  "-",
)[0];

test("the Odoo module's store page follows the Odoo Apps rules", () => {
  // Icon, cover image, license, and an index.html that links only where the
  // store keeps links and runs no JavaScript.
  const manifest = checkStoreModule(moduleDir);
  assert.match(manifest, /"name": "Payment Provider: OpenReceive"/);
  const html = readFileSync(path.join(moduleDir, "static/description/index.html"), "utf8");
  assert.match(html, new RegExp(`pip install openreceive==${version.replaceAll(".", "\\.")}<`));
});

test("the store page check refuses outside links and scripts, and keeps the allowed ones", () => {
  assert.deepEqual(
    descriptionProblems(
      '<img src="cover.png"/><a href="mailto:info@openreceive.org">mail</a>' +
        '<a href="https://www.youtube.com/watch?v=x">video</a>',
    ),
    [],
  );
  assert.deepEqual(descriptionProblems('<a href="https://openreceive.org/guides">guide</a>'), [
    "href to https://openreceive.org/guides",
  ]);
  assert.deepEqual(descriptionProblems('<img src="//cdn.example/x.png"/>'), [
    "src to //cdn.example/x.png",
  ]);
  assert.deepEqual(descriptionProblems("<script>alert(1)</script>"), ["a <script> tag"]);
  assert.deepEqual(descriptionProblems('<div onclick="x()"></div>'), ["an inline event handler"]);
});

test("each store branch carries the module's version under its Odoo series", () => {
  const manifest = '{\n    "name": "X",\n    "version": "1.2.3",\n}\n';
  assert.match(seriesManifest(manifest, "19.0", "1.2.3"), /"version": "19\.0\.1\.2\.3"/);
  assert.throws(() => seriesManifest(manifest, "19.0", "1.2.4"), /exactly once/);
});

test("publishing pushes one branch per series and skips a branch already up to date", (t) => {
  const work = mkdtempSync(path.join(tmpdir(), "odoo-apps-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const remote = path.join(work, "remote.git");
  execFileSync("git", ["init", "--quiet", "--bare", remote]);
  const module = path.join(work, "module");
  mkdirSync(path.join(module, "static/description"), { recursive: true });
  writeFileSync(path.join(module, "__manifest__.py"), '{"version": "1.2.3"}\n');
  for (const series of ODOO_SERIES)
    writeStoreTree(module, path.join(work, series), series, "1.2.3");
  const identity = { name: "Test", email: "test@example.invalid" };

  publishTrees({ version: "1.2.3", work, remote, identity });
  for (const series of ODOO_SERIES) {
    const files = execFileSync(
      "git",
      ["--git-dir", remote, "ls-tree", "-r", "--name-only", series],
      {
        encoding: "utf8",
      },
    )
      .trim()
      .split("\n");
    assert.deepEqual(files.sort(), [
      "LICENSE",
      "README.md",
      "payment_openreceive/__manifest__.py",
      "requirements.txt",
    ]);
    const manifest = execFileSync(
      "git",
      ["--git-dir", remote, "show", `${series}:payment_openreceive/__manifest__.py`],
      { encoding: "utf8" },
    );
    assert.equal(manifest, `{"version": "${series}.1.2.3"}\n`);
    assert.equal(
      execFileSync("git", ["--git-dir", remote, "show", `${series}:requirements.txt`], {
        encoding: "utf8",
      }),
      "openreceive==1.2.3\n",
    );
  }

  const head = () =>
    execFileSync("git", ["--git-dir", remote, "rev-parse", ODOO_SERIES[0]], {
      encoding: "utf8",
    }).trim();
  const before = head();
  publishTrees({ version: "1.2.3", work, remote, identity });
  assert.equal(head(), before, "an unchanged branch gets no new commit");

  writeFileSync(path.join(module, "__manifest__.py"), '{"version": "1.2.4"}\n');
  for (const series of ODOO_SERIES)
    writeStoreTree(module, path.join(work, series), series, "1.2.4");
  publishTrees({ version: "1.2.4", work, remote, identity });
  const log = execFileSync("git", ["--git-dir", remote, "log", "--format=%s", ODOO_SERIES[0]], {
    encoding: "utf8",
  });
  assert.deepEqual(log.trim().split("\n"), [
    `OpenReceive 1.2.4 for Odoo ${ODOO_SERIES[0]}`,
    `OpenReceive 1.2.3 for Odoo ${ODOO_SERIES[0]}`,
  ]);
});
