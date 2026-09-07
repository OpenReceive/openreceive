#!/usr/bin/env node

// Gate for the standalone checkout build (tools/package/build-standalone-
// elements.mjs, plan A5). Runs in test:ci:release right after
// scan:client-bundles, once build:packages has emitted
// packages/js/elements/dist/standalone/. It re-verifies the tree from the
// files alone, so the same checks can later run against a copy a WordPress zip
// or a Django wheel carries:
//
//   - the directory and its fixed entries exist (no assets/ tree: every image
//     the checkout draws is inside the JS);
//   - the JS is one self-contained module: no import/export-from specifiers,
//     no CommonJS require(), and it registers <openreceive-checkout>;
//   - MANIFEST.json names every file on disk (and nothing else), every hash
//     and size match, and its version is the workspace version;
//   - the receive-only secret markers scan:client-bundles applies to the demo
//     bundles find nothing in the emitted text files (markers are skipped in
//     the source map, exactly as there — the map inlines @openreceive/core
//     source that legitimately names NWC_URI_PROTOCOL).

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  findModuleImportSpecifiers,
  readWorkspaceVersion,
  sha256,
  STANDALONE_CSS_FILE,
  STANDALONE_ELEMENT_TAG_NAME,
  STANDALONE_JS_FILE,
  STANDALONE_MANIFEST_FILE,
  STANDALONE_PACKAGE_NAME,
  standalonePaths,
} from "../package/build-standalone-elements.mjs";
import { root } from "../shared/root.mjs";
import { walkFiles } from "../shared/walk-files.mjs";
import { forbiddenPatterns } from "./scan-client-bundles.mjs";

const findings = [];
function fail(message) {
  findings.push(message);
}

const { outDir } = standalonePaths(root);
const relativeOutDir = path.relative(root, outDir);

if (!existsSync(outDir) || !statSync(outDir).isDirectory()) {
  console.error(
    `check:standalone: ${relativeOutDir} is missing. Run \`npm run build:packages\` first ` +
      "(its last step is tools/package/build-standalone-elements.mjs).",
  );
  process.exit(1);
}

const jsPath = path.join(outDir, STANDALONE_JS_FILE);
const cssPath = path.join(outDir, STANDALONE_CSS_FILE);
const manifestPath = path.join(outDir, STANDALONE_MANIFEST_FILE);

for (const filePath of [jsPath, cssPath, manifestPath]) {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    fail(`${relativeOutDir}/${path.basename(filePath)}: expected file is missing`);
  }
}
if (existsSync(path.join(outDir, "assets"))) {
  fail(
    `${relativeOutDir}/assets: must not exist — every image the checkout draws ships inside ${STANDALONE_JS_FILE}`,
  );
}

// --- the module is one self-contained file --------------------------------
if (existsSync(jsPath)) {
  const js = readFileSync(jsPath, "utf8");
  const specifiers = findModuleImportSpecifiers(js);
  if (specifiers.length > 0) {
    fail(
      `${STANDALONE_JS_FILE}: must not import anything at runtime, found ` +
        `${specifiers.map((s) => JSON.stringify(s)).join(", ")} — every @openreceive/* dependency ` +
        "and the tsup chunk have to be inlined.",
    );
  }
  if (/\brequire\s*\(/.test(js)) {
    fail(`${STANDALONE_JS_FILE}: contains a CommonJS require() call; the file must be pure ESM.`);
  }
  // defineElements() registers through `registry.define` on
  // `options.registry ?? globalThis.customElements`, so the literal text
  // "customElements.define" never appears; assert the two halves instead.
  if (!/\bcustomElements\b/.test(js) || !/\.define\s*\(/.test(js)) {
    fail(
      `${STANDALONE_JS_FILE}: does not register a custom element (no customElements / .define( reference).`,
    );
  }
  if (!js.includes(`"${STANDALONE_ELEMENT_TAG_NAME}"`)) {
    fail(`${STANDALONE_JS_FILE}: does not name the <${STANDALONE_ELEMENT_TAG_NAME}> tag.`);
  }
  if (!/\bdefineElements\s*\(\s*\)/.test(js)) {
    fail(
      `${STANDALONE_JS_FILE}: must call defineElements() on load so a plain <script type="module"> registers the element.`,
    );
  }
  if (!/^\/\/# sourceMappingURL=/m.test(js) || !existsSync(`${jsPath}.map`)) {
    fail(`${STANDALONE_JS_FILE}: expected a sourceMappingURL comment and a sibling .map file.`);
  }
  // Every image the checkout draws is inside the file: the wallet logos and
  // the pay tutorials (provider-data's lazy chunk, inlined by esbuild).
  if (
    !js.includes('"assets/provider-icons/strike.webp":"data:image/webp;base64,') ||
    !js.includes('"assets/pay_tutorials/kraken-4.webp":"data:image/webp;base64,')
  ) {
    fail(
      `${STANDALONE_JS_FILE}: the wallet logos and pay tutorials must be inlined as data: URIs.`,
    );
  }
}

// --- MANIFEST.json matches the tree and the workspace version -------------
if (existsSync(manifestPath)) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(`${STANDALONE_MANIFEST_FILE}: not valid JSON (${error.message})`);
  }
  if (manifest !== undefined) {
    const version = readWorkspaceVersion(root);
    if (manifest.package !== STANDALONE_PACKAGE_NAME) {
      fail(
        `${STANDALONE_MANIFEST_FILE}: package is ${JSON.stringify(manifest.package)}, expected ${STANDALONE_PACKAGE_NAME}`,
      );
    }
    if (manifest.version !== version) {
      fail(
        `${STANDALONE_MANIFEST_FILE}: version ${JSON.stringify(manifest.version)} does not match ` +
          `package.json ${version} — the standalone build is stale; rerun npm run build:packages.`,
      );
    }
    const listed = manifest.files ?? {};
    const onDisk = new Map(
      walkFiles(outDir)
        .map((file) => path.relative(outDir, file).split(path.sep).join("/"))
        .filter((relative) => relative !== STANDALONE_MANIFEST_FILE)
        .map((relative) => [relative, path.join(outDir, relative)]),
    );
    for (const relative of onDisk.keys()) {
      if (listed[relative] === undefined) {
        fail(`${STANDALONE_MANIFEST_FILE}: ${relative} is on disk but not listed`);
      }
    }
    for (const [relative, entry] of Object.entries(listed)) {
      const filePath = onDisk.get(relative);
      if (filePath === undefined) {
        fail(`${STANDALONE_MANIFEST_FILE}: ${relative} is listed but missing on disk`);
        continue;
      }
      const bytes = readFileSync(filePath);
      if (entry.bytes !== bytes.length) {
        fail(
          `${STANDALONE_MANIFEST_FILE}: ${relative} is ${bytes.length} bytes, manifest says ${entry.bytes}`,
        );
      }
      const digest = sha256(bytes);
      if (entry.sha256 !== digest) {
        fail(
          `${STANDALONE_MANIFEST_FILE}: ${relative} sha256 ${digest} != manifest ${entry.sha256}`,
        );
      }
    }
    for (const required of [STANDALONE_JS_FILE, `${STANDALONE_JS_FILE}.map`, STANDALONE_CSS_FILE]) {
      if (listed[required] === undefined) {
        fail(`${STANDALONE_MANIFEST_FILE}: ${required} must be listed`);
      }
    }
  }
}

// --- consumer copies: the Django app's static tree, when present ------------
// packages/python/openreceive/hatch_build.py copies dist/standalone into
// src/openreceive/django/static/openreceive/ at build time (gitignored; the
// wheel carries it). A copy that exists must be THIS build, file for file.
const pythonStaticCopy = path.join(
  root,
  "packages/python/openreceive/src/openreceive/django/static/openreceive",
);
if (existsSync(pythonStaticCopy) && existsSync(manifestPath)) {
  const copyLabel = path.relative(root, pythonStaticCopy);
  const copyManifestPath = path.join(pythonStaticCopy, STANDALONE_MANIFEST_FILE);
  if (!existsSync(copyManifestPath)) {
    fail(
      `${copyLabel}: missing ${STANDALONE_MANIFEST_FILE} — rerun npm run build:packages, then uv sync/uv build`,
    );
  } else if (readFileSync(copyManifestPath, "utf8") !== readFileSync(manifestPath, "utf8")) {
    fail(
      `${copyLabel}/${STANDALONE_MANIFEST_FILE} differs from the standalone build — the Python copy is stale; ` +
        "rerun uv sync (or uv build) in packages/python/openreceive after npm run build:packages.",
    );
  } else {
    for (const relative of walkFiles(pythonStaticCopy).map((file) =>
      path.relative(pythonStaticCopy, file).split(path.sep).join("/"),
    )) {
      if (relative === STANDALONE_MANIFEST_FILE) continue;
      const source = path.join(outDir, relative);
      if (!existsSync(source)) {
        fail(`${copyLabel}: ${relative} is not in the standalone build`);
        continue;
      }
      if (
        sha256(readFileSync(path.join(pythonStaticCopy, relative))) !== sha256(readFileSync(source))
      ) {
        fail(`${copyLabel}: ${relative} differs from the standalone build`);
      }
    }
  }
}

// --- receive-only secret markers, same list as scan:client-bundles --------
const textFiles = walkFiles(outDir, {
  filter: (name) => /\.(?:js|map|css|json)$/.test(name),
});
for (const file of textFiles) {
  const text = readFileSync(file, "utf8");
  const isSourceMap = file.endsWith(".map");
  for (const check of forbiddenPatterns) {
    if (isSourceMap && check.kind === "marker") continue;
    if (check.pattern.test(text)) {
      fail(
        `${path.relative(outDir, file)}: ${check.name} (${check.kind}) found in the standalone build`,
      );
    }
  }
}

if (findings.length > 0) {
  console.error(`check:standalone failed for ${relativeOutDir}:`);
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

const size = statSync(jsPath).size;
console.log(
  `check:standalone: ${relativeOutDir} is self-contained (${STANDALONE_JS_FILE} ${size} bytes, ` +
    `${textFiles.length} text files scanned, manifest matches ${readWorkspaceVersion(root)}).`,
);
