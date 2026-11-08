import type { Dirent } from "node:fs";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { LSC_ENV_NAMES } from "./lsc-uri.ts";
import { redactSecrets } from "./service/logging.ts";

// `LSC_URI` is not a name the library reads, but a code saved under it still leaks.
const CODE_NAMES = ["NWC_URI", "LSC_URI", ...LSC_ENV_NAMES] as const;
const CREDENTIAL_PARAMETERS = new Set(["secret", "key"]);
// Anything shorter could turn up in a build by chance.
const MIN_SEARCH_BYTES = 16;
const CHUNK_BYTES = 1024 * 1024;

interface SearchedCode {
  readonly name: string;
  readonly needles: readonly Buffer[];
}

/**
 * Did a wallet or swap code reach a build? An agent can answer that with grep
 * only by putting part of a code on a command line, so this reads the codes
 * from the environment and env files itself, and reports code names and
 * relative paths, never any part of a value.
 */
export function scanBuild(input: {
  readonly dir: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly envFiles: readonly string[];
}): { ok: boolean; lines: string[] } {
  const shown = (target: string) => path.relative(input.cwd, target) || ".";
  const failure = (line: string) => ({ ok: false, lines: [`scan-build: ${line}`] });
  const root = path.resolve(input.cwd, input.dir);
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    return failure(
      `no directory at ${redactSecrets(shown(root))}. Run the production build first, or pass the folder it writes to.`,
    );
  }
  const codes = codesToSearch(input);
  if (codes.length === 0) {
    return failure(
      "no NWC_URI or LSC_URI_* code is set here, so there is nothing to search for. Run this from the app, where its env file is.",
    );
  }

  const longest = Math.max(...codes.flatMap((code) => code.needles.map((n) => n.length)));
  const buffer = Buffer.alloc(Math.max(CHUNK_BYTES, longest * 2));
  const findings: string[] = [];
  const unreadable: string[] = [];
  let searched = 0;
  for (const file of filesUnder(root, unreadable)) {
    searched += 1;
    try {
      for (const name of codesInFile(file, codes, buffer, longest - 1)) {
        findings.push(`${name} found in ${shown(file)}`);
      }
    } catch {
      unreadable.push(file);
    }
  }

  // A file nobody could read is not a file known to be clean.
  const lines = [
    ...findings.sort(),
    ...unreadable.map((file) => `scan-build: could not read ${shown(file)}`).sort(),
  ];
  if (findings.length > 0) {
    lines.push(
      "scan-build: keep these codes out of browser code and public env names (NEXT_PUBLIC_, VITE_, NUXT_PUBLIC_), rebuild, and scan again.",
    );
  }
  if (lines.length > 0) return { ok: false, lines };
  if (searched === 0) {
    return failure(`no files in ${shown(root)}. Run the production build first.`);
  }
  const names = codes.map((code) => code.name).join(", ");
  return {
    ok: true,
    lines: [
      `scan-build: no code found in ${searched} file${searched === 1 ? "" : "s"} under ${shown(root)} (${names})`,
    ],
  };
}

/**
 * Every value each name holds in the environment or any env file. A build may
 * have read a different file than this run would, so no value hides another.
 */
function codesToSearch(input: {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly envFiles: readonly string[];
}): SearchedCode[] {
  const sources: Record<string, string | undefined>[] = [input.env];
  for (const name of input.envFiles) {
    const file = path.join(input.cwd, name);
    if (existsSync(file)) sources.push(parseEnv(readFileSync(file, "utf8")));
  }
  const codes: SearchedCode[] = [];
  for (const name of CODE_NAMES) {
    const values = new Set(sources.flatMap((source) => source[name]?.trim() || []));
    const needles = [...values].flatMap(needlesFor);
    if (needles.length > 0) codes.push({ name, needles });
  }
  return codes;
}

/**
 * The bytes that prove a code reached a build. The whole URI finds an intact
 * copy; each credential value alone finds a URI that a bundler split, or
 * escaped so its `&` no longer matches. Base64 finds an inline source map.
 */
function needlesFor(code: string): Buffer[] {
  const forms = new Set([code, encodeURIComponent(code)]);
  for (const pair of code.slice(code.indexOf("?") + 1).split("&")) {
    const [parameter = "", ...rest] = pair.split("=");
    if (!CREDENTIAL_PARAMETERS.has(parameter)) continue;
    const raw = rest.join("=");
    const decoded = new URLSearchParams(`v=${raw}`).get("v") ?? raw;
    forms.add(raw).add(decoded).add(encodeURIComponent(decoded));
  }
  return [...forms]
    .map((form) => Buffer.from(form))
    .filter((form) => form.length >= MIN_SEARCH_BYTES)
    .flatMap((form) => [form, ...base64Forms(form)]);
}

/**
 * A value inside base64 starts at one of three byte offsets, and each encodes
 * it differently. The characters that share bits with its neighbours are left out.
 */
function base64Forms(form: Buffer): Buffer[] {
  return [0, 1, 2].map((shift) => {
    const encoded = Buffer.concat([Buffer.alloc(shift), form]).toString("base64");
    const start = Math.ceil((shift * 8) / 6);
    const end = Math.floor(((shift + form.length) * 8) / 6);
    return Buffer.from(encoded.slice(start, end));
  });
}

/** Regular files only: a symlink can point out of the build or back into it. */
function* filesUnder(root: string, unreadable: string[]): Generator<string> {
  const pending = [root];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      unreadable.push(dir);
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile()) yield full;
      else if (entry.isDirectory() && entry.name !== "node_modules") pending.push(full);
    }
  }
}

/**
 * Read as bytes, one chunk at a time, so a binary file cannot throw and memory
 * does not grow with the file. Each read keeps the last `overlap` bytes, so a
 * value that straddles two chunks is still found.
 */
function codesInFile(
  file: string,
  codes: readonly SearchedCode[],
  buffer: Buffer,
  overlap: number,
): string[] {
  const found = new Set<string>();
  const descriptor = openSync(file, "r");
  try {
    let carried = 0;
    for (;;) {
      const read = readSync(descriptor, buffer, carried, buffer.length - carried, null);
      if (read === 0) return [...found];
      const chunk = buffer.subarray(0, carried + read);
      for (const { name, needles } of codes) {
        if (needles.some((needle) => chunk.includes(needle))) found.add(name);
      }
      carried = Math.min(overlap, chunk.length);
      chunk.copyWithin(0, chunk.length - carried);
    }
  } finally {
    closeSync(descriptor);
  }
}
