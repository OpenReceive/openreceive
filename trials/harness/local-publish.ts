import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { compose } from "./docker.ts";
import { check, liveShopChecks, type PaidPath, sourceTexts } from "./live.ts";
import { platformEnvFile } from "./sandbox.ts";
import type { Check } from "./types.ts";

// A Replit publish, played on this machine. A published Replit app gets its
// own empty production database and a fresh build of the code, with the same
// Secrets. So after the agent finishes, the harness creates an empty database,
// points the app's DATABASE_URL at it, rebuilds and restarts the web service,
// and checks the shop live. Nothing reaches Replit: a pass shows that the
// integration survives a publish, not that Replit itself ran it.

const PRODUCTION_DATABASE = "shop_production";
const PUBLISH_TIMEOUT_MS = 10 * 60 * 1000;

/** The platform variables with DATABASE_URL moved to another database on the same server. */
export function withDatabase(envText: string, database: string): string {
  return envText.replace(/^(DATABASE_URL=[^\n]*\/)[^/?\n]+/m, `$1${database}`);
}

async function webLogs(directory: string): Promise<string> {
  return compose(directory, ["logs", "--no-color", "--tail", "30", "web"], 30_000)
    .then((result) => result.stdout.trim())
    .catch(() => "");
}

export async function localPublishChecks(
  directory: string,
  baseUrl: string,
  log: (line: string) => void,
  paid?: PaidPath,
): Promise<Check[]> {
  const texts = await sourceTexts(directory);
  const worker = [...texts].find(([, text]) => /startNotificationWorker/.test(text));
  const checks = [
    check(
      "no_worker",
      worker === undefined,
      "The agent added no notifications worker; settlement runs on requests, so Autoscale fits.",
      worker === undefined ? undefined : path.relative(directory, worker[0]),
    ),
  ];

  log(`publish: empty ${PRODUCTION_DATABASE} database`);
  await compose(
    directory,
    ["exec", "-T", "postgres", "createdb", "-U", "shop", PRODUCTION_DATABASE],
    60_000,
  );
  const envFile = platformEnvFile(directory);
  await writeFile(envFile, withDatabase(await readFile(envFile, "utf8"), PRODUCTION_DATABASE), {
    mode: 0o600,
  });

  log("publish: rebuild and restart web");
  const failure = await compose(
    directory,
    ["up", "-d", "--build", "--force-recreate", "--wait", "--wait-timeout", "300", "web"],
    PUBLISH_TIMEOUT_MS,
  )
    .then(() => undefined)
    .catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return `${message}\n${await webLogs(directory)}`.trim();
    });
  checks.push(
    check(
      "publish_started",
      failure === undefined,
      "The shop rebuilt and started on an empty production database.",
      failure,
    ),
  );
  if (failure !== undefined) return checks;

  log(`publish: live ${baseUrl}`);
  const live = await liveShopChecks(baseUrl, { paid });
  // A failed invoice on a fresh database is most often a missing table: show why.
  if (live.some((item) => !item.pass)) {
    const logs = await webLogs(directory);
    return [
      ...checks,
      ...live.map((item) =>
        item.pass ? item : { ...item, evidence: `${item.evidence ?? ""}\n${logs}`.trim() },
      ),
    ];
  }
  return [...checks, ...live];
}
