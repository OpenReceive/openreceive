import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Dirty and non-git trees always build fresh. Node/npm and the commit bind
// reuse to the source, lockfile and build tools used for the release.
export function artifactCacheIdentity(root) {
  try {
    const run = (command, args) =>
      execFileSync(command, args, {
        cwd: root,
        encoding: "utf8",
        stdio: "pipe",
      }).trim();
    if (run("git", ["status", "--porcelain", "--untracked-files=normal"])) return undefined;
    return {
      schema: 1,
      commit: run("git", ["rev-parse", "HEAD"]),
      node: process.version,
      npm: run("npm", ["--version"]),
      platform: process.platform,
      arch: process.arch,
    };
  } catch {
    return undefined;
  }
}

function cacheDirectory(root, identity) {
  return path.join(root, ".release/package-artifacts", digest(JSON.stringify(identity)));
}

export function restoreTarballs(root, identity, packages, destination) {
  if (!identity) return undefined;
  const directory = cacheDirectory(root, identity);
  let entries;
  try {
    entries = packages.map(({ manifest }) => {
      const record = JSON.parse(
        readFileSync(path.join(directory, `${digest(manifest.name)}.json`)),
      );
      if (
        record.name !== manifest.name ||
        record.version !== manifest.version ||
        !/^[a-f0-9]{64}$/.test(record.sha256) ||
        path.basename(record.filename) !== record.filename ||
        !record.filename.endsWith(".tgz")
      ) {
        throw new Error("Artifact metadata mismatch");
      }
      const source = path.join(directory, `${record.sha256}.tgz`);
      if (digest(readFileSync(source)) !== record.sha256)
        throw new Error("Artifact checksum mismatch");
      return { ...record, source };
    });
  } catch {
    return undefined;
  }
  return entries.map(({ name, filename, source }) => {
    const tarball = path.join(destination, filename);
    copyFileSync(source, tarball);
    return { name, tarball };
  });
}

export function saveTarballs(root, identity, tarballs) {
  const directory = cacheDirectory(root, identity);
  mkdirSync(directory, { recursive: true });
  for (const { name, tarball } of tarballs) {
    const sha256 = digest(readFileSync(tarball));
    // The manifest inside the archive is the version actually being cached.
    const manifest = JSON.parse(
      execFileSync("tar", ["-xOf", tarball, "package/package.json"], {
        encoding: "utf8",
        stdio: "pipe",
      }),
    );
    if (manifest.name !== name) throw new Error(`Artifact package mismatch: ${name}`);
    copyFileSync(tarball, path.join(directory, `${sha256}.tgz`));
    const record = { name, version: manifest.version, filename: path.basename(tarball), sha256 };
    const target = path.join(directory, `${digest(name)}.json`);
    const temporary = `${target}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`);
    renameSync(temporary, target);
  }
}
