import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  formatInvalidNwcMessage,
  NwcUriParseError,
  OPENRECEIVE_NWC_CODE_HELP_URL,
  parseNwcUri,
} from "@openreceive/core";
import { createNwcReceiveClient } from "./alby-nwc.ts";
import { readLscConnectionsFromEnvironment } from "./lsc-uri.ts";
import { runScaffoldPayments, SCAFFOLD_PAYMENTS_HELP } from "./scaffold/index.ts";
import { redactSecrets } from "./service/logging.ts";

export interface CliIo {
  write(message: string): void;
}

/** The two doctor probe methods a wallet client must answer. */
export interface DoctorWalletClient {
  preflight(): Promise<{
    readonly methods: readonly string[];
    readonly spendCapabilityAdvertised: boolean;
    readonly warnings: readonly string[];
  }>;
  close(): Promise<void>;
}

export interface CliOptions {
  readonly argv: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly stdout?: CliIo;
  readonly stderr?: CliIo;
  readonly stdin?: NodeJS.ReadableStream;
  readonly isTTY?: boolean;
  readonly prompt?: (question: string) => Promise<string>;
  /**
   * Testing seam for `doctor`: builds the wallet client the relay probe uses.
   * Defaults to the real NWC client.
   */
  readonly walletClientFactory?: (options: {
    connectionString: string;
    allowSpendCapableWallet: boolean;
    spendCapabilityWarning: (message: string) => void;
  }) => DoctorWalletClient;
}

const HELP = `
Usage: openreceive <command> [options]

Commands:
  doctor              Validate server configuration: Node, NWC_URI, swap
                      providers, and a receive-only wallet probe over the relay.
                      --db and --url extend the checks; exits 1 on problems.
  debug-report        Print the same diagnostics as a redacted support report
                      (alias of doctor; always exits 0).
  scaffold payments   Emit the openreceive_payments + openreceive_meta migration and wiring guide for your ORM.

Options:
  -h, --help           Show this help.

Doctor options:
  --db <target>             Also check the payment tables exist: a SQLite file
                            path, or a postgres:// / mysql:// URL (the matching
                            driver is loaded from this project's node_modules).
  --url <base-url>          Also check the OpenReceive routes answer on a
                            running app, e.g. --url http://localhost:3000.
  --prefix <path>           Route prefix for --url (default /openreceive).
  --table-name <name>       Payments table for --db (default openreceive_payments).
  --meta-table-name <name>  Reconcile-gate table for --db (default openreceive_meta).
  --offline                 Skip the wallet relay probe.
`.trim();

export async function runCli(options: CliOptions): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const [command = "help", ...args] = options.argv;
  try {
    if (["help", "--help", "-h"].includes(command)) {
      stdout.write(`${HELP}\n`);
      return 0;
    }
    if (command === "doctor" || command === "debug-report") {
      return await runDiagnostics({
        command,
        flags: parseDiagnosticsArgv(args),
        env,
        cwd,
        stdout,
        walletClientFactory: options.walletClientFactory,
      });
    }
    if (command === "scaffold") {
      const [target = "help", ...scaffoldArgs] = args;
      if (target === "help" || target === "--help" || target === "-h") {
        stdout.write(`${SCAFFOLD_PAYMENTS_HELP}\n`);
        return 0;
      }
      if (target !== "payments") {
        throw new Error(`Unknown scaffold target: ${target}. Only "payments" is supported.`);
      }
      return await runScaffoldPayments({
        argv: scaffoldArgs,
        cwd,
        stdout,
        stderr,
        stdin: options.stdin,
        isTTY: options.isTTY,
        prompt: options.prompt,
      });
    }
    stderr.write(`Unknown OpenReceive command: ${command}\n\n${HELP}\n`);
    return 1;
  } catch (error) {
    stderr.write(`${safeErrorMessage(error)}\n`);
    return 1;
  }
}

interface DiagnosticsFlags {
  readonly db?: string;
  readonly url?: string;
  readonly prefix: string;
  readonly tableName: string;
  readonly metaTableName: string;
  readonly offline: boolean;
}

function parseDiagnosticsArgv(args: readonly string[]): DiagnosticsFlags {
  const flags = {
    db: undefined as string | undefined,
    url: undefined as string | undefined,
    prefix: "/openreceive",
    tableName: "openreceive_payments",
    metaTableName: "openreceive_meta",
    offline: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const valueFor = (name: string): string => {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${name} needs a value. See \`openreceive --help\`.`);
      }
      index += 1;
      return value;
    };
    if (arg === "--db") flags.db = valueFor("--db");
    else if (arg === "--url") flags.url = valueFor("--url");
    else if (arg === "--prefix") flags.prefix = valueFor("--prefix");
    else if (arg === "--table-name") flags.tableName = valueFor("--table-name");
    else if (arg === "--meta-table-name") flags.metaTableName = valueFor("--meta-table-name");
    else if (arg === "--offline") flags.offline = true;
    else throw new Error(`Unexpected option: ${arg}. See \`openreceive --help\`.`);
  }
  if (!flags.prefix.startsWith("/")) flags.prefix = `/${flags.prefix}`;
  return flags;
}

const WALLET_PROBE_TIMEOUT_MS = 10_000;
const HTTP_PROBE_TIMEOUT_MS = 5_000;
// Mirrors the service's override parsing ("Use 1/true/yes to enable.").
const SPEND_OVERRIDE_TRUE = new Set(["1", "true", "yes"]);

interface CheckResult {
  readonly ok: boolean;
  readonly lines: readonly string[];
}

async function runDiagnostics(input: {
  readonly command: "doctor" | "debug-report";
  readonly flags: DiagnosticsFlags;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly stdout: CliIo;
  readonly walletClientFactory?: CliOptions["walletClientFactory"];
}): Promise<number> {
  const { flags, env } = input;
  const nwc = env.NWC_URI?.trim();
  let nwcError: unknown;
  try {
    if (nwc) parseNwcUri(nwc);
  } catch (error) {
    nwcError =
      error instanceof NwcUriParseError
        ? new Error(formatInvalidNwcMessage({ reason: error.description }))
        : error;
  }
  let lscConnections = 0;
  let lscError: unknown;
  try {
    lscConnections = readLscConnectionsFromEnvironment(env).length;
  } catch (error) {
    lscError = error;
  }

  const lines = [
    `OpenReceive ${input.command}`,
    `node: ${process.version}`,
    `cwd: ${input.cwd}`,
    "storage: payment-attempt rows live in the host database (no separate store)",
    `NWC_URI: ${nwcError === undefined ? (nwc ? "present-redacted" : "missing") : safeErrorMessage(nwcError)}`,
    `LSC_URI connections: ${lscError === undefined ? lscConnections : safeErrorMessage(lscError)}`,
  ];
  let failed = nwcError !== undefined || !nwc || lscError !== undefined;

  if (nwc && nwcError === undefined && !flags.offline) {
    const wallet = await probeWallet({
      nwc,
      env,
      walletClientFactory: input.walletClientFactory,
    });
    failed = failed || !wallet.ok;
    lines.push(...wallet.lines);
  } else if (flags.offline) {
    lines.push("wallet: probe skipped (--offline)");
  } else {
    lines.push("wallet: probe skipped (no parseable NWC_URI to probe)");
  }

  if (flags.db === undefined) {
    lines.push(
      "database: skipped — pass --db <sqlite file | postgres:// | mysql:// URL> to check the payment tables exist",
    );
  } else {
    const database = await checkDatabaseMigrated({ ...flags, db: flags.db, cwd: input.cwd });
    failed = failed || !database.ok;
    lines.push(...database.lines);
  }

  if (flags.url === undefined) {
    lines.push(
      "routes: skipped — pass --url http://localhost:3000 to check the OpenReceive routes answer",
    );
  } else {
    const routes = await checkRoutesMounted({ url: flags.url, prefix: flags.prefix });
    failed = failed || !routes.ok;
    lines.push(...routes.lines);
  }

  input.stdout.write(`${lines.join("\n")}\n`);
  // doctor is a health gate (non-zero on problems); debug-report is a support
  // artifact — a missing NWC_URI is exactly what it exists to show, so it
  // always exits 0.
  if (input.command === "debug-report") return 0;
  return failed ? 1 : 0;
}

/**
 * Connect to the wallet relay and prove the code is receive-only, exactly as
 * boot preflight would — so `doctor` catches a spend-capable or unreachable
 * wallet before the first payer does.
 */
async function probeWallet(input: {
  readonly nwc: string;
  readonly env: NodeJS.ProcessEnv;
  readonly walletClientFactory?: CliOptions["walletClientFactory"];
}): Promise<CheckResult> {
  const allowSpendCapableWallet = SPEND_OVERRIDE_TRUE.has(
    input.env.OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC?.trim().toLowerCase() ?? "",
  );
  const overrideWarnings: string[] = [];
  const factory =
    input.walletClientFactory ??
    ((options: {
      connectionString: string;
      allowSpendCapableWallet: boolean;
      spendCapabilityWarning: (message: string) => void;
    }): DoctorWalletClient => createNwcReceiveClient(options));
  const client = factory({
    connectionString: input.nwc,
    allowSpendCapableWallet,
    spendCapabilityWarning: (message) => overrideWarnings.push(message),
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const summary = await Promise.race([
      client.preflight(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `no relay answered within ${WALLET_PROBE_TIMEOUT_MS / 1000}s. Check the network and the wss relay in the NWC code, or rerun with --offline to skip the probe.`,
            ),
          );
        }, WALLET_PROBE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
    if (summary.spendCapabilityAdvertised) {
      // Reachable only with the explicit override; without it preflight throws.
      return {
        ok: false,
        lines: [
          `wallet: reachable but SPEND-CAPABLE (override active). A leaked code can drain this wallet — mint a receive-only code: ${OPENRECEIVE_NWC_CODE_HELP_URL}`,
          ...summary.warnings.map((warning) => `wallet: ${warning}`),
        ],
      };
    }
    return {
      ok: true,
      lines: [
        `wallet: reachable, receive-only (${summary.methods.join(", ")})`,
        ...summary.warnings.map((warning) => `wallet: ${warning}`),
      ],
    };
  } catch (error) {
    return { ok: false, lines: [`wallet: ${safeErrorMessage(error)}`] };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    try {
      await client.close();
    } catch {
      // Closing a half-connected probe client must not mask the probe result.
    }
  }
}

/**
 * Prove the scaffolded migration was actually applied: both tables exist in
 * the database the host will hand to OpenReceive. SQLite uses the built-in
 * driver; postgres/mysql load `pg` / `mysql2` from the host project, which has
 * them if it talks to that database at all.
 */
async function checkDatabaseMigrated(input: {
  readonly db: string;
  readonly cwd: string;
  readonly tableName: string;
  readonly metaTableName: string;
}): Promise<CheckResult> {
  const fix = `run \`npx openreceive scaffold payments --orm <your orm>\` and apply the emitted migration through your normal workflow — https://openreceive.org/guides/storage.md`;
  try {
    const present = await listPresentTables(input);
    const missing = [input.tableName, input.metaTableName].filter(
      (table) => !present.includes(table),
    );
    if (missing.length === 0) {
      return {
        ok: true,
        lines: [`database: ${input.tableName} and ${input.metaTableName} present`],
      };
    }
    return {
      ok: false,
      lines: [`database: ${missing.join(" and ")} missing — the migration has not run; ${fix}`],
    };
  } catch (error) {
    return { ok: false, lines: [`database: ${safeErrorMessage(error)}`] };
  }
}

async function listPresentTables(input: {
  readonly db: string;
  readonly cwd: string;
  readonly tableName: string;
  readonly metaTableName: string;
}): Promise<string[]> {
  const tables = [input.tableName, input.metaTableName];
  if (/^postgres(ql)?:/.test(input.db)) {
    const pg = await importFromHostProject<{
      Client: new (
        options: object,
      ) => {
        connect(): Promise<void>;
        query(sql: string, values: string[]): Promise<{ rows: Record<string, unknown>[] }>;
        end(): Promise<void>;
      };
    }>("pg", input.cwd);
    const client = new pg.Client({
      connectionString: input.db,
      connectionTimeoutMillis: HTTP_PROBE_TIMEOUT_MS,
    });
    await client.connect();
    try {
      const result = await client.query(
        "SELECT to_regclass($1) AS a, to_regclass($2) AS b",
        tables,
      );
      const row = result.rows[0] ?? {};
      return tables.filter((_, index) => row[index === 0 ? "a" : "b"] !== null);
    } finally {
      await client.end();
    }
  }
  if (/^mysql:/.test(input.db)) {
    const mysql = await importFromHostProject<{
      createConnection(url: string): Promise<{
        query(sql: string, values: string[]): Promise<[Record<string, unknown>[], unknown]>;
        end(): Promise<void>;
      }>;
    }>("mysql2/promise", input.cwd);
    const connection = await mysql.createConnection(input.db);
    try {
      const [rows] = await connection.query(
        "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN (?, ?)",
        tables,
      );
      return rows.map((row) => String(row.name));
    } finally {
      await connection.end();
    }
  }
  const sqlitePath = path.isAbsolute(input.db) ? input.db : path.join(input.cwd, input.db);
  if (!existsSync(sqlitePath)) {
    throw new Error(
      `no SQLite database at ${sqlitePath}. Pass the file your app opens, or a postgres:// / mysql:// URL.`,
    );
  }
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const rows = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)")
      .all(...tables) as { name: string }[];
    return rows.map((row) => row.name);
  } finally {
    database.close();
  }
}

/** Import a database driver from the project the CLI runs in, not from ours. */
async function importFromHostProject<T>(specifier: string, cwd: string): Promise<T> {
  let resolved: string;
  try {
    resolved = createRequire(path.join(cwd, "package.json")).resolve(specifier);
  } catch {
    throw new Error(
      `this database needs the ${JSON.stringify(specifier.split("/")[0])} driver, which is not installed here. Install it (\`npm install ${specifier.split("/")[0]}\`) or point --db at the SQLite file directly.`,
    );
  }
  const mod = (await import(pathToFileURL(resolved).href)) as { default?: T } & T;
  return (mod.default ?? mod) as T;
}

/**
 * Prove the OpenReceive router actually answers on the running app: any
 * unknown path under the prefix returns the router's own JSON 404, which no
 * framework fallback produces.
 */
async function checkRoutesMounted(input: {
  readonly url: string;
  readonly prefix: string;
}): Promise<CheckResult> {
  const base = input.url.replace(/\/+$/, "");
  const prefix = input.prefix.replace(/\/+$/, "");
  const probe = `${base}${prefix}/__doctor-probe__`;
  const fix = `mount the router (\`app.use(openreceive)\` — https://openreceive.org/guides/quickstart-node.md), or pass --prefix if it is mounted somewhere other than ${prefix}`;
  let response: Response;
  try {
    response = await fetch(probe, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(HTTP_PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      lines: [
        `routes: could not reach ${base} (${safeErrorMessage(error)}) — is the app running at that URL?`,
      ],
    };
  }
  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    body = undefined;
  }
  const message =
    typeof body === "object" && body !== null && "message" in body
      ? String((body as { message: unknown }).message)
      : "";
  if (message.startsWith("No OpenReceive route matched")) {
    return { ok: true, lines: [`routes: OpenReceive router answering at ${base}${prefix}`] };
  }
  return {
    ok: false,
    lines: [
      `routes: nothing OpenReceive answered at ${base}${prefix} (HTTP ${response.status}) — ${fix}`,
    ],
  };
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return redactSecrets(error.message);
  if (typeof error === "string") return redactSecrets(error);
  return "OpenReceive command failed.";
}

export {
  finalizeScaffoldOptions,
  parseScaffoldPaymentsArgv,
  renderScaffoldPaymentsFiles,
  runScaffoldPayments,
} from "./scaffold/index.ts";
