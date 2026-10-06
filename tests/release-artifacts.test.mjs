import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { assertReleaseAssets, releaseArtifacts } from "../tools/release/github-artifacts.mjs";

test("general release requires every public platform, including matching WordPress ZIP", () => {
  const names = releaseArtifacts("1.2.3", "1.2.3").map((file) => path.basename(file));
  assert.equal(names.length, 22);
  assert.doesNotThrow(() => assertReleaseAssets("1.2.3", names, "1.2.3"));
  for (const omitted of names) {
    assert.throws(
      () =>
        assertReleaseAssets(
          "1.2.3",
          names.filter((name) => name !== omitted),
          "1.2.3",
        ),
      /Incomplete release/,
    );
  }
  assert.throws(
    () =>
      assertReleaseAssets(
        "1.2.3",
        names.filter((name) => !name.endsWith(".zip")).concat("openreceive-wordpress-1.2.2.zip"),
        "1.2.3",
      ),
    /wordpress-1.2.3.zip/,
  );
  assert(!names.some((name) => /btcpay|testkit/i.test(name)));
});
test("artifact filenames use each registry's prerelease version", () => {
  const files = releaseArtifacts("1.2.3-alpha.1", "1.2.3.pre.alpha.1");
  assert(files.some((file) => file.endsWith("openreceive-1.2.3.pre.alpha.1.gem")));
  assert(files.some((file) => file.endsWith("openreceive-1.2.3a1-py3-none-any.whl")));
  assert(files.some((file) => file.endsWith("openreceive-wordpress-1.2.3-alpha.1.zip")));
});
