#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";

const root = process.cwd();
const packageRoot = path.join(root, "packages/js");

const importChecks = {
  "@openreceive/browser": "typeof mod.createLightningUri === 'function'",
  "@openreceive/core": "typeof mod.createIdempotencyRequestHash === 'function'",
  "@openreceive/elements": "typeof mod.renderOpenReceiveCheckoutHtml === 'function'",
  "@openreceive/express": "typeof mod.createOpenReceiveExpressHandlers === 'function'",
  "@openreceive/node": "typeof mod.createAlbyNwcReceiveClient === 'function'",
  "@openreceive/provider-data": "typeof mod.getProviderRegistryMetadata === 'function'",
  "@openreceive/react": "typeof mod.createOpenReceiveCheckoutViewModel === 'function'",
  "@openreceive/testkit": "typeof mod.createTestkitReceiveClient === 'function'"
};

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function discoverWorkspacePackages() {
  return readdirSync(packageRoot)
    .map((entry) => path.join(packageRoot, entry))
    .filter((entryPath) => statSync(entryPath).isDirectory())
    .map((entryPath) => {
      const manifestPath = path.join(entryPath, "package.json");
      const manifest = readJson(manifestPath);
      return {
        dir: entryPath,
        manifest
      };
    })
    .filter(({ manifest }) => manifest.name?.startsWith("@openreceive/"))
    .sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));
}

function npmEnv(cacheDir) {
  return {
    ...process.env,
    npm_config_cache: cacheDir,
    npm_config_audit: "false",
    npm_config_fund: "false"
  };
}

function runNpm(args, cwd, cacheDir) {
  return execFileSync("npm", args, {
    cwd,
    env: npmEnv(cacheDir),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function walkFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...walkFiles(fullPath));
    } else if (stat.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function transpileTypeScript(source, fileName) {
  const result = ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
      verbatimModuleSyntax: true,
      rewriteRelativeImportExtensions: true
    },
    reportDiagnostics: true
  });

  const diagnostics = result.diagnostics ?? [];
  const errors = diagnostics.filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
  );
  if (errors.length > 0) {
    const formatted = ts.formatDiagnosticsWithColorAndContext(errors, {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: () => root,
      getNewLine: () => "\n"
    });
    throw new Error(formatted);
  }

  return result.outputText;
}

function buildPackageArtifact(pkg, artifactRoot) {
  const packageDirName = path.basename(pkg.dir);
  const artifactDir = path.join(artifactRoot, packageDirName);
  const sourceDir = path.join(pkg.dir, "src");
  const distDir = path.join(artifactDir, "dist");
  mkdirSync(distDir, { recursive: true });

  const manifest = {
    ...pkg.manifest,
    exports: {
      ".": "./dist/index.js"
    },
    files: ["dist"]
  };
  writeFileSync(
    path.join(artifactDir, "package.json"),
    JSON.stringify(manifest, null, 2)
  );

  for (const file of walkFiles(sourceDir)) {
    const relativePath = path.relative(sourceDir, file);
    const outputRelativePath = relativePath.endsWith(".ts")
      ? relativePath.replace(/\.ts$/, ".js")
      : relativePath;
    const outputPath = path.join(distDir, outputRelativePath);
    mkdirSync(path.dirname(outputPath), { recursive: true });

    if (relativePath.endsWith(".ts")) {
      writeFileSync(
        outputPath,
        transpileTypeScript(readFileSync(file, "utf8"), file)
      );
    } else {
      copyFileSync(file, outputPath);
    }
  }

  return artifactDir;
}

function packPackageArtifact(pkg, artifactRoot, tarballDir, cacheDir) {
  const artifactDir = buildPackageArtifact(pkg, artifactRoot);
  const output = runNpm(
    ["pack", artifactDir, "--pack-destination", tarballDir, "--json"],
    root,
    cacheDir
  );
  const [packed] = JSON.parse(output);
  assert(packed?.filename, `${pkg.manifest.name}: npm pack did not return a filename`);
  return path.join(tarballDir, packed.filename);
}

function localPackageDependency(packageName) {
  const packageJson = path.join(root, "node_modules", packageName, "package.json");
  if (statSync(packageJson, { throwIfNoEntry: false }) === undefined) {
    throw new Error(
      `${packageName} is required for package smoke imports. Run npm install in the repo first.`
    );
  }
  return `file:${path.join(root, "node_modules", packageName)}`;
}

function writeInstallProject(installDir, tarballs) {
  const dependencies = Object.fromEntries(
    tarballs.map(({ name, tarball }) => [name, `file:${tarball}`])
  );

  dependencies.react = localPackageDependency("react");

  writeFileSync(
    path.join(installDir, "package.json"),
    JSON.stringify(
      {
        name: "openreceive-package-smoke",
        private: true,
        type: "module",
        dependencies
      },
      null,
      2
    )
  );
}

function writeImportSmoke(installDir, packages) {
  const checks = packages.map(({ manifest }) => {
    const check = importChecks[manifest.name];
    assert(check !== undefined, `${manifest.name}: missing package smoke import check`);
    return {
      name: manifest.name,
      check
    };
  });

  writeFileSync(
    path.join(installDir, "smoke.mjs"),
    `import assert from "node:assert/strict";

const checks = ${JSON.stringify(checks, null, 2)};

for (const item of checks) {
  const mod = await import(item.name);
  assert(
    Function("mod", \`return \${item.check};\`)(mod),
    \`\${item.name}: import check failed\`
  );
}

console.log(\`Imported \${checks.length} OpenReceive package tarballs.\`);
`
  );
}

function runImportSmoke(installDir) {
  return execFileSync(process.execPath, ["smoke.mjs"], {
    cwd: installDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function main() {
  const packages = discoverWorkspacePackages();
  assert(packages.length > 0, "No OpenReceive workspace packages found.");

  const workspaceNames = new Set(packages.map(({ manifest }) => manifest.name));
  for (const pkg of packages) {
    assert(pkg.manifest.exports?.["."], `${pkg.manifest.name}: package export is required`);
    for (const [dependency, version] of Object.entries(pkg.manifest.dependencies ?? {})) {
      if (dependency.startsWith("@openreceive/")) {
        assert(workspaceNames.has(dependency), `${pkg.manifest.name}: unknown workspace dependency ${dependency}`);
        assert(version === pkg.manifest.version, `${pkg.manifest.name}: ${dependency} version must match package version`);
      }
    }
  }

  const tempRoot = mkdtempSync(path.join(tmpdir(), "openreceive-package-smoke-"));
  const artifactRoot = path.join(tempRoot, "artifacts");
  const tarballDir = path.join(tempRoot, "tarballs");
  const installDir = path.join(tempRoot, "install");
  const cacheDir = path.join(tempRoot, "npm-cache");
  mkdirSync(artifactRoot);
  mkdirSync(tarballDir);
  mkdirSync(installDir);
  mkdirSync(cacheDir);

  try {
    const tarballs = packages.map((pkg) => ({
      name: pkg.manifest.name,
      tarball: packPackageArtifact(pkg, artifactRoot, tarballDir, cacheDir)
    }));

    writeInstallProject(installDir, tarballs);
    runNpm(
      [
        "install",
        "--ignore-scripts",
        "--legacy-peer-deps",
        "--package-lock=false"
      ],
      installDir,
      cacheDir
    );
    writeImportSmoke(installDir, packages);
    const output = runImportSmoke(installDir);
    process.stdout.write(output);
    console.log(`Package smoke passed for ${packages.length} package(s).`);
  } finally {
    if (process.env.OPENRECEIVE_KEEP_PACKAGE_SMOKE !== "1") {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
