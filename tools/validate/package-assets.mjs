#!/usr/bin/env node

// Browser verification of extracted release artifacts, without workspace aliases,
// image loaders, asset copying, or an OpenReceive server. Requires Chromium;
// runs on the host or in Docker (the package-assets CI job uses Docker).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { build as esbuild } from "esbuild";
import { build as vite } from "vite";
import webpack from "webpack";
import { buildPackageTarballs, localPackageDirectory } from "../package/build-artifacts.mjs";

const root = process.cwd();
const artifacts = buildPackageTarballs({ root });
const fixture = path.join(artifacts.workspace.baseDir, "browser-install");
const publicDir = path.join(fixture, "public");
const prefix = "/shop/nested/checkout/";
let browser;
let server;

function write(file, content) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function html(script, css = "styles.css") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<link rel="stylesheet" href="./${css}"><title>Installed checkout assets</title></head>
<body><div id="react"></div>
<openreceive-checkout invoice="lnbc-package-assets" invoice-id="asset-test"
  amount-msats="21000" status="pending"></openreceive-checkout>
<script type="module" src="./${script}"></script></body></html>`;
}

async function buildFixtures() {
  write(path.join(fixture, "package.json"), '{"private":true,"type":"module"}');
  for (const { name, tarball } of artifacts.tarballs) {
    const destination = path.join(fixture, "node_modules", name);
    mkdirSync(destination, { recursive: true });
    execFileSync("tar", ["-xzf", tarball, "-C", destination, "--strip-components=1"]);
  }
  // Only third-party dependencies come from the development install.
  for (const name of ["qrcode", "react", "react-dom"]) {
    symlinkSync(localPackageDirectory(root, name), path.join(fixture, "node_modules", name));
  }
  copyFileSync(
    path.join(root, "tests/fixtures/package-assets/app.js"),
    path.join(fixture, "app.js"),
  );
  const css = path.join(fixture, "node_modules/@openreceive/elements/dist/styles.css");
  for (const splitting of [false, true]) {
    const name = splitting ? "esbuild-split" : "esbuild";
    const outdir = path.join(publicDir, name);
    // No splitting is the Rails quickstart's esbuild command.
    await esbuild({
      absWorkingDir: fixture,
      entryPoints: ["app.js"],
      outdir,
      bundle: true,
      format: "esm",
      splitting,
      minify: true,
      define: { "process.env.NODE_ENV": '"production"' },
    });
    copyFileSync(css, path.join(outdir, "styles.css"));
    write(path.join(outdir, "index.html"), html("app.js"));
  }
  write(path.join(fixture, "index.html"), html("app.js"));
  // CSS is copied as the documented stylesheet, not through an image plugin.
  copyFileSync(css, path.join(fixture, "styles.css"));
  await vite({
    configFile: false,
    root: fixture,
    publicDir: false,
    base: "./",
    logLevel: "warn",
    build: { outDir: path.join(publicDir, "vite"), emptyOutDir: true },
  });
  const webpackDir = path.join(publicDir, "webpack");
  await new Promise((resolve, reject) => {
    const compiler = webpack({
      mode: "production",
      context: fixture,
      entry: "./app.js",
      output: { path: webpackDir, filename: "app.js", publicPath: "auto" },
    });
    compiler.run((error, stats) => {
      compiler.close((closeError) => {
        if (error || closeError) reject(error ?? closeError);
        else if (stats.hasErrors()) reject(new Error(stats.toString({ all: false, errors: true })));
        else resolve();
      });
    });
  });
  copyFileSync(css, path.join(webpackDir, "styles.css"));
  write(path.join(webpackDir, "index.html"), html("app.js"));
  const standaloneDir = path.join(publicDir, "standalone");
  mkdirSync(standaloneDir, { recursive: true });
  const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
  execFileSync("tar", [
    "-xzf",
    path.join(root, "dist", `standalone-checkout-${version}.tar.gz`),
    "-C",
    standaloneDir,
    "--strip-components=1",
  ]);
  write(
    path.join(standaloneDir, "index.html"),
    html("openreceive-checkout.js", "openreceive-checkout.css"),
  );
}

async function openTutorial(page) {
  await page.getByRole("button", { name: /^Bitcoin/ }).click();
  await page
    .locator("article")
    .filter({ has: page.getByRole("heading", { name: "Strike", exact: true }) })
    .getByRole("button", { name: "How To Pay" })
    .click();
  const dialog = page.getByRole("dialog", { name: /Pay a Lightning invoice with Strike/ });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Next" }).click();
  await expect(dialog).toContainText("Tap Send");
  return dialog;
}

async function decodedVisibleImages(page) {
  const images = page.locator("img");
  assert((await images.count()) > 0, "checkout rendered no images");
  for (const image of await images.all()) {
    await expect(image).toHaveAttribute("src", /^data:image\//);
    await image.evaluate(async (element) => {
      await element.decode();
      if (!element.naturalWidth || !element.naturalHeight) throw new Error("empty image");
    });
  }
}

async function verifyFixture(origin, name, renderer) {
  const page = await browser.newPage();
  const errors = [];
  const imageRequests = [];
  const scripts = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("request", (request) => {
    if (request.resourceType() === "image" && !request.url().startsWith("data:"))
      imageRequests.push(request.url());
    if (request.resourceType() === "script") scripts.push(request.url());
  });
  page.on("response", (response) => {
    if (!response.ok()) errors.push(`${response.status()}: ${response.url()}`);
  });
  try {
    await page.goto(`${origin}${prefix}${name}/index.html?renderer=${renderer}`);
    await expect(page.getByRole("button", { name: /^Bitcoin/ })).toBeVisible();
    const initialScripts = new Set(scripts);
    const dialog = await openTutorial(page);
    await expect(dialog.locator('img[alt="Tap Send"]')).toBeVisible();
    await decodedVisibleImages(page);
    const tutorialScripts = scripts.filter((url) => !initialScripts.has(url));
    const split = ["esbuild-split", "vite", "webpack"].includes(name);
    assert.equal(tutorialScripts.length > 0, split, `${name}: tutorial download timing`);
    if (name !== "standalone") {
      const counts = await page.evaluate(() => window.decodePackagedImages());
      assert(counts.icons > 0 && counts.logos >= 37 && counts.tutorials >= 20);
      console.log(`${name}/${renderer}: decoded ${JSON.stringify(counts)}`);
    } else console.log("standalone/elements: release archive rendered and decoded tutorial");
    assert.deepEqual(imageRequests, [], "checkout requested image files");
    assert.deepEqual(errors, [], "browser errors");

    // A failed normal JS chunk must leave readable captions, never a broken img.
    if (split) {
      const failure = await browser.newPage();
      try {
        for (const url of tutorialScripts) await failure.route(url, (route) => route.abort());
        const failedRequest = failure.waitForEvent("requestfailed", {
          predicate: (request) => tutorialScripts.includes(request.url()),
        });
        await failure.goto(`${origin}${prefix}${name}/index.html?renderer=${renderer}`);
        const failedDialog = await openTutorial(failure);
        await failedRequest;
        await failure.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        await expect(failedDialog.locator('img[alt="Tap Send"]')).toHaveCount(0);
        await decodedVisibleImages(failure);
      } finally {
        await failure.close();
      }
    }
  } finally {
    await page.close();
  }
}

try {
  await buildFixtures();
  server = createServer((request, response) => {
    const pathname = new URL(request.url, "http://fixture.local").pathname;
    const relative = pathname.slice(prefix.length);
    if (!pathname.startsWith(prefix) || relative.includes("..")) {
      response.writeHead(404).end();
      return;
    }
    try {
      const file = path.join(publicDir, relative);
      const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
      response.writeHead(200, {
        "Content-Type": types[path.extname(file)] ?? "application/octet-stream",
        "Content-Security-Policy":
          "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
      });
      response.end(readFileSync(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({ headless: true });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const name of ["esbuild", "esbuild-split", "vite", "webpack"]) {
    for (const renderer of ["react", "elements"]) await verifyFixture(origin, name, renderer);
  }
  await verifyFixture(origin, "standalone", "elements");
  console.log("Packaged asset browser matrix passed (9 scenarios; no image server).");
} finally {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  rmSync(artifacts.workspace.baseDir, { recursive: true, force: true });
}
