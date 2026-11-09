import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import { InfraError, treeMuPluginFile, treeOverrideFile } from "./docker.ts";
import type {
  ComposerArtifact,
  GemArtifact,
  NpmArtifact,
  PythonArtifact,
  TreeBuild,
} from "./tree-build.ts";

// A registry that serves this tree's packages at one address every install
// can reach: the agent's shell, a RUN step in a shop's image, and a container
// on the shop's network. It answers for OpenReceive's own packages and hands
// everything else to the real registry, so `npm install`, `pip install`,
// `bundle add` and `composer require` run unchanged.
//
// Docker's bridge gateway is that one address: BuildKit's default network,
// every Compose network and the host all route to it, and a kept shop keeps
// the same URLs.

const execFileAsync = promisify(execFile);

export const TREE_REGISTRY_PORT = 17893;
/** Outside Docker's default pools, and clear of this host's VPN and VM bridges. */
const TREE_SUBNET_BASE = "10.202";
const NPM_UPSTREAM = "registry.npmjs.org";
const PYPI_UPSTREAM = "pypi.org";
const RUBYGEMS_UPSTREAM = "rubygems.org";
const PREFIX = "/_tree";

export async function dockerBridgeGateway(): Promise<string> {
  const { stdout } = await execFileAsync(
    "docker",
    ["network", "inspect", "bridge", "-f", "{{(index .IPAM.Config 0).Gateway}}"],
    { timeout: 15_000 },
  );
  const gateway = stdout.trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(gateway)) {
    throw new InfraError(`Unexpected docker bridge gateway: "${gateway}"`);
  }
  return gateway;
}

function unscopedName(name: string): string {
  return name.startsWith("@") ? (name.split("/")[1] ?? name) : name;
}

/** The registry's `dist.tarball` for an artifact. npm rewrites this host to the configured registry when it fetches, so a lockfile keeps npmjs URLs. */
export function npmTarballUrl(name: string, version: string): string {
  return `https://${NPM_UPSTREAM}/${name}/-/${unscopedName(name)}-${version}.tgz`;
}

/** One version of a package, as `/<name>/<version>` answers: what `npm view` and a by-hand curl ask for. */
export function npmVersionManifest(artifact: NpmArtifact): Record<string, unknown> {
  const packument = npmPackument(artifact) as {
    versions: Record<string, Record<string, unknown>>;
  };
  return packument.versions[artifact.version] ?? {};
}

/** One package's packument: only the tree's version, so nothing older can win. */
export function npmPackument(artifact: NpmArtifact): Record<string, unknown> {
  return {
    name: artifact.name,
    "dist-tags": { latest: artifact.version },
    versions: {
      [artifact.version]: {
        ...artifact.manifest,
        _id: `${artifact.name}@${artifact.version}`,
        dist: {
          tarball: npmTarballUrl(artifact.name, artifact.version),
          integrity: artifact.integrity,
          shasum: artifact.shasum,
        },
      },
    },
  };
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** PEP 503 simple page for the tree's Python distribution. */
export function pep503Page(base: string, files: readonly PythonArtifact[]): string {
  const links = files
    .map(
      (file) =>
        `<a href="${base}${PREFIX}/pypi/files/${escapeHtml(file.filename)}#sha256=${file.sha256}">${escapeHtml(file.filename)}</a>`,
    )
    .join("\n");
  return `<!doctype html>\n<html><body>\n${links}\n</body></html>\n`;
}

/** Composer's root `packages.json`. A `composer`-type repository takes precedence over Packagist for these names. */
export function composerPackagesJson(
  base: string,
  artifacts: readonly ComposerArtifact[],
): Record<string, unknown> {
  const packages: Record<string, unknown> = {};
  for (const artifact of artifacts) {
    packages[artifact.name] = {
      [artifact.version]: {
        ...artifact.manifest,
        version: artifact.version,
        dist: { type: "zip", url: `${base}${PREFIX}/composer/${path.basename(artifact.file)}` },
      },
    };
  }
  return { packages };
}

function compactRequirement(requirement: string): string {
  return requirement.replaceAll(", ", "&");
}

/** A gem's compact-index info file, as `https://rubygems.org/info/<name>` serves it. */
export function compactInfoBody(gem: GemArtifact): string {
  const deps = gem.dependencies
    .map(([name, requirement]) => `${name}:${compactRequirement(requirement)}`)
    .join(",");
  const details = [
    `checksum:${gem.sha256}`,
    gem.requiredRuby === ">= 0" ? undefined : `ruby:${compactRequirement(gem.requiredRuby)}`,
    gem.requiredRubygems === ">= 0"
      ? undefined
      : `rubygems:${compactRequirement(gem.requiredRubygems)}`,
  ].filter((part): part is string => part !== undefined);
  return `---\n${gem.version} ${deps}|${details.join(",")}\n`;
}

/** The lines appended to the upstream `/versions` so Bundler sees the tree's gems. The last line for a gem carries its checksum. */
export function compactVersionsLines(gems: readonly GemArtifact[]): string {
  return gems.map((gem) => `${gem.name} ${gem.version} ${md5(compactInfoBody(gem))}\n`).join("");
}

export function mergeVersions(upstream: string, extras: string): string {
  return `${upstream.trimEnd()}\n${extras}`;
}

function md5(text: string): string {
  return createHash("md5").update(text).digest("hex");
}

/** The Composer global config that adds the tree's repository. */
export function composerGlobalConfig(base: string): string {
  return JSON.stringify({
    config: { "secure-http": false },
    repositories: [{ type: "composer", url: `${base}${PREFIX}/composer` }],
  });
}

const DOCKERFILE_COMPOSER_HOME = "/opt/openreceive-composer";

export interface TreeEnv {
  readonly base: string;
  readonly host: string;
}

/** The package managers a plain environment variable reaches. */
export function treeShopEnv(env: TreeEnv): Record<string, string> {
  return {
    NPM_CONFIG_REGISTRY: `${env.base}/`,
    PIP_INDEX_URL: `${env.base}${PREFIX}/pypi/simple/`,
    PIP_TRUSTED_HOST: env.host,
    UV_DEFAULT_INDEX: `${env.base}${PREFIX}/pypi/simple/`,
    UV_INSECURE_HOST: env.host,
  };
}

function rubygemsMirror(env: TreeEnv): string {
  return `${env.base}${PREFIX}/rubygems/`;
}

/**
 * The agent's shell. Composer reads its repositories from COMPOSER_HOME.
 * Bundler's mirror setting has a `/` in its variable name, which a container's
 * shell drops, so images take it through `bundle config` instead.
 */
export function treeHostEnv(env: TreeEnv, composerHome: string): Record<string, string> {
  return {
    ...treeShopEnv(env),
    COMPOSER_HOME: composerHome,
    "BUNDLE_MIRROR__HTTPS://RUBYGEMS__ORG/": rubygemsMirror(env),
  };
}

const DOCKERFILE_COMMENT = "# Package mirror for this machine.";

/**
 * The lines after every FROM: env for every stage's RUN steps and the running
 * container. Bundler only reads its mirror from its config file, and Composer
 * its repositories, so an image that has those tools gets them written once.
 */
export function dockerfileBlock(
  env: TreeEnv,
  tools: { readonly composer: boolean; readonly bundler: boolean },
  buildKey?: string,
): string[] {
  const assignments = Object.entries({
    ...treeShopEnv(env),
    ...(tools.composer ? { COMPOSER_HOME: DOCKERFILE_COMPOSER_HOME } : {}),
    // Every build has the same version, so without this an unchanged
    // composer.json reuses Docker's cached install: the previous build's code.
    ...(buildKey === undefined ? {} : { OPENRECEIVE_TREE_BUILD: buildKey }),
  }).map(([key, value]) => `${key}=${value}`);
  const lines = [DOCKERFILE_COMMENT, `ENV ${assignments.join(" ")}`];
  if (tools.composer) {
    lines.push(
      `RUN mkdir -p ${DOCKERFILE_COMPOSER_HOME} && printf '%s' '${composerGlobalConfig(env.base)}' > ${DOCKERFILE_COMPOSER_HOME}/config.json && chmod -R a+rwX ${DOCKERFILE_COMPOSER_HOME}`,
    );
  }
  if (tools.bundler) {
    lines.push(`RUN bundle config set --local mirror.https://rubygems.org ${rubygemsMirror(env)}`);
  }
  return lines;
}

export function patchDockerfile(text: string, block: readonly string[]): string {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    out.push(line);
    if (/^\s*FROM\s/i.test(line)) out.push(...block);
  }
  return out.join("\n");
}

/** What the harness itself added to a Dockerfile, so a leak scan ignores it. */
export function harnessDockerfileLine(line: string): boolean {
  return (
    line === DOCKERFILE_COMMENT ||
    line.startsWith("ENV NPM_CONFIG_REGISTRY=") ||
    line.startsWith(`RUN mkdir -p ${DOCKERFILE_COMPOSER_HOME}`) ||
    line.startsWith("RUN bundle config set --local mirror.https://rubygems.org")
  );
}

export interface DirectionsRewrite {
  /** The workspace's version: the directions are stamped with it. */
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly base: string;
  readonly host: string;
}

/**
 * The served directions, as a release would have them, pointing at this
 * registry for the two things that do not go through a package manager's
 * own configuration: a release ZIP's URL, and Odoo's Dockerfile, whose
 * `pip3 install` runs in an image the agent writes.
 */
export function rewriteDirections(text: string, rewrite: DirectionsRewrite): string {
  const release = `${rewrite.base}${PREFIX}/release`;
  return text
    .replaceAll(rewrite.fromVersion, rewrite.toVersion)
    .replace(
      /https:\/\/github\.com\/OpenReceive\/openreceive\/releases\/download\/v[\w.-]+\/((?:openreceive|standalone-checkout)-[\w.-]+?\.(?:zip|tar\.gz))/gi,
      `${release}/$1`,
    )
    .replace(/https:\/\/github\.com\/OpenReceive\/openreceive\/releases\b(?!\/)/gi, `${release}/`)
    .replace(
      /`standalone-checkout-<version>\.tar\.gz`/g,
      `\`standalone-checkout-<version>.tar.gz\` (${release}/standalone-checkout-${rewrite.toVersion}.tar.gz)`,
    )
    .replace(
      /wp plugin install openreceive(?: --version=[\w.-]+)? --activate/g,
      `wp plugin install ${release}/openreceive-wordpress-${rewrite.toVersion}.zip --activate`,
    )
    .replace(
      /(pip3? install [^\n]*?)(openreceive==[\w.-]+)/g,
      `$1--index-url ${rewrite.base}${PREFIX}/pypi/simple/ --trusted-host ${rewrite.host} $2`,
    );
}

/** What the directions' GitHub release page link opens: the assets of this one release. */
export function releaseIndexPage(base: string, files: readonly string[]): string {
  const links = files
    .map((file) => `<a href="${base}${PREFIX}/release/${escapeHtml(file)}">${escapeHtml(file)}</a>`)
    .join("\n");
  return `<!doctype html>\n<html><body>\n<h1>Release assets</h1>\n${links}\n</body></html>\n`;
}

export type TreeRoute =
  | { readonly kind: "npm-packument"; readonly name: string }
  | { readonly kind: "npm-tarball"; readonly name: string; readonly file: string }
  | { readonly kind: "release"; readonly file: string }
  | { readonly kind: "release-index" }
  | { readonly kind: "composer-index" }
  | { readonly kind: "composer-dist"; readonly file: string }
  | { readonly kind: "pypi-page"; readonly project: string }
  | { readonly kind: "pypi-file"; readonly file: string }
  | { readonly kind: "gem-versions" }
  | { readonly kind: "gem-info"; readonly name: string }
  | { readonly kind: "gem-file"; readonly file: string }
  | { readonly kind: "proxy"; readonly upstream: string; readonly path: string };

/** The URL's path as sent: npm percent-encodes a scoped name's slash. */
export function routeRequest(rawPath: string): TreeRoute {
  const [pathOnly = "/", query] = rawPath.split("?");
  const pathname = decodeURIComponent(pathOnly);
  const search = query === undefined ? "" : `?${query}`;
  if (pathname.startsWith(`${PREFIX}/`)) {
    const rest = pathname.slice(PREFIX.length);
    const pypi = /^\/pypi\/simple\/([^/]+)\/?$/.exec(rest);
    if (pypi !== null) return { kind: "pypi-page", project: pypi[1] ?? "" };
    const pypiFile = /^\/pypi\/files\/([^/]+)$/.exec(rest);
    if (pypiFile !== null) return { kind: "pypi-file", file: pypiFile[1] ?? "" };
    if (rest === "/composer/packages.json") return { kind: "composer-index" };
    const composerDist = /^\/composer\/([^/]+\.zip)$/.exec(rest);
    if (composerDist !== null) return { kind: "composer-dist", file: composerDist[1] ?? "" };
    if (rest === "/release" || rest === "/release/") return { kind: "release-index" };
    if (rest.startsWith("/release/")) return { kind: "release", file: rest.slice(9) };
    if (rest.startsWith("/rubygems/")) {
      const gem = rest.slice("/rubygems".length);
      if (gem === "/versions") return { kind: "gem-versions" };
      const info = /^\/info\/([^/]+)$/.exec(gem);
      if (info !== null) return { kind: "gem-info", name: info[1] ?? "" };
      const file = /^\/gems\/([^/]+\.gem)$/.exec(gem);
      if (file !== null) return { kind: "gem-file", file: file[1] ?? "" };
      return { kind: "proxy", upstream: RUBYGEMS_UPSTREAM, path: `${gem}${search}` };
    }
  }
  const tarball = /^\/((?:@[^/]+\/)?[^/@]+)\/-\/([^/]+\.tgz)$/.exec(pathname);
  if (tarball !== null) {
    return { kind: "npm-tarball", name: tarball[1] ?? "", file: tarball[2] ?? "" };
  }
  const name = pathname.slice(1);
  if (name.length > 0 && !name.startsWith("-") && !name.includes("/-/")) {
    return { kind: "npm-packument", name };
  }
  return { kind: "proxy", upstream: NPM_UPSTREAM, path: `${pathOnly}${search}` };
}

function sendJson(response: ServerResponse, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(200, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}

function sendText(response: ServerResponse, body: string, type = "text/plain"): void {
  response.writeHead(200, {
    "content-type": type,
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendFile(response: ServerResponse, file: string, type: string): void {
  if (!existsSync(file)) {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, { "content-type": type });
  createReadStream(file).pipe(response);
}

/** Bytes as they came: the pass-through must not rewrite what a real registry signed or compressed. */
function proxy(
  request: IncomingMessage,
  response: ServerResponse,
  upstream: string,
  upstreamPath: string,
): void {
  const headers = { ...request.headers, host: upstream };
  delete headers.connection;
  const outbound = httpsRequest(
    { host: upstream, path: upstreamPath, method: request.method, headers },
    (incoming) => {
      response.writeHead(incoming.statusCode ?? 502, incoming.headers);
      incoming.pipe(response);
    },
  );
  outbound.on("error", (error) => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
    response.end(`tree registry: ${upstream}: ${error.message}\n`);
  });
  request.pipe(outbound);
}

export interface TreeRegistry {
  readonly build: TreeBuild;
  readonly base: string;
  readonly host: string;
  /** host:port, the string a leak into a shop's files contains. */
  readonly address: string;
  /** The agent's own shell: every package manager points at this registry. */
  readonly hostEnv: Readonly<Record<string, string>>;
  rewriteDirections: (text: string) => string;
  close: () => Promise<void>;
}

interface Upstream {
  fetchedAt: number;
  body: string;
}

const VERSIONS_TTL_MS = 10 * 60 * 1000;

function fetchUpstreamVersions(): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: RUBYGEMS_UPSTREAM,
        path: "/versions",
        method: "GET",
        headers: { host: RUBYGEMS_UPSTREAM, "accept-encoding": "identity" },
      },
      (incoming) => {
        if (incoming.statusCode !== 200) {
          incoming.resume();
          reject(new Error(`rubygems /versions answered ${incoming.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        incoming.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

export async function startTreeRegistry(
  build: TreeBuild,
  sourceVersion: string,
): Promise<TreeRegistry> {
  const host = await dockerBridgeGateway();
  const base = `http://${host}:${TREE_REGISTRY_PORT}`;
  const out = path.join(build.directory, "out");
  const npmByName = new Map(build.npm.map((artifact) => [artifact.name, artifact]));
  const gemByName = new Map(build.gems.map((gem) => [gem.name, gem]));
  const composerIndex = composerPackagesJson(base, build.composer);
  let versionsCache: Upstream | undefined;

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const route = routeRequest(request.url ?? "/");
    switch (route.kind) {
      case "npm-packument": {
        const artifact = npmByName.get(route.name);
        if (artifact !== undefined) {
          sendJson(response, npmPackument(artifact));
          return;
        }
        const versioned = /^(.+)\/([^/]+)$/.exec(route.name);
        const pinned = versioned === null ? undefined : npmByName.get(versioned[1] ?? "");
        if (
          pinned !== undefined &&
          (versioned?.[2] === pinned.version || versioned?.[2] === "latest")
        ) {
          sendJson(response, npmVersionManifest(pinned));
          return;
        }
        proxy(request, response, NPM_UPSTREAM, request.url ?? "/");
        return;
      }
      case "npm-tarball": {
        const artifact = npmByName.get(route.name);
        if (artifact === undefined || !route.file.endsWith(`-${artifact.version}.tgz`)) {
          proxy(request, response, NPM_UPSTREAM, request.url ?? "/");
          return;
        }
        sendFile(response, path.join(out, artifact.file), "application/octet-stream");
        return;
      }
      case "release":
        sendFile(
          response,
          path.join(out, "release", path.basename(route.file)),
          route.file.endsWith(".gz") ? "application/gzip" : "application/zip",
        );
        return;
      case "release-index":
        sendText(response, releaseIndexPage(base, build.releaseFiles), "text/html");
        return;
      case "composer-index":
        sendJson(response, composerIndex);
        return;
      case "composer-dist":
        sendFile(
          response,
          path.join(out, "composer", path.basename(route.file)),
          "application/zip",
        );
        return;
      case "pypi-page": {
        if (route.project.toLowerCase() === "openreceive") {
          sendText(response, pep503Page(base, build.python), "text/html");
          return;
        }
        proxy(request, response, PYPI_UPSTREAM, `/simple/${route.project}/`);
        return;
      }
      case "pypi-file":
        sendFile(
          response,
          path.join(out, "python", path.basename(route.file)),
          "application/octet-stream",
        );
        return;
      case "gem-versions": {
        const fresh =
          versionsCache !== undefined && Date.now() - versionsCache.fetchedAt < VERSIONS_TTL_MS;
        if (!fresh) {
          versionsCache = { fetchedAt: Date.now(), body: await fetchUpstreamVersions() };
        }
        sendText(
          response,
          mergeVersions(versionsCache?.body ?? "", compactVersionsLines(build.gems)),
        );
        return;
      }
      case "gem-info": {
        const gem = gemByName.get(route.name);
        if (gem === undefined) {
          proxy(request, response, RUBYGEMS_UPSTREAM, `/info/${route.name}`);
          return;
        }
        sendText(response, compactInfoBody(gem));
        return;
      }
      case "gem-file": {
        const gem = build.gems.find((item) => path.basename(item.file) === route.file);
        if (gem === undefined) {
          proxy(request, response, RUBYGEMS_UPSTREAM, `/gems/${route.file}`);
          return;
        }
        sendFile(response, path.join(out, gem.file), "application/octet-stream");
        return;
      }
      case "proxy":
        proxy(request, response, route.upstream, route.path);
        return;
    }
  };

  const server: Server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
      response.end(`tree registry: ${message}\n`);
    });
  });
  const composerHome = await mkdtemp(path.join(tmpdir(), "openreceive-tree-composer-"));
  await writeFile(path.join(composerHome, "config.json"), composerGlobalConfig(base));
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        new InfraError(
          error.code === "EADDRINUSE"
            ? `Port ${TREE_REGISTRY_PORT} on ${host} is already in use. Is another --tree run going?`
            : `The tree registry could not bind ${host}:${TREE_REGISTRY_PORT}: ${error.message}`,
        ),
      );
    });
    server.listen(TREE_REGISTRY_PORT, host, () => resolve());
  });
  console.log(`[tree] registry on ${base} (${build.version}, from ${build.commit})`);
  return {
    build,
    base,
    host,
    address: `${host}:${TREE_REGISTRY_PORT}`,
    hostEnv: treeHostEnv({ base, host }, composerHome),
    rewriteDirections: (text: string) =>
      rewriteDirections(text, {
        fromVersion: sourceVersion,
        toVersion: build.version,
        base,
        host,
      }),
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      await rm(composerHome, { recursive: true, force: true });
    },
  };
}

async function dockerfilesUnder(directory: string): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await dockerfilesUnder(full)));
    else if (entry.isFile() && /^Dockerfile/.test(entry.name)) found.push(full);
  }
  return found;
}

/** Every Dockerfile in a shop, then the override for its image-only services. */
export async function patchShopForTree(directory: string, tree: TreeRegistry): Promise<void> {
  const env = { base: tree.base, host: tree.host };
  for (const file of await dockerfilesUnder(directory)) {
    const text = await readFile(file, "utf8");
    const block = dockerfileBlock(
      env,
      {
        composer: /\bcomposer\b/i.test(text),
        bundler: /\bbundle\b/i.test(text),
      },
      tree.build.key,
    );
    await writeFile(file, patchDockerfile(text, block));
  }
  const composeText = await readFile(path.join(directory, "compose.yml"), "utf8");
  const composeFile = parseYaml(composeText) as { services?: Record<string, unknown> };
  const services = Object.keys(composeFile.services ?? {});
  let wordpressMuPlugin: string | undefined;
  if (services.includes("wordpress")) {
    wordpressMuPlugin = treeMuPluginFile(directory);
    await writeFile(wordpressMuPlugin, treeWordPressMuPlugin(tree.host));
  }
  await writeFile(
    treeOverrideFile(directory),
    treeOverride(services, env, await nextTreeSubnet(), wordpressMuPlugin),
  );
}

/** Compose services get these too: an image built without a Dockerfile (Supabase's edge runtime) still runs `npm:` installs. */
export function treeServiceEnv(env: TreeEnv): Record<string, string> {
  const shop = treeShopEnv(env);
  return {
    NPM_CONFIG_REGISTRY: shop["NPM_CONFIG_REGISTRY"] ?? "",
    PIP_INDEX_URL: shop["PIP_INDEX_URL"] ?? "",
    PIP_TRUSTED_HOST: shop["PIP_TRUSTED_HOST"] ?? "",
  };
}

/**
 * WordPress's HTTP API refuses a private host or an unusual port (`wp plugin
 * install <zip URL>` fails with "A valid URL was not provided"), so a tree shop
 * mounts this must-use plugin to allow exactly the registry.
 */
export function treeWordPressMuPlugin(host: string): string {
  return `<?php
// Written by the trial harness: lets WordPress download from this machine's package mirror.
add_filter('http_request_host_is_external', static fn ($external, $requested) => $requested === '${host}' ? true : $external, 10, 2);
add_filter('http_allowed_safe_ports', static fn ($ports, $requested) => $requested === '${host}' ? array_merge($ports, [${TREE_REGISTRY_PORT}]) : $ports, 10, 2);
`;
}

const WORDPRESS_MU_TARGET = "/var/www/html/wp-content/mu-plugins/trial-package-mirror.php";

/**
 * Each shop file holding the registry's address, not counting the harness's
 * own Dockerfile lines. Throwaway shops are not harmed; a merchant would ship
 * a `resolved` URL or a `Gemfile.lock` remote pointing at this machine, so the
 * report names the files.
 */
export async function registryLeaks(directory: string, address: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: directory,
    maxBuffer: 64 * 1024 * 1024,
  });
  const leaks: string[] = [];
  for (const file of stdout.split("\0").filter(Boolean)) {
    let text: string;
    try {
      text = await readFile(path.join(directory, file), "utf8");
    } catch {
      continue;
    }
    const kept = /^Dockerfile/.test(path.basename(file))
      ? text
          .split("\n")
          .filter((line) => !harnessDockerfileLine(line))
          .join("\n")
      : text;
    const count = kept.split(address).length - 1;
    if (count > 0) leaks.push(`${file}: ${count}`);
  }
  return leaks;
}

/** The first free /24 above `TREE_SUBNET_BASE`, skipping what Docker and this run already use. */
export function pickSubnet(used: ReadonlySet<string>, handedOut: ReadonlySet<string>): string {
  for (let block = 1; block < 255; block += 1) {
    const subnet = `${TREE_SUBNET_BASE}.${block}.0/24`;
    if (!used.has(subnet) && !handedOut.has(subnet)) return subnet;
  }
  throw new InfraError(`No free /24 left in ${TREE_SUBNET_BASE}.0.0/16.`);
}

const handedOutSubnets = new Set<string>();

/**
 * One subnet per shop, outside Docker's default pools: those run out once a
 * host keeps shops and other stacks, and a sweep cannot wait for them.
 */
async function nextTreeSubnet(): Promise<string> {
  const { stdout: ids } = await execFileAsync("docker", ["network", "ls", "-q"], {
    timeout: 15_000,
  });
  const networkIds = ids.split("\n").filter(Boolean);
  const { stdout } = await execFileAsync(
    "docker",
    ["network", "inspect", "-f", "{{range .IPAM.Config}}{{.Subnet}} {{end}}", ...networkIds],
    { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
  );
  const used = new Set(stdout.split(/\s+/).filter(Boolean));
  const subnet = pickSubnet(used, handedOutSubnets);
  handedOutSubnets.add(subnet);
  return subnet;
}

export function treeOverride(
  services: readonly string[],
  env: TreeEnv,
  subnet: string,
  wordpressMuPlugin?: string,
): string {
  const lines = ["# Written by the trial harness: this machine's package mirror.", "services:"];
  for (const name of services) {
    lines.push(`  ${name}:`, "    environment:");
    for (const [key, value] of Object.entries(treeServiceEnv(env))) {
      lines.push(`      ${key}: ${JSON.stringify(value)}`);
    }
    if (wordpressMuPlugin !== undefined && (name === "wordpress" || name === "cli")) {
      lines.push(
        "    volumes:",
        "      - type: bind",
        `        source: ${JSON.stringify(wordpressMuPlugin)}`,
        `        target: ${WORDPRESS_MU_TARGET}`,
        "        read_only: true",
      );
    }
  }
  lines.push(
    "networks:",
    "  default:",
    "    ipam:",
    "      config:",
    `        - subnet: ${JSON.stringify(subnet)}`,
    "",
  );
  return lines.join("\n");
}
