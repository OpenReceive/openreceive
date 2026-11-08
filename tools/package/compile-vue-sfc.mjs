#!/usr/bin/env node

// Compiles a Vue single-file component into a plain ES module at package build
// time, so the shop's bundler never compiles our SFC.
//
// @openreceive/vue's Checkout.vue derives its props from an imported type
// (`defineProps<WrapperCheckoutComponentProps>()`). Turning that type into
// runtime props means resolving it across files and packages, which
// @vue/compiler-sfc only does with TypeScript loaded. Shipped as source, the
// SFC made every shop's build do that resolution: a JavaScript-only Vue or Nuxt
// app failed with "Failed to load TypeScript", and one on TypeScript 7 failed
// with "No fs option provided to compileScript". Here the resolution runs once,
// against this repo's own TypeScript and tsconfig paths, and the output carries
// runtime prop declarations and an inlined render function: any Vue 3 build
// (Vite, Nuxt, webpack) imports it like any other JavaScript module.
//
// Usage: compile-vue-sfc.mjs <source.vue> <out.js>

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const [sourceArg, outArg] = process.argv.slice(2);
if (sourceArg === undefined || outArg === undefined) {
  console.error("Usage: compile-vue-sfc.mjs <source.vue> <out.js>");
  process.exit(1);
}

const require = createRequire(import.meta.url);
// vue is the package's peer, so the workspace install always has its compiler.
const { compileScript, parse, registerTS } = require("vue/compiler-sfc");
const ts = require("typescript");

function fail(message) {
  console.error(`compile-vue-sfc.mjs: ${message}`);
  process.exit(1);
}

const source = path.resolve(sourceArg);
const out = path.resolve(outArg);
const name = path.basename(source, ".vue");

const { descriptor, errors } = parse(readFileSync(source, "utf8"), { filename: source });
if (errors.length > 0) fail(`${source} does not parse: ${errors.map((e) => e.message).join("; ")}`);
if (descriptor.scriptSetup === null || descriptor.template === null) {
  fail(`${source} needs a <script setup> block and a <template>`);
}
// The styles ship as the package's styles.css; a <style> block would be dropped here.
if (descriptor.styles.length > 0 || descriptor.customBlocks.length > 0) {
  fail(`${source} has blocks this build does not emit (move styles into styles.css)`);
}

registerTS(() => ts);
const script = compileScript(descriptor, {
  // Only scoped CSS and CSS v-bind use the id; a fixed one keeps the output reproducible.
  id: `openreceive-${name.toLowerCase()}`,
  inlineTemplate: true,
  // Development output keeps each prop's runtime type, so Vue's dev build still
  // warns about a wrong prop type; Vue's production build skips the checks.
  isProd: false,
});

const { outputText, diagnostics } = ts.transpileModule(script.content, {
  fileName: `${name}.ts`,
  reportDiagnostics: true,
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    removeComments: false,
  },
});
if (diagnostics?.length) {
  fail(diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("; "));
}

// The whole point: no compiler macro, and so no type to resolve, is left.
const macro = /\b(defineProps|withDefaults|defineOptions|defineEmits|defineModel)\s*[<(]/.exec(
  outputText,
);
if (macro !== null) fail(`compiled ${name} still calls the ${macro[1]} macro`);
if (!/\bprops: \{/.test(outputText)) fail(`compiled ${name} declares no runtime props`);

mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(
  out,
  `// Compiled from src/${name}.vue by tools/package/compile-vue-sfc.mjs: runtime\n` +
    "// props and an inlined render function, so no consumer compiles the SFC.\n" +
    outputText,
);
