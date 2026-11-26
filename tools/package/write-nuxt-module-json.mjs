#!/usr/bin/env node

// dist/module.json for @openreceive/nuxt, in the shape @nuxt/module-builder
// writes: the module's meta plus the package version. The Nuxt modules
// directory (github.com/nuxt/modules) reads this file from the published
// package for the listing's compatibility range and its docs link, and
// `nuxi module add` reads the same list. Run from packages/js/nuxt after tsup.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const packageDir = process.cwd();
const manifest = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
const { default: nuxtModule } = await import(
  pathToFileURL(path.join(packageDir, "dist", "module.js")).href
);
const meta = await nuxtModule.getMeta();
for (const field of ["name", "configKey", "compatibility", "docs"]) {
  if (meta[field] === undefined) {
    console.error(`write-nuxt-module-json.mjs: the module's meta has no ${field}`);
    process.exit(1);
  }
}
if (meta.name !== manifest.name) {
  console.error(`write-nuxt-module-json.mjs: meta.name ${meta.name} is not ${manifest.name}`);
  process.exit(1);
}
const moduleJson = {
  name: meta.name,
  configKey: meta.configKey,
  compatibility: meta.compatibility,
  docs: meta.docs,
  version: manifest.version,
};
writeFileSync(
  path.join(packageDir, "dist", "module.json"),
  `${JSON.stringify(moduleJson, null, 2)}\n`,
);
