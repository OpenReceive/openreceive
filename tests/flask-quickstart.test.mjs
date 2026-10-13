import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Flask has no adapter package: people copy openreceive_flask.py out of the
// quickstart. The starter runs that file, so it must be the quickstart's
// bytes, or the example would prove code nobody is told to copy.
test("the Flask starter's openreceive_flask.py is the quickstart's copy, byte for byte", () => {
  const quickstart = readFileSync(
    new URL("../docs/guides/quickstart-flask.md", import.meta.url),
    "utf8",
  );
  const block = quickstart.match(/```python\n(# openreceive_flask\.py:[\s\S]*?)```/)?.[1];
  assert.ok(block, "docs/guides/quickstart-flask.md has no openreceive_flask.py block");
  const starter = readFileSync(
    new URL("../examples/flask-starter/openreceive_flask.py", import.meta.url),
    "utf8",
  );
  assert.equal(starter, block);
});
