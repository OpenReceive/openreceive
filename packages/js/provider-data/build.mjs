#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const sourceDir = path.join(packageRoot, "src");
const distDir = path.join(packageRoot, "dist");
const entrypoints = ["index.ts", "provider-icons.ts", "pay-tutorials.ts"];

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

for (const entrypoint of entrypoints) {
  emitJavaScript(path.join(sourceDir, entrypoint), "esm");
  emitJavaScript(path.join(sourceDir, entrypoint), "cjs");
}

emitDeclarations();
copyStaticAssets();

function emitJavaScript(filePath, format) {
  const relativePath = path.relative(sourceDir, filePath);
  const outFile = path.join(
    distDir,
    relativePath.replace(/\.ts$/, format === "esm" ? ".js" : ".cjs")
  );
  mkdirSync(path.dirname(outFile), { recursive: true });

  const result = ts.transpileModule(inlineJsonImportAttributes(readFileSync(filePath, "utf8"), filePath), {
    fileName: filePath,
    compilerOptions: {
      module: format === "esm" ? ts.ModuleKind.ESNext : ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: format === "esm",
      rewriteRelativeImportExtensions: true
    },
    reportDiagnostics: true
  });
  throwOnErrors(result.diagnostics ?? [], `${relativePath} ${format} emit failed`);

  const outputText = format === "esm"
    ? result.outputText
    : rewriteCommonJsOutput(result.outputText, relativePath);
  writeFileSync(outFile, outputText);
}

function emitDeclarations() {
  const options = {
    allowImportingTsExtensions: true,
    declaration: true,
    emitDeclarationOnly: true,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    outDir: distDir,
    resolveJsonModule: true,
    rootDir: sourceDir,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2022
  };
  const host = ts.createCompilerHost(options);
  const files = entrypoints.map((entrypoint) => path.join(sourceDir, entrypoint));
  const program = ts.createProgram(files, options, host);
  const result = program.emit();
  const diagnostics = ts.getPreEmitDiagnostics(program).concat(result.diagnostics);
  throwOnErrors(diagnostics, "declaration emit failed");

  for (const declaration of entrypoints.map((entrypoint) => path.join(distDir, entrypoint.replace(/\.ts$/, ".d.ts")))) {
    writeFileSync(
      declaration,
      readFileSync(declaration, "utf8").replace(/(["'])(\.\/[^"']+)\.ts\1/g, "$1$2.js$1")
    );
  }
}

function copyStaticAssets() {
  copyFileSync(
    path.join(sourceDir, "data", "openreceive-providers.v4.json"),
    path.join(distDir, "openreceive-providers.v4.json")
  );
  copyDirectory(
    path.join(sourceDir, "assets", "provider-icons"),
    path.join(distDir, "assets", "provider-icons")
  );
  copyDirectory(
    path.join(sourceDir, "assets", "pay_tutorials"),
    path.join(distDir, "assets", "pay_tutorials")
  );
}

function copyDirectory(source, destination) {
  if (!existsSync(source)) return;
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source)) {
    const sourcePath = path.join(source, entry);
    const targetPath = path.join(destination, entry);
    if (statSync(sourcePath).isDirectory()) {
      copyDirectory(sourcePath, targetPath);
    } else {
      copyFileSync(sourcePath, targetPath);
    }
  }
}

function inlineJsonImportAttributes(source, fileName) {
  const jsonImportPattern =
    /^import\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+\.json)["']\s+with\s+\{\s*type:\s*["']json["']\s*\};/gm;
  const requireForSource = createRequire(fileName);

  return source.replace(jsonImportPattern, (_match, binding, specifier) => {
    const jsonPath = requireForSource.resolve(specifier);
    const json = JSON.parse(readFileSync(jsonPath, "utf8"));
    return `const ${binding} = ${JSON.stringify(json)};`;
  });
}

function rewriteCommonJsOutput(source, relativePath) {
  let output = source.replace(/require\("(\.\/[^"]+)\.js"\)/g, 'require("$1.cjs")');
  if (relativePath === "provider-icons.ts" || relativePath === "pay-tutorials.ts") {
    output = [
      'const { pathToFileURL } = require("node:url");',
      output.replace(/import\.meta\.url/g, "pathToFileURL(__filename).href")
    ].join("\n");
  }
  return output;
}

function throwOnErrors(diagnostics, label) {
  const errors = diagnostics.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length === 0) return;
  const formatted = ts.formatDiagnosticsWithColorAndContext(errors, {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: () => path.dirname(packageRoot),
    getNewLine: () => "\n"
  });
  throw new Error(`${label}\n${formatted}`);
}
