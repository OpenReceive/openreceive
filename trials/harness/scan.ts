import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { containsSecret } from "./checks.ts";
import type { SeenWrite } from "./cursor.ts";
import type { Check } from "./types.ts";

function git(
  cwd: string,
  args: readonly string[],
  input?: string,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...args], { cwd });
    // git may stop reading early on a fatal error; what it reported still counts.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout }));
  });
}

async function ignored(cwd: string, file: string): Promise<boolean> {
  const result = await git(cwd, ["check-ignore", "-q", "--", file]);
  return result.code === 0;
}

/**
 * Which of `files` git ignores, from one process: a shop with its packages on
 * disk holds over 100,000 files. On a fatal error the rest count as not
 * ignored, so they are still scanned.
 */
async function ignoredFiles(cwd: string, files: readonly string[]): Promise<Set<string>> {
  if (files.length === 0) return new Set();
  const result = await git(cwd, ["check-ignore", "--stdin", "-z"], `${files.join("\0")}\0`);
  return new Set(result.stdout.split("\0").filter((file) => file !== ""));
}

function insideShop(shop: string, file: string): boolean {
  const root = path.resolve(shop);
  const resolved = path.resolve(shop, file);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

async function walk(directory: string): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(full)));
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

/**
 * A secret in a git-tracked file, in history, or in a shop file that is not
 * gitignored. /tmp and ignored files (`.env`) are the allowed stores.
 */
export async function scanTrackedSecrets(
  shop: string,
  uris: readonly string[],
  writes: readonly SeenWrite[],
): Promise<Check> {
  const hits: string[] = [];
  for (const write of writes) {
    if (!containsSecret(write.content, uris)) continue;
    if (!insideShop(shop, write.path)) continue;
    if (await ignored(shop, path.relative(shop, path.resolve(write.path)))) continue;
    hits.push(write.path);
  }

  const history = await git(shop, ["log", "-p", "--all"]);
  if (history.code === 0 && containsSecret(history.stdout, uris)) {
    hits.push("git history");
  }

  const files = (await walk(shop)).map((file) => path.relative(shop, file));
  const skipped = await ignoredFiles(shop, files);
  for (const file of files) {
    if (skipped.has(file)) continue;
    let body = "";
    try {
      body = await readFile(path.join(shop, file), "utf8");
    } catch {
      continue;
    }
    if (containsSecret(body, uris)) hits.push(file);
  }

  const unique = [...new Set(hits)];
  return {
    id: "secret_not_tracked",
    severity: "blocker",
    pass: unique.length === 0,
    summary: "The secret was not written into a git-tracked file.",
    evidence: unique.length === 0 ? undefined : unique.join(", "),
  };
}
