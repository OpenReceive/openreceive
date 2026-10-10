import { mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { InfraError } from "./docker.ts";

export interface MerchantCodes {
  readonly nwc: string;
  readonly lsc: string;
  readonly lscBackup?: string;
  /** NWC_URI_VERCEL: a separate receive-only code that the Vercel trial stores in Vercel. */
  readonly nwcVercel?: string;
}

const REQUIRED = [
  ["NWC_URI", "nostr+walletconnect://"],
  ["LSC_URI_PRIMARY", "lightning+swapconnect://"],
] as const;

/** KEY=VALUE lines from a dotenv file. Values are never logged. */
export function parseEnv(text: string): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    let key = trimmed.slice(0, eq).trim();
    if (key.startsWith("export ")) key = key.slice("export ".length).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    values[key] = unquote(trimmed.slice(eq + 1).trim());
  }
  return values;
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    const inner = value.slice(1, -1);
    return value.startsWith('"') ? inner.replace(/\\n/g, "\n").replace(/\\"/g, '"') : inner;
  }
  return value;
}

/** A run with a truncated code wastes a model session; check the shape before it starts. */
function wellFormedNwc(uri: string): boolean {
  const match = uri.match(/^nostr\+walletconnect:\/\/([0-9a-f]{64})\?(.+)$/);
  return match !== null && /(?:^|&)secret=[0-9a-f]{64}(?:&|$)/.test(match[2] ?? "");
}

/**
 * Live codes from the repo-root `.env`. Missing keys fail closed.
 * The returned strings must not be written to the Cursor process environment.
 */
export async function loadMerchantCodes(envFile: string): Promise<MerchantCodes> {
  let text: string;
  try {
    text = await readFile(envFile, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new InfraError("Missing NWC_URI and LSC_URI_PRIMARY in the repo-root .env.");
    }
    throw new InfraError("Could not read the repo-root .env.");
  }
  const values = parseEnv(text);
  const missing = REQUIRED.filter(([key]) => values[key] === undefined || values[key] === "").map(
    ([key]) => key,
  );
  if (missing.length > 0) {
    throw new InfraError(`Missing ${missing.join(" and ")} in the repo-root .env.`);
  }
  for (const [key, prefix] of REQUIRED) {
    if (!values[key]?.startsWith(prefix)) {
      throw new InfraError(`${key} in the repo-root .env does not start with ${prefix}`);
    }
  }
  const backup = values.LSC_URI_BACKUP ?? "";
  if (backup.length > 0 && !backup.startsWith("lightning+swapconnect://")) {
    throw new InfraError(
      "LSC_URI_BACKUP in the repo-root .env does not start with lightning+swapconnect://",
    );
  }
  const vercel = values.NWC_URI_VERCEL ?? "";
  for (const [key, value] of [
    ["NWC_URI", values.NWC_URI ?? ""],
    ["NWC_URI_VERCEL", vercel],
  ] as const) {
    if (value.length > 0 && !wellFormedNwc(value)) {
      throw new InfraError(
        `${key} in the repo-root .env is not a complete NWC code: it needs a 64-hex wallet key and a 64-hex secret. A copy of the shortened display form (with "…") fails here.`,
      );
    }
  }
  return {
    nwc: values.NWC_URI ?? "",
    lsc: values.LSC_URI_PRIMARY ?? "",
    lscBackup: backup.length > 0 ? backup : undefined,
    nwcVercel: vercel.length > 0 ? vercel : undefined,
  };
}

/**
 * One live wallet. A second trial process must not paste the same codes while this
 * process still holds the lock.
 */
export async function acquireLiveWalletLock(directory: string): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, ".live-wallet.lock");
  const take = async (): Promise<void> => {
    const handle = await open(file, "wx");
    await handle.writeFile(`${process.pid}\n`);
    await handle.close();
  };
  try {
    await take();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = Number((await readFile(file, "utf8")).trim());
    let alive = false;
    if (Number.isInteger(existing) && existing > 0) {
      try {
        process.kill(existing, 0);
        alive = true;
      } catch (killError) {
        if ((killError as NodeJS.ErrnoException).code !== "ESRCH") alive = true;
      }
    }
    if (alive) {
      throw new InfraError(
        `Another agent trial is already using the live wallet codes (pid ${existing}).`,
      );
    }
    await unlink(file).catch(() => undefined);
    try {
      await take();
    } catch {
      throw new InfraError("Another agent trial is already using the live wallet codes.");
    }
  }
  return async () => {
    try {
      const current = Number((await readFile(file, "utf8")).trim());
      if (current === process.pid) await unlink(file);
    } catch {
      // The lock is already gone.
    }
  };
}
