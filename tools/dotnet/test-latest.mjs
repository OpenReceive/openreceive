#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const upstream = "https://github.com/btcpayserver/btcpayserver.git";
const latestReleaseUrl = "https://api.github.com/repos/btcpayserver/btcpayserver/releases/latest";
const buildDirectories = new Set([
  "bin",
  "obj",
  "bin-docker",
  "obj-docker",
  "TestResults",
  "submodules",
  ".state",
]);

export async function latestBtcpayRelease(fetchImpl = fetch) {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const response = await fetchImpl(latestReleaseUrl, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "openreceive-btcpay-compatibility",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  assert(response.ok, `Cannot resolve latest BTCPay release: GitHub HTTP ${response.status}`);
  const release = await response.json();
  assert(
    release.draft === false && release.prerelease === false,
    "Latest BTCPay release must be stable",
  );
  const match = /^v?(\d+\.\d+\.\d+)$/.exec(release.tag_name);
  assert(match, `Unsupported BTCPay release tag: ${release.tag_name}`);
  return {
    tag: release.tag_name,
    version: match[1],
    image: `btcpayserver/btcpayserver:${match[1]}`,
  };
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (data) => {
      stdout += data;
    });
    child.stderr?.on("data", (data) => {
      stderr += data;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command} failed (${signal ?? code}): ${stderr.trim()}`));
    });
  });
}

export async function cleanupBuild(directory, command, remove = rmSync) {
  try {
    remove(directory, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== "EACCES" && error.code !== "EPERM") throw error;
    // On Linux, SDK containers can leave root-owned build directories. The
    // cleanup container sees only this disposable directory, never the repo.
    await command(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${directory}:/cleanup`,
        process.env.SDK_IMAGE ?? "mcr.microsoft.com/dotnet/sdk:10.0",
        "sh",
        "-c",
        "rm -rf /cleanup/* /cleanup/.[!.]* /cleanup/..?*",
      ],
      { inherit: true },
    );
    remove(directory, { recursive: true, force: true });
  }
}

export async function testLatestBtcpay(input = {}) {
  const root = input.root ?? process.cwd();
  const execute = input.run ?? run;
  const log = input.log ?? console.error;
  const summaryFile = input.summaryFile ?? process.env.GITHUB_STEP_SUMMARY;
  const reportDir = path.join(root, ".release/btcpay-compatibility");
  mkdirSync(reportDir, { recursive: true });
  const reportFile = path.join(reportDir, "latest.json");
  const report = { checkedAt: new Date().toISOString(), status: "running", checks: [] };
  const scratch = mkdtempSync(path.join(reportDir, "work-"));
  const pinnedSource = path.join(root, "packages/dotnet/submodules/btcpayserver");
  const command = (name, args, options = {}) => execute(name, args, { cwd: root, ...options });
  const copyDotnet = (name) => {
    const destination = path.join(scratch, name);
    cpSync(path.join(root, "packages/dotnet"), destination, {
      recursive: true,
      filter: (source) => !buildDirectories.has(path.basename(source)),
    });
    return destination;
  };
  try {
    const release = await latestBtcpayRelease(input.fetch);
    Object.assign(report, release);
    log(`Latest stable BTCPay: ${release.tag}; pulling its matching Docker image`);
    await command("docker", ["pull", release.image], { inherit: true });
    const image = await command("docker", [
      "image",
      "inspect",
      "--format",
      "{{index .RepoDigests 0}}",
      release.image,
    ]);
    assert(
      /^btcpayserver\/btcpayserver@sha256:[a-f0-9]{64}$/.test(image),
      "BTCPay image digest is missing",
    );
    report.imageDigest = image;

    const source = path.join(scratch, "upstream");
    await command("git", [
      "clone",
      "--depth",
      "1",
      "--branch",
      release.tag,
      "--single-branch",
      upstream,
      source,
    ]);
    report.sourceCommit = await command("git", ["rev-parse", "HEAD"], { cwd: source });
    report.pinnedCommit = await command("git", ["rev-parse", "HEAD"], { cwd: pinnedSource });
    assert.equal(
      await command("git", ["status", "--porcelain"], { cwd: pinnedSource }),
      "",
      "Pinned BTCPay source must be clean",
    );

    async function check(label, dotnetRoot, btcpayRoot, unitTests) {
      const env = {
        BTCPAY_DOTNET_ROOT: dotnetRoot,
        BTCPAY_SERVER_ROOT: btcpayRoot,
        BTCPAY_IMAGE: image,
      };
      if (unitTests) {
        log(`BTCPay ${release.version}: building and testing against latest source`);
        await command("bash", ["packages/dotnet/docker/test-unit.sh"], { env, inherit: true });
        report.checks.push("latest-source-unit-tests");
      }
      log(`BTCPay ${release.version}: ${label} browser save/reload/checkout smoke`);
      await command("bash", ["packages/dotnet/docker/browser-smoke.sh"], { env, inherit: true });
      report.checks.push(label);
    }
    await check("latest-build-on-latest-server", copyDotnet("latest-build"), source, true);
    if (report.sourceCommit === report.pinnedCommit) {
      log("Pinned and latest source commits match; the browser run covers both builds");
      report.checks.push("pinned-build-on-latest-server (same source commit)");
    } else {
      // Rebuilding against latest alone can hide a binary break in the plugin
      // shipped from our pinned source. Exercise that artifact on latest too.
      await check("pinned-build-on-latest-server", copyDotnet("pinned-build"), pinnedSource, false);
    }
    report.status = "passed";
    return report;
  } catch (error) {
    report.status = "failed";
    report.error = error.message;
    throw error;
  } finally {
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
    if (summaryFile) {
      appendFileSync(
        summaryFile,
        `\n### BTCPay compatibility: ${report.status}\n\n` +
          `- Latest release: ${report.tag ?? "unresolved"}\n` +
          `- Source commit: ${report.sourceCommit ?? "unresolved"}\n` +
          `- Pinned commit: ${report.pinnedCommit ?? "unresolved"}\n` +
          `- Image: ${report.imageDigest ?? "unresolved"}\n` +
          report.checks.map((check) => `- Passed: ${check}\n`).join(""),
      );
    }
    await cleanupBuild(scratch, command);
    log(`BTCPay compatibility report: ${reportFile}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  testLatestBtcpay().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
