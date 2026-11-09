import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { InfraError } from "./docker.ts";

// `npm run trial -- --tree`: every package a shop can install, built from this
// working tree at a version no registry has. A copy of the tree is bumped with
// the repo's own release tools, so the bytes a shop gets are what a release
// would ship. The result is cached by a hash of the package-relevant files
// (trials/, tests/, docs/ and examples/ don't change a package), so a sweep
// builds once.

const execFileAsync = promisify(execFile);

const WP_CLI_URL = "https://github.com/wp-cli/wp-cli/releases/download/v2.12.0/wp-cli-2.12.0.phar";

/** Everything that decides what a package contains; the rest of the tree never reaches one. */
const SKIP_PREFIXES = ["trials/", "tests/", "docs/", "examples/", ".github/"];

const PHP_BUILD_PACKAGES = ["wordpress", "paymenter", "fossbilling", "prestashop"];

export interface NpmArtifact {
  readonly name: string;
  readonly version: string;
  /** Relative to the build's `out` directory. */
  readonly file: string;
  /** npm's lockfile form: `sha512-<base64>`. */
  readonly integrity: string;
  /** Hex sha1, the registry's `dist.shasum`. */
  readonly shasum: string;
  readonly manifest: Record<string, unknown>;
}

export interface GemArtifact {
  readonly name: string;
  readonly version: string;
  readonly file: string;
  readonly sha256: string;
  readonly dependencies: readonly (readonly [string, string])[];
  readonly requiredRuby: string;
  readonly requiredRubygems: string;
}

export interface PythonArtifact {
  readonly filename: string;
  readonly file: string;
  readonly sha256: string;
}

export interface ComposerArtifact {
  readonly name: string;
  readonly version: string;
  readonly file: string;
  readonly sha256: string;
  readonly manifest: Record<string, unknown>;
}

export interface TreeBuild {
  readonly key: string;
  /** The directory with `out/`, `composer-home/` and `build.log`. */
  readonly directory: string;
  readonly version: string;
  readonly sourceVersion: string;
  readonly commit: string;
  readonly npm: readonly NpmArtifact[];
  readonly gems: readonly GemArtifact[];
  readonly python: readonly PythonArtifact[];
  readonly composer: readonly ComposerArtifact[];
  /** Release assets by file name, as a GitHub release attaches them. */
  readonly releaseFiles: readonly string[];
}

/** One above the workspace version: no registry has it, and a release's own number is never used. */
export function nextPatchVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) throw new InfraError(`Not a release version: ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

export function treeInputFiles(listed: readonly string[]): string[] {
  return listed.filter((file) => !SKIP_PREFIXES.some((prefix) => file.startsWith(prefix))).sort();
}

export function treeKey(files: readonly (readonly [string, Buffer | string])[]): string {
  const hash = createHash("sha256");
  for (const [file, body] of files) {
    hash.update(`${file}\0${Buffer.byteLength(body)}\0`);
    hash.update(body);
  }
  return hash.digest("hex").slice(0, 16);
}

class BuildLog {
  readonly stream: WriteStream;
  constructor(readonly file: string) {
    this.stream = createWriteStream(file, { flags: "a" });
  }
  line(text: string): void {
    this.stream.write(`${text}\n`);
    console.log(`[tree build] ${text}`);
  }
  close(): Promise<void> {
    return new Promise((resolve) => this.stream.end(resolve));
  }
}

interface StepOptions {
  readonly cwd: string;
  readonly log: BuildLog;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

function step(bin: string, args: readonly string[], options: StepOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    options.log.line(`$ ${bin} ${args.join(" ")}`);
    const child = spawn(bin, [...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
    });
    let output = "";
    const collect = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      output = `${output}${text}`.slice(-40_000);
      options.log.stream.write(text);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs ?? 20 * 60 * 1000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new InfraError(`${bin}: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(output);
        return;
      }
      reject(
        new InfraError(
          `tree build: ${bin} ${args.join(" ")} exited ${code} (full log: ${options.log.file})\n${output.slice(-1500)}`,
        ),
      );
    });
  });
}

async function listFiles(repoRoot: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
  });
  return [...new Set(stdout.split("\0").filter(Boolean))];
}

/** A tracked symlink hashes and copies as its target, a gitlink not at all. */
async function readEntry(source: string): Promise<Buffer | string | undefined> {
  const info = await lstat(source).catch(() => undefined);
  if (info === undefined || info.isDirectory()) return undefined;
  return info.isSymbolicLink() ? readlink(source) : readFile(source);
}

async function keyOf(repoRoot: string, listed: readonly string[]): Promise<string> {
  const files = [...treeInputFiles(listed), "trials/harness/tree-build.ts"];
  const bodies = await Promise.all(
    files.map(async (file) => {
      const body = await readEntry(path.join(repoRoot, file));
      return [file, body] as const;
    }),
  );
  return treeKey(
    bodies.filter((entry): entry is readonly [string, Buffer | string] => entry[1] !== undefined),
  );
}

async function copyTree(repoRoot: string, listed: readonly string[], to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const file of listed) {
    const source = path.join(repoRoot, file);
    const info = await lstat(source).catch(() => undefined);
    if (info === undefined || info.isDirectory()) continue;
    const target = path.join(to, file);
    await mkdir(path.dirname(target), { recursive: true });
    if (info.isSymbolicLink()) await symlink(await readlink(source), target);
    else await copyFile(source, target);
  }
}

function hashFile(body: Buffer, algorithm: string, encoding: "hex" | "base64"): string {
  return createHash(algorithm).update(body).digest(encoding);
}

async function collectNpm(copy: string, out: string, log: BuildLog): Promise<NpmArtifact[]> {
  const publicNames = (await import(path.join(copy, "tools/package/public-packages.mjs")))
    .OPENRECEIVE_PUBLIC_PACKAGE_NAMES as readonly string[];
  const tarballDir = path.join(copy, ".release/tree-npm/tarballs");
  const artifacts: NpmArtifact[] = [];
  await mkdir(path.join(out, "npm"), { recursive: true });
  for (const entry of await readdir(tarballDir)) {
    if (!entry.endsWith(".tgz")) continue;
    const packed = path.join(tarballDir, entry);
    const body = await readFile(packed);
    const { stdout } = await execFileAsync("tar", ["-xzOf", packed, "package/package.json"], {
      maxBuffer: 8 * 1024 * 1024,
    });
    const manifest = JSON.parse(stdout) as Record<string, unknown>;
    const name = manifest["name"] as string;
    if (!publicNames.includes(name)) continue;
    await copyFile(packed, path.join(out, "npm", entry));
    artifacts.push({
      name,
      version: manifest["version"] as string,
      file: path.join("npm", entry),
      integrity: `sha512-${hashFile(body, "sha512", "base64")}`,
      shasum: hashFile(body, "sha1", "hex"),
      manifest,
    });
  }
  log.line(`npm: ${artifacts.length} tarballs`);
  return artifacts.sort((left, right) => left.name.localeCompare(right.name));
}

async function collectGems(
  copy: string,
  out: string,
  version: string,
  log: BuildLog,
): Promise<GemArtifact[]> {
  const from = path.join(copy, ".release/gems", version);
  await mkdir(path.join(out, "gems"), { recursive: true });
  const artifacts: GemArtifact[] = [];
  for (const entry of await readdir(from)) {
    if (!entry.endsWith(".gem")) continue;
    const source = path.join(from, entry);
    const body = await readFile(source);
    const { stdout } = await execFileAsync(
      "ruby",
      [
        "-rjson",
        "-rrubygems/package",
        "-e",
        "spec = Gem::Package.new(ARGV[0]).spec; print JSON.generate(name: spec.name, version: spec.version.to_s, deps: spec.runtime_dependencies.map { |d| [d.name, d.requirement.to_s] }, ruby: spec.required_ruby_version.to_s, rubygems: spec.required_rubygems_version.to_s)",
        source,
      ],
      { maxBuffer: 1024 * 1024 },
    );
    const spec = JSON.parse(stdout) as {
      name: string;
      version: string;
      deps: [string, string][];
      ruby: string;
      rubygems: string;
    };
    await copyFile(source, path.join(out, "gems", entry));
    artifacts.push({
      name: spec.name,
      version: spec.version,
      file: path.join("gems", entry),
      sha256: hashFile(body, "sha256", "hex"),
      dependencies: spec.deps,
      requiredRuby: spec.ruby,
      requiredRubygems: spec.rubygems,
    });
  }
  log.line(`gems: ${artifacts.map((gem) => `${gem.name}-${gem.version}`).join(", ")}`);
  return artifacts;
}

async function collectPython(
  copy: string,
  out: string,
  version: string,
  log: BuildLog,
): Promise<PythonArtifact[]> {
  const from = path.join(copy, ".release/pypi", version);
  await mkdir(path.join(out, "python"), { recursive: true });
  const artifacts: PythonArtifact[] = [];
  for (const entry of await readdir(from)) {
    if (!entry.endsWith(".whl") && !entry.endsWith(".tar.gz")) continue;
    const source = path.join(from, entry);
    await copyFile(source, path.join(out, "python", entry));
    artifacts.push({
      filename: entry,
      file: path.join("python", entry),
      sha256: hashFile(await readFile(source), "sha256", "hex"),
    });
  }
  log.line(`python: ${artifacts.map((item) => item.filename).join(", ")}`);
  return artifacts;
}

async function collectComposer(
  copy: string,
  out: string,
  version: string,
  log: BuildLog,
): Promise<ComposerArtifact[]> {
  const records = path.join(copy, ".release/composer", version);
  await mkdir(path.join(out, "composer"), { recursive: true });
  const artifacts: ComposerArtifact[] = [];
  for (const entry of await readdir(records)) {
    if (!entry.endsWith(".json")) continue;
    const record = JSON.parse(await readFile(path.join(records, entry), "utf8")) as {
      name: string;
      version: string;
      commit: string;
    };
    const short = record.name.replace("openreceive/", "");
    const zip = path.join("composer", `${short}-${version}.zip`);
    await step("git", ["archive", "--format=zip", "-o", path.join(out, zip), record.commit], {
      cwd: copy,
      log,
    });
    const { stdout } = await execFileAsync("git", ["show", `${record.commit}:composer.json`], {
      cwd: copy,
      maxBuffer: 8 * 1024 * 1024,
    });
    artifacts.push({
      name: record.name,
      version: record.version,
      file: zip,
      sha256: hashFile(await readFile(path.join(out, zip)), "sha256", "hex"),
      manifest: JSON.parse(stdout) as Record<string, unknown>,
    });
  }
  log.line(`composer: ${artifacts.map((item) => `${item.name}@${item.version}`).join(", ")}`);
  return artifacts;
}

/** What a GitHub release attaches: the release ZIPs and the standalone checkout tarball. */
async function collectReleaseFiles(copy: string, out: string, version: string): Promise<string[]> {
  await mkdir(path.join(out, "release"), { recursive: true });
  const files: string[] = [];
  for (const entry of await readdir(path.join(copy, "dist"))) {
    const zip = entry.startsWith("openreceive-") && entry.endsWith(`-${version}.zip`);
    if (!zip && entry !== `standalone-checkout-${version}.tar.gz`) continue;
    await copyFile(path.join(copy, "dist", entry), path.join(out, "release", entry));
    files.push(entry);
  }
  return files.sort();
}

async function buildFromTree(repoRoot: string, directory: string, key: string): Promise<TreeBuild> {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const log = new BuildLog(path.join(directory, "build.log"));
  const copy = path.join(directory, "src");
  const out = path.join(directory, "out");
  await mkdir(out, { recursive: true });
  try {
    log.line(`building from ${repoRoot} into ${directory}`);
    const listed = await listFiles(repoRoot);
    const sourceManifest = JSON.parse(
      await readFile(path.join(repoRoot, "package.json"), "utf8"),
    ) as {
      version: string;
    };
    const sourceVersion = sourceManifest.version;
    const version = nextPatchVersion(sourceVersion);
    const { stdout: commitStdout } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
    });
    const { stdout: statusStdout } = await execFileAsync("git", ["status", "--porcelain"], {
      cwd: repoRoot,
    });
    const commit = `${commitStdout.trim()}${statusStdout.trim() === "" ? "" : "+dirty"}`;
    await copyTree(repoRoot, listed, copy);
    // Bundler in deployment mode would demand the example's gems locally; the
    // copy never runs the example, so release:prepare has nothing to refresh.
    await rm(path.join(copy, "examples/buttons/server/rails/Gemfile.lock"), { force: true });
    const git = (...args: string[]): Promise<string> => step("git", args, { cwd: copy, log });
    await git("init", "-q", "-b", "master");
    await git("add", "-A");
    await git(
      "-c",
      "user.name=Trial",
      "-c",
      "user.email=trial@example.com",
      "commit",
      "-q",
      "-m",
      `tree ${commit}`,
    );
    const npm = (...args: string[]): Promise<string> => step("npm", args, { cwd: copy, log });
    await step(
      "node",
      ["tools/release/npm-release.mjs", "prepare", "--version", version, "--allow-dirty"],
      { cwd: copy, log },
    );
    await npm("ci", "--no-audit", "--no-fund");
    await step(
      "node",
      ["tools/package/build-artifacts.mjs", "--out", ".release/tree-npm", "--keep"],
      { cwd: copy, log, timeoutMs: 30 * 60 * 1000 },
    );
    await npm("run", "release:gem:build");
    await npm("run", "release:pypi:build");
    await step("node", ["tools/release/composer-release.mjs", "build", "--snapshot"], {
      cwd: copy,
      log,
    });
    for (const name of PHP_BUILD_PACKAGES) {
      await step(
        "composer",
        [
          "install",
          `--working-dir=packages/php/${name}`,
          "--no-interaction",
          "--no-progress",
          "--prefer-dist",
        ],
        { cwd: copy, log },
      );
    }
    // wp i18n make-pot needs WP-CLI; the release tool takes its phar instead.
    const tools = path.join(directory, "tools");
    await mkdir(tools, { recursive: true });
    const phar = path.join(tools, "wp-cli.phar");
    await step("curl", ["-fsSL", "-o", phar, WP_CLI_URL], { cwd: tools, log });
    await step("node", ["tools/release/wordpress-plugin.mjs", "build"], {
      cwd: copy,
      log,
      env: { OPENRECEIVE_WP_CLI: phar },
    });
    await npm("run", "release:paymenter:build");
    await npm("run", "release:fossbilling:build");
    await npm("run", "release:prestashop:build");
    await npm("run", "release:odoo:build");

    const [npmArtifacts, gems, python, composer, releaseFiles] = await Promise.all([
      collectNpm(copy, out, log),
      collectGems(copy, out, version, log),
      collectPython(copy, out, version, log),
      collectComposer(copy, out, version, log),
      collectReleaseFiles(copy, out, version),
    ]);
    log.line(`release assets: ${releaseFiles.join(", ")}`);
    const build: TreeBuild = {
      key,
      directory,
      version,
      sourceVersion,
      commit,
      npm: npmArtifacts,
      gems,
      python,
      composer,
      releaseFiles,
    };
    await writeFile(path.join(directory, "manifest.json"), `${JSON.stringify(build, null, 2)}\n`);
    // The copy (with node_modules) was only needed to produce out/.
    await rm(copy, { recursive: true, force: true });
    log.line("done");
    return build;
  } finally {
    await log.close();
  }
}

/**
 * The build for this tree, built once. The key excludes trials/ and docs/, so
 * editing the harness or a directions file reuses it; the directions are
 * served live from the working tree anyway.
 */
export async function ensureTreeBuild(repoRoot: string): Promise<TreeBuild> {
  const root = path.join(tmpdir(), "openreceive-tree-build");
  await mkdir(root, { recursive: true });
  const listed = await listFiles(repoRoot);
  const key = await keyOf(repoRoot, listed);
  const directory = path.join(root, key);
  const manifest = path.join(directory, "manifest.json");
  if (existsSync(manifest)) {
    const reused = JSON.parse(await readFile(manifest, "utf8")) as TreeBuild;
    console.log(`[tree build] reusing ${directory} (${reused.version}, from ${reused.commit})`);
    return reused;
  }
  const started = Date.now();
  const build = await buildFromTree(repoRoot, directory, key);
  console.log(
    `[tree build] ${build.version} built in ${((Date.now() - started) / 60_000).toFixed(1)} min`,
  );
  return build;
}
