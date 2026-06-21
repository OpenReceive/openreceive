import {
  mkdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  OpenReceiveExpressOptions,
  OpenReceiveExpressPollingRunnerStartOptions
} from "@openreceive/express";
import {
  InMemoryInvoiceStore
} from "@openreceive/core";
import {
  OPENRECEIVE_POSTGRES_MIGRATION_SQL,
  OpenReceivePostgresInvoiceStore
} from "./postgres-store.ts";
import {
  OPENRECEIVE_SQLITE_MIGRATION_SQL,
  OpenReceiveSqliteInvoiceStore,
  createOpenReceiveSqliteQueryClient,
  migrateOpenReceiveSqlite,
  type OpenReceiveSqliteQueryClient,
  type OpenReceiveSqliteDatabase
} from "./sqlite-store.ts";
import {
  OPENRECEIVE_DATABASE_SCHEMA_VERSION,
  OPENRECEIVE_SCHEMA_MIGRATIONS_TABLE
} from "./storage-schema.ts";

export interface OpenReceiveCliIo {
  write(message: string): void;
}

export interface OpenReceiveCliOptions {
  argv: readonly string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  stdout?: OpenReceiveCliIo;
  stderr?: OpenReceiveCliIo;
  loadSqlite?: () => Promise<{
    DatabaseSync: new (filename: string) => OpenReceiveSqliteDatabase & {
      close?: () => void;
    };
  }>;
  loadPostgres?: () => Promise<{
    Pool: new (options: { connectionString: string }) => {
      query(sql: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
      end(): Promise<void>;
    };
  }>;
  loadConfigModule?: (specifier: string) => Promise<Record<string, unknown>>;
  loadExpressRunners?: () => Promise<OpenReceiveExpressRunnerModule>;
}

type OpenReceiveDatabaseTarget =
  | {
      kind: "sqlite";
      path: string;
    }
  | {
      kind: "postgres";
      url: string;
    };

const HELP = `
Usage: openreceive <command> [options]

Commands:
  init                 Generate server-only config, env, and worker stubs.
  migrate             Run package-owned OpenReceive database migrations.
  doctor              Check database, migration, NWC, and runner readiness.
  worker              Run polling and notification listening in one process.
  poll                Run the package-owned settlement polling runner.
  listen              Run the package-owned payment notification listener.

Database options:
  --sqlite <path>      Use a SQLite database file.
  --postgres <url>     Use a Postgres connection URL.
  --database-url <url> Use DATABASE_URL-style detection.
  --print             Print migration SQL instead of executing it.

Runner/config options:
  --config <path>      Import a server-only module. Defaults to openreceive.config.mjs.
  --once               Poll recoverable invoices once, then exit.
  --ready-only         Start worker/listen once to verify readiness, then exit.
`.trim();
const REQUIRED_INVOICE_COLUMNS = [
  "invoice_id",
  "merchant_scope",
  "operation",
  "idempotency_key",
  "idempotency_request_hash",
  "payment_hash",
  "invoice",
  "amount_msats",
  "transaction_state",
  "workflow_state",
  "settlement_action_state",
  "created_at",
  "expires_at",
  "settled_at",
  "settlement_action_completed_at",
  "refreshed_from_invoice_id",
  "metadata",
  "fiat_quote",
  "created_row_at",
  "updated_row_at"
] as const;
const REQUIRED_INVOICE_INDEXES = [
  "openreceive_invoices_idempotency_scope_idx",
  "openreceive_invoices_recovery_idx"
] as const;
const REQUIRED_STORE_METHODS = [
  "checkIdempotency",
  "createInvoice",
  "getInvoice",
  "getInvoiceByPaymentHash",
  "getInvoiceByBolt11Invoice",
  "listRecoverableInvoices",
  "markVerifying",
  "markExpiryPendingVerification",
  "markSettled",
  "markExpiredClosed",
  "markFailedClosed",
  "markSettlementActionPending",
  "markSettlementActionCompleted",
  "markSettlementActionFailed"
] as const;

interface OpenReceiveExpressRunnerModule {
  createOpenReceiveExpressHandlers(options: OpenReceiveExpressOptions): unknown;
  createOpenReceiveExpressSettlementPollingRunner(
    options: OpenReceiveExpressOptions,
    runnerOptions?: OpenReceiveExpressPollingRunnerStartOptions
  ): {
    recoverOpenInvoices(): Promise<{ recovered: number; invoice_ids: string[] }>;
    start(): void;
    stop(): void;
  };
  startOpenReceiveExpressPaymentNotificationRunner(
    options: OpenReceiveExpressOptions
  ): Promise<{
    stop?: () => Promise<void> | void;
  }>;
}

export async function runOpenReceiveCli(options: OpenReceiveCliOptions): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const [command = "help", ...args] = options.argv;

  try {
    switch (command) {
      case "help":
      case "--help":
      case "-h":
        stdout.write(`${HELP}\n`);
        return 0;
      case "init":
        return runInit({ args, cwd, stdout, stderr });
      case "migrate":
        return await runMigrate({ args, env, stdout, loadSqlite: options.loadSqlite, loadPostgres: options.loadPostgres });
      case "doctor":
        return await runDoctor({
          args,
          env,
          cwd,
          stdout,
          stderr,
          loadSqlite: options.loadSqlite,
          loadPostgres: options.loadPostgres,
          loadConfigModule: options.loadConfigModule,
          loadExpressRunners: options.loadExpressRunners
        });
      case "worker":
        return await runWorker({ args, env, cwd, stdout, loadConfigModule: options.loadConfigModule, loadExpressRunners: options.loadExpressRunners });
      case "poll":
        return await runPoll({ args, env, cwd, stdout, loadConfigModule: options.loadConfigModule, loadExpressRunners: options.loadExpressRunners });
      case "listen":
        return await runListen({ args, env, cwd, stdout, loadConfigModule: options.loadConfigModule, loadExpressRunners: options.loadExpressRunners });
      default:
        stderr.write(`Unknown OpenReceive command: ${command}\n\n${HELP}\n`);
        return 1;
    }
  } catch (error) {
    stderr.write(`${safeErrorMessage(error)}\n`);
    return 1;
  }
}

function runInit(input: {
  args: readonly string[];
  cwd: string;
  stdout: OpenReceiveCliIo;
  stderr: OpenReceiveCliIo;
}): number {
  const force = input.args.includes("--force");
  const files = [
    {
      relativePath: ".env.openreceive.example",
      text: [
        "OPENRECEIVE_NWC=",
        "# Optional CLI override when your app does not already expose DATABASE_URL.",
        "OPENRECEIVE_DATABASE_URL=",
        "# Optional local SQLite path for generated development config.",
        "OPENRECEIVE_SQLITE_PATH=storage/openreceive.sqlite3",
        ""
      ].join("\n")
    },
    {
      relativePath: "openreceive.config.example.mjs",
      text: [
        "// Copy to openreceive.config.mjs or run `openreceive init` to generate it.",
        "export { openreceive } from \"./openreceive.config.mjs\";",
        ""
      ].join("\n")
    },
    {
      relativePath: "openreceive.config.mjs",
      text: [
        "import { mkdirSync } from \"node:fs\";",
        "import { dirname } from \"node:path\";",
        "import { DatabaseSync } from \"node:sqlite\";",
        "import { InMemoryInvoiceEventBus } from \"@openreceive/express\";",
        "import {",
        "  createAlbyNwcReceiveClient,",
        "  createOpenReceiveSqliteInvoiceStore,",
        "  createOpenReceiveSqliteQueryClient,",
        "  formatOpenReceiveInvalidNwcMessage,",
        "  formatOpenReceiveMissingNwcMessage,",
        "  parseNwcConnectionUri",
        "} from \"@openreceive/node\";",
        "",
        "const nwc = process.env.OPENRECEIVE_NWC;",
        "if (nwc === undefined || nwc.trim() === \"\") {",
        "  const message = formatOpenReceiveMissingNwcMessage({",
        "    subject: \"OpenReceive\"",
        "  });",
        "  console.error(message);",
        "  throw new Error(message);",
        "}",
        "try {",
        "  parseNwcConnectionUri(nwc);",
        "} catch (error) {",
        "  const message = formatOpenReceiveInvalidNwcMessage({",
        "    reason: error && typeof error === \"object\" && \"description\" in error",
        "      ? String(error.description)",
        "      : \"Invalid NWC URI.\"",
        "  });",
        "  console.error(message);",
        "  throw new Error(message);",
        "}",
        "",
        "const sqlitePath = process.env.OPENRECEIVE_SQLITE_PATH ?? \"storage/openreceive.sqlite3\";",
        "if (sqlitePath !== \":memory:\" && !sqlitePath.startsWith(\"file:\")) {",
        "  mkdirSync(dirname(sqlitePath), { recursive: true });",
        "}",
        "const database = new DatabaseSync(sqlitePath);",
        "",
        "export const openreceive = {",
        "  client: createAlbyNwcReceiveClient({",
        "    connectionString: nwc",
        "  }),",
        "  store: createOpenReceiveSqliteInvoiceStore({",
        "    client: createOpenReceiveSqliteQueryClient(database)",
        "  }),",
        "  eventBus: new InMemoryInvoiceEventBus(),",
        "  merchantScope: () => \"merchant:default\",",
        "  settlementAction: async (_input) => {",
        "    // Unlock the app-owned order, account, or entitlement here.",
        "  }",
        "};",
        "",
        "export default openreceive;",
        ""
      ].join("\n")
    },
    {
      relativePath: "server/openreceive-routes.mjs",
      text: [
        "import { mountOpenReceiveExpressRoutes } from \"@openreceive/express\";",
        "import { openreceive } from \"../openreceive.config.mjs\";",
        "",
        "export function mountOpenReceiveRoutes(app) {",
        "  return mountOpenReceiveExpressRoutes(app, openreceive);",
        "}",
        "",
        "export default mountOpenReceiveRoutes;",
        ""
      ].join("\n")
    },
    {
      relativePath: "scripts/openreceive-worker.mjs",
      text: [
        "import { runOpenReceiveCli } from \"@openreceive/node/cli\";",
        "",
        "process.exitCode = await runOpenReceiveCli({",
        "  argv: [\"worker\"],",
        "  env: process.env,",
        "  cwd: process.cwd(),",
        "  stdout: process.stdout,",
        "  stderr: process.stderr",
        "});",
        ""
      ].join("\n")
    },
    {
      relativePath: "scripts/openreceive-poll.mjs",
      text: [
        "import { runOpenReceiveCli } from \"@openreceive/node/cli\";",
        "",
        "process.exitCode = await runOpenReceiveCli({",
        "  argv: [\"poll\"],",
        "  env: process.env,",
        "  cwd: process.cwd(),",
        "  stdout: process.stdout,",
        "  stderr: process.stderr",
        "});",
        ""
      ].join("\n")
    },
    {
      relativePath: "scripts/openreceive-listen.mjs",
      text: [
        "import { runOpenReceiveCli } from \"@openreceive/node/cli\";",
        "",
        "process.exitCode = await runOpenReceiveCli({",
        "  argv: [\"listen\"],",
        "  env: process.env,",
        "  cwd: process.cwd(),",
        "  stdout: process.stdout,",
        "  stderr: process.stderr",
        "});",
        ""
      ].join("\n")
    }
  ];

  for (const file of files) {
    const target = path.join(input.cwd, file.relativePath);
    if (!force && fileExists(target)) {
      input.stderr.write(`${file.relativePath} already exists; pass --force to overwrite.\n`);
      return 1;
    }
  }

  for (const file of files) {
    const target = path.join(input.cwd, file.relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.text, { flag: "w" });
    input.stdout.write(`created ${file.relativePath}\n`);
  }

  return 0;
}

async function runWorker(input: {
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout: OpenReceiveCliIo;
  loadConfigModule?: OpenReceiveCliOptions["loadConfigModule"];
  loadExpressRunners?: OpenReceiveCliOptions["loadExpressRunners"];
}): Promise<number> {
  const config = await loadOpenReceiveConfig(input);
  const express = await loadExpressRunners(input.loadExpressRunners);
  const runner = express.createOpenReceiveExpressSettlementPollingRunner(
    config,
    parseRunnerOptions(input.args)
  );
  let listener: Awaited<ReturnType<OpenReceiveExpressRunnerModule["startOpenReceiveExpressPaymentNotificationRunner"]>> | undefined;

  try {
    runner.start();
    listener = await express.startOpenReceiveExpressPaymentNotificationRunner(config);
  } catch (error) {
    runner.stop();
    await listener?.stop?.();
    throw error;
  }

  input.stdout.write("OpenReceive worker started (poll + listen).\n");

  if (input.args.includes("--ready-only")) {
    runner.stop();
    await listener.stop?.();
    input.stdout.write("OpenReceive worker readiness verified.\n");
    return 0;
  }

  await waitForTerminationSignal(async () => {
    runner.stop();
    await listener?.stop?.();
  });
  return 0;
}

async function runPoll(input: {
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout: OpenReceiveCliIo;
  loadConfigModule?: OpenReceiveCliOptions["loadConfigModule"];
  loadExpressRunners?: OpenReceiveCliOptions["loadExpressRunners"];
}): Promise<number> {
  const config = await loadOpenReceiveConfig(input);
  const express = await loadExpressRunners(input.loadExpressRunners);
  const runner = express.createOpenReceiveExpressSettlementPollingRunner(
    config,
    parseRunnerOptions(input.args)
  );

  if (input.args.includes("--once")) {
    const result = await runner.recoverOpenInvoices();
    input.stdout.write(`OpenReceive poll recovered ${result.recovered} invoice(s).\n`);
    return 0;
  }

  runner.start();
  input.stdout.write("OpenReceive poll runner started.\n");
  await waitForTerminationSignal(() => runner.stop());
  return 0;
}

async function runListen(input: {
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout: OpenReceiveCliIo;
  loadConfigModule?: OpenReceiveCliOptions["loadConfigModule"];
  loadExpressRunners?: OpenReceiveCliOptions["loadExpressRunners"];
}): Promise<number> {
  const config = await loadOpenReceiveConfig(input);
  const express = await loadExpressRunners(input.loadExpressRunners);
  const listener = await express.startOpenReceiveExpressPaymentNotificationRunner(config);
  input.stdout.write("OpenReceive listen runner started.\n");

  if (input.args.includes("--ready-only")) {
    await listener.stop?.();
    input.stdout.write("OpenReceive listen runner readiness verified.\n");
    return 0;
  }

  await waitForTerminationSignal(() => listener.stop?.());
  return 0;
}

async function runMigrate(input: {
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  stdout: OpenReceiveCliIo;
  loadSqlite?: OpenReceiveCliOptions["loadSqlite"];
  loadPostgres?: OpenReceiveCliOptions["loadPostgres"];
}): Promise<number> {
  const target = detectDatabaseTarget(input.args, input.env);
  const print = input.args.includes("--print");

  if (target.kind === "sqlite") {
    if (print) {
      input.stdout.write(`${OPENRECEIVE_SQLITE_MIGRATION_SQL}\n`);
      return 0;
    }
    ensureSqliteDatabaseDirectory(target.path);
    const sqlite = await loadSqlite(input.loadSqlite);
    const database = new sqlite.DatabaseSync(target.path);
    try {
      await migrateOpenReceiveSqlite(createOpenReceiveSqliteQueryClient(database));
    } finally {
      database.close?.();
    }
    input.stdout.write(`OpenReceive SQLite migration applied: ${target.path}\n`);
    return 0;
  }

  if (print) {
    input.stdout.write(`${OPENRECEIVE_POSTGRES_MIGRATION_SQL}\n`);
    return 0;
  }

  const postgres = await loadPostgres(input.loadPostgres);
  const pool = new postgres.Pool({ connectionString: target.url });
  try {
    await pool.query(OPENRECEIVE_POSTGRES_MIGRATION_SQL);
  } finally {
    await pool.end();
  }
  input.stdout.write("OpenReceive Postgres migration applied.\n");
  return 0;
}

async function runDoctor(input: {
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout: OpenReceiveCliIo;
  stderr: OpenReceiveCliIo;
  loadSqlite?: OpenReceiveCliOptions["loadSqlite"];
  loadPostgres?: OpenReceiveCliOptions["loadPostgres"];
  loadConfigModule?: OpenReceiveCliOptions["loadConfigModule"];
  loadExpressRunners?: OpenReceiveCliOptions["loadExpressRunners"];
}): Promise<number> {
  const target = detectDatabaseTarget(input.args, input.env);
  const walletConfigured = (input.env.OPENRECEIVE_NWC ?? "").trim().length > 0;
  let migrated = false;

  if (target.kind === "sqlite") {
    const sqlite = await loadSqlite(input.loadSqlite);
    const database = new sqlite.DatabaseSync(target.path);
    let schema: OpenReceiveDoctorSchema;
    try {
      const client = createOpenReceiveSqliteQueryClient(database);
      const result = await client.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
        ["openreceive_invoices"]
      );
      migrated = result.rows.length === 1;
      schema = migrated
        ? await readSqliteInvoiceSchema(client)
        : { columns: new Set(), indexes: new Set(), migrationVersions: new Set() };
    } finally {
      database.close?.();
    }
    input.stdout.write(`ok database sqlite ${target.path}\n`);
    if (!migrated) {
      input.stderr.write("missing OpenReceive migration: run `openreceive migrate`.\n");
      return 1;
    }
    const schemaCheck = checkInvoiceSchema(schema);
    if (!schemaCheck.ok) {
      input.stderr.write(`${schemaCheck.message}\n`);
      return 1;
    }
  } else {
    const postgres = await loadPostgres(input.loadPostgres);
    const pool = new postgres.Pool({ connectionString: target.url });
    let schema: OpenReceiveDoctorSchema;
    try {
      const result = await pool.query(
        "SELECT to_regclass('public.openreceive_invoices') AS table_name"
      );
      migrated = result.rows[0]?.table_name === "openreceive_invoices";
      schema = migrated
        ? await readPostgresInvoiceSchema(pool)
        : { columns: new Set(), indexes: new Set(), migrationVersions: new Set() };
    } finally {
      await pool.end();
    }
    input.stdout.write("ok database postgres\n");
    if (!migrated) {
      input.stderr.write("missing OpenReceive migration: run `openreceive migrate`.\n");
      return 1;
    }
    const schemaCheck = checkInvoiceSchema(schema);
    if (!schemaCheck.ok) {
      input.stderr.write(`${schemaCheck.message}\n`);
      return 1;
    }
  }
  input.stdout.write(`ok migration openreceive_invoices ${OPENRECEIVE_DATABASE_SCHEMA_VERSION} columns/indexes/version\n`);

  if (walletConfigured) {
    input.stdout.write("ok OPENRECEIVE_NWC configured (redacted)\n");
  } else {
    input.stdout.write("warn OPENRECEIVE_NWC is not configured; invoice creation will fail closed.\n");
  }

  if (!hasConfigTarget(input.args, input.env, input.cwd)) {
    input.stdout.write("warn config not checked; create openreceive.config.mjs or pass --config to verify route, NWC, and runner readiness.\n");
    return 0;
  }

  return await runConfigDoctor(input) ? 0 : 1;
}

async function runConfigDoctor(input: {
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout: OpenReceiveCliIo;
  stderr: OpenReceiveCliIo;
  loadConfigModule?: OpenReceiveCliOptions["loadConfigModule"];
  loadExpressRunners?: OpenReceiveCliOptions["loadExpressRunners"];
}): Promise<boolean> {
  let ok = true;
  let config: OpenReceiveExpressOptions;

  try {
    config = await loadOpenReceiveConfig(input);
    input.stdout.write("ok config loaded\n");
  } catch (error) {
    input.stderr.write(`OpenReceive config failed to load: ${safeErrorMessage(error)}\n`);
    return false;
  }

  const storeCheck = checkConfiguredStore(config.store);
  if (storeCheck.ok) {
    input.stdout.write("ok store package-owned durable invoice store configured\n");
  } else {
    input.stderr.write(`${storeCheck.message}\n`);
    ok = false;
  }

  const securityCheck = checkProductionSecurityConfig(config, input.env);
  for (const warning of securityCheck.warnings) {
    input.stdout.write(`warn ${warning}\n`);
  }
  for (const error of securityCheck.errors) {
    input.stderr.write(`${error}\n`);
  }
  if (securityCheck.errors.length > 0) {
    ok = false;
  } else if (securityCheck.production) {
    input.stdout.write("ok production auth and event authorization diagnostics passed\n");
  }

  let express: OpenReceiveExpressRunnerModule;
  try {
    express = await loadExpressRunners(input.loadExpressRunners);
  } catch (error) {
    input.stderr.write(`OpenReceive Express diagnostics unavailable: ${safeErrorMessage(error)}\n`);
    return false;
  }

  try {
    express.createOpenReceiveExpressHandlers(config);
    input.stdout.write("ok routes route wiring accepts configured store/auth/csrf\n");
  } catch (error) {
    input.stderr.write(`OpenReceive route wiring failed: ${safeErrorMessage(error)}\n`);
    ok = false;
  }

  try {
    const runner = express.createOpenReceiveExpressSettlementPollingRunner(
      config,
      { recoveryIntervalSeconds: 1 }
    );
    if (
      typeof runner.recoverOpenInvoices !== "function" ||
      typeof runner.start !== "function" ||
      typeof runner.stop !== "function"
    ) {
      throw new Error("poll runner did not expose recover/start/stop.");
    }
    input.stdout.write("ok runner poll can be constructed from config\n");
  } catch (error) {
    input.stderr.write(`OpenReceive poll runner readiness failed: ${safeErrorMessage(error)}\n`);
    ok = false;
  }

  input.stdout.write("ok runner listen can be started; polling remains the settlement fallback\n");

  if (typeof config.client?.preflight !== "function") {
    input.stdout.write("warn NWC preflight not checked; configured client does not expose preflight().\n");
    return ok;
  }

  try {
    const summary = await config.client.preflight();
    if (isRecord(summary) && summary.receiveCheckoutReady === false) {
      input.stderr.write("OpenReceive NWC preflight failed: receive checkout is not ready.\n");
      ok = false;
    } else {
      input.stdout.write(`ok NWC preflight completed${formatPreflightDetails(summary)}\n`);
    }

    for (const warning of readPreflightWarnings(summary)) {
      input.stdout.write(`warn NWC preflight ${redactPotentialSecrets(warning)}\n`);
    }
  } catch (error) {
    input.stderr.write(`OpenReceive NWC preflight failed: ${safeErrorMessage(error)}\n`);
    ok = false;
  }

  return ok;
}

function checkProductionSecurityConfig(
  config: OpenReceiveExpressOptions,
  env: NodeJS.ProcessEnv
): {
  production: boolean;
  warnings: string[];
  errors: string[];
} {
  const mode = (env.OPENRECEIVE_MODE ?? env.NODE_ENV ?? "").toLowerCase();
  const production = mode === "production";
  const warnings: string[] = [];
  const errors: string[] = [];

  if (!production) {
    if (config.unsafeAllowUnauthenticatedDemoMode === true) {
      warnings.push("unsafe unauthenticated demo mode is enabled; do not use it in production.");
    }
    return { production, warnings, errors };
  }

  if (
    config.unsafeAllowUnauthenticatedDemoMode === true &&
    env.OPENRECEIVE_ALLOW_UNAUTHENTICATED_DEMO !== "true"
  ) {
    errors.push(
      "OpenReceive production config enables unsafeAllowUnauthenticatedDemoMode without OPENRECEIVE_ALLOW_UNAUTHENTICATED_DEMO=true."
    );
  }

  const missingAuthHooks = ["create", "read", "lookup", "refresh"].filter(
    (hook) =>
      typeof (config.auth as Record<string, unknown> | undefined)?.[hook] !==
      "function"
  );
  if (missingAuthHooks.length > 0) {
    errors.push(
      `OpenReceive production config is missing authorization hooks: ${missingAuthHooks.join(", ")}.`
    );
  }

  if (
    typeof config.auth?.events !== "function" &&
    config.signedEvents === undefined
  ) {
    errors.push(
      "OpenReceive production config must protect invoice events with auth.events or signedEvents."
    );
  }

  if (typeof config.csrf?.verify !== "function") {
    warnings.push(
      "production config has no csrf.verify hook; cookie-authenticated invoice POSTs must add CSRF protection."
    );
  }

  if (config.cors?.allowed_origins?.includes("*") && config.cors.credentials) {
    errors.push(
      "OpenReceive production config cannot use wildcard CORS with credentials."
    );
  }

  return { production, warnings, errors };
}

function checkConfiguredStore(store: OpenReceiveExpressOptions["store"]):
  | { ok: true }
  | { ok: false; message: string } {
  if (store === undefined || store === null) {
    return {
      ok: false,
      message:
        "OpenReceive config must set a package-owned durable invoice store. " +
        "Default in-memory storage is for tests and demos only, and production boot will fail closed."
    };
  }

  if (store instanceof InMemoryInvoiceStore) {
    return {
      ok: false,
      message:
        "OpenReceive config uses InMemoryInvoiceStore. Configure the package-owned " +
        "Postgres or SQLite invoice store before running production routes or backend processes."
    };
  }

  const missingMethods = REQUIRED_STORE_METHODS.filter((method) => {
    const candidate = (store as unknown as Record<string, unknown>)[method];
    return typeof candidate !== "function";
  });
  if (missingMethods.length > 0) {
    return {
      ok: false,
      message: `OpenReceive config invoice store is missing lifecycle methods: ${missingMethods.join(", ")}.`
    };
  }

  if (
    store instanceof OpenReceivePostgresInvoiceStore ||
    store instanceof OpenReceiveSqliteInvoiceStore
  ) {
    return { ok: true };
  }

  return {
    ok: false,
    message:
      "OpenReceive config invoice store is not a package-owned Node Postgres or SQLite store. " +
      "Node v0.1 supports databases only when OpenReceive ships the store adapter, migration path, and conformance coverage."
  };
}

function detectDatabaseTarget(
  args: readonly string[],
  env: NodeJS.ProcessEnv
): OpenReceiveDatabaseTarget {
  const sqlitePath = readFlag(args, "--sqlite") ?? env.OPENRECEIVE_SQLITE_PATH;
  if (sqlitePath !== undefined && sqlitePath.trim().length > 0) {
    return {
      kind: "sqlite",
      path: sqlitePath
    };
  }

  const databaseUrl =
    readFlag(args, "--postgres") ??
    readFlag(args, "--database-url") ??
    env.OPENRECEIVE_DATABASE_URL ??
    env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    throw new Error("Set DATABASE_URL, OPENRECEIVE_DATABASE_URL, OPENRECEIVE_SQLITE_PATH, --postgres, or --sqlite.");
  }

  if (databaseUrl.startsWith("sqlite:")) {
    return {
      kind: "sqlite",
      path: databaseUrl.replace(/^sqlite:(?:\/\/)?/, "")
    };
  }

  if (!/^postgres(?:ql)?:\/\//.test(databaseUrl)) {
    throw new Error("Unsupported OpenReceive database URL. Supported Node databases: postgres and sqlite.");
  }

  return {
    kind: "postgres",
    url: databaseUrl
  };
}

function hasConfigTarget(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string
): boolean {
  if (readFlag(args, "--config") !== undefined) return true;
  if ((env.OPENRECEIVE_CONFIG ?? "").trim().length > 0) return true;
  return fileExists(path.resolve(cwd, "openreceive.config.mjs"));
}

interface OpenReceiveDoctorSchema {
  columns: Set<string>;
  indexes: Set<string>;
  migrationVersions: Set<string>;
}

async function readSqliteInvoiceSchema(
  client: OpenReceiveSqliteQueryClient
): Promise<OpenReceiveDoctorSchema> {
  const columns = await client.execute(
    "SELECT name FROM pragma_table_info('openreceive_invoices')"
  );
  const indexes = await client.execute(
    "SELECT name FROM pragma_index_list('openreceive_invoices')"
  );
  const migrationTable = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    [OPENRECEIVE_SCHEMA_MIGRATIONS_TABLE]
  );
  const versions = migrationTable.rows.length === 0
    ? { rows: [] }
    : await client.execute(
        `SELECT version FROM ${OPENRECEIVE_SCHEMA_MIGRATIONS_TABLE}`
      );
  return {
    columns: new Set(columns.rows.map((row) => String(row.name))),
    indexes: new Set(indexes.rows.map((row) => String(row.name))),
    migrationVersions: new Set(versions.rows.map((row) => String(row.version)))
  };
}

async function readPostgresInvoiceSchema(client: {
  query(sql: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}): Promise<OpenReceiveDoctorSchema> {
  const columns = await client.query(
    "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'openreceive_invoices'"
  );
  const indexes = await client.query(
    "SELECT indexname AS name FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'openreceive_invoices'"
  );
  const migrationTable = await client.query(
    "SELECT to_regclass('public.openreceive_schema_migrations') AS table_name"
  );
  const versions = migrationTable.rows[0]?.table_name === OPENRECEIVE_SCHEMA_MIGRATIONS_TABLE
    ? await client.query(
        `SELECT version FROM ${OPENRECEIVE_SCHEMA_MIGRATIONS_TABLE}`
      )
    : { rows: [] };
  return {
    columns: new Set(columns.rows.map((row) => String(row.name))),
    indexes: new Set(indexes.rows.map((row) => String(row.name))),
    migrationVersions: new Set(versions.rows.map((row) => String(row.version)))
  };
}

function checkInvoiceSchema(schema: OpenReceiveDoctorSchema):
  | { ok: true }
  | { ok: false; message: string } {
  const missingColumns = REQUIRED_INVOICE_COLUMNS.filter((name) => !schema.columns.has(name));
  const missingIndexes = REQUIRED_INVOICE_INDEXES.filter((name) => !schema.indexes.has(name));
  const missingVersions = schema.migrationVersions.has(OPENRECEIVE_DATABASE_SCHEMA_VERSION)
    ? []
    : [OPENRECEIVE_DATABASE_SCHEMA_VERSION];
  if (missingColumns.length === 0 && missingIndexes.length === 0 && missingVersions.length === 0) {
    return { ok: true };
  }

  const details = [
    missingColumns.length === 0 ? undefined : `columns: ${missingColumns.join(", ")}`,
    missingIndexes.length === 0 ? undefined : `indexes: ${missingIndexes.join(", ")}`,
    missingVersions.length === 0 ? undefined : `migration versions: ${missingVersions.join(", ")}`
  ].filter((detail): detail is string => detail !== undefined);
  return {
    ok: false,
    message: `OpenReceive migration is incomplete; missing ${details.join("; ")}. Run \`openreceive migrate\`.`
  };
}

async function loadOpenReceiveConfig(input: {
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  loadConfigModule?: OpenReceiveCliOptions["loadConfigModule"];
}): Promise<OpenReceiveExpressOptions> {
  const specifier = resolveConfigSpecifier(input.args, input.env, input.cwd);
  const module = input.loadConfigModule === undefined
    ? await import(specifier) as Record<string, unknown>
    : await input.loadConfigModule(specifier);
  const exported =
    module.openreceive ??
    module.default ??
    module.config ??
    module.createOpenReceiveConfig ??
    module.createOpenReceive;
  const config = typeof exported === "function"
    ? await (exported as () => unknown | Promise<unknown>)()
    : exported;

  if (config === null || typeof config !== "object") {
    throw new Error(
      "OpenReceive config module must export `openreceive`, a default config object, or createOpenReceiveConfig()."
    );
  }

  return config as OpenReceiveExpressOptions;
}

function resolveConfigSpecifier(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string
): string {
  const configured = readFlag(args, "--config") ?? env.OPENRECEIVE_CONFIG ?? "openreceive.config.mjs";
  if (/^(file|data|node):/.test(configured)) return configured;
  return pathToFileURL(path.resolve(cwd, configured)).href;
}

function parseRunnerOptions(
  args: readonly string[]
): OpenReceiveExpressPollingRunnerStartOptions {
  const recoveryIntervalSeconds = readOptionalIntegerFlag(args, "--recovery-interval-seconds");
  return recoveryIntervalSeconds === undefined ? {} : { recoveryIntervalSeconds };
}

function readOptionalIntegerFlag(
  args: readonly string[],
  flag: string
): number | undefined {
  const value = readFlag(args, flag);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive integer.`);
  }
  return parsed;
}

function readFlag(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function fileExists(filePath: string): boolean {
  try {
    statSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function ensureSqliteDatabaseDirectory(databasePath: string): void {
  if (databasePath === ":memory:" || databasePath.startsWith("file:")) return;
  mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
}

async function loadSqlite(
  override: OpenReceiveCliOptions["loadSqlite"]
): Promise<{
  DatabaseSync: new (filename: string) => OpenReceiveSqliteDatabase & {
    close?: () => void;
  };
}> {
  if (override !== undefined) return override();
  try {
    return await import("node:sqlite") as unknown as {
      DatabaseSync: new (filename: string) => OpenReceiveSqliteDatabase & {
        close?: () => void;
      };
    };
  } catch {
    throw new Error("SQLite migration requires a Node runtime with node:sqlite support.");
  }
}

async function loadPostgres(
  override: OpenReceiveCliOptions["loadPostgres"]
): Promise<{
  Pool: new (options: { connectionString: string }) => {
    query(sql: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
    end(): Promise<void>;
  };
}> {
  if (override !== undefined) return override();
  try {
    const pg = await import("pg") as unknown as {
      default?: {
        Pool?: new (options: { connectionString: string }) => {
          query(sql: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
          end(): Promise<void>;
        };
      };
      Pool?: new (options: { connectionString: string }) => {
        query(sql: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
        end(): Promise<void>;
      };
    };
    const Pool = pg.Pool ?? pg.default?.Pool;
    if (Pool === undefined) throw new Error("pg Pool export not found");
    return { Pool };
  } catch {
    throw new Error("Postgres migration requires installing the `pg` package in the app.");
  }
}

async function loadExpressRunners(
  override: OpenReceiveCliOptions["loadExpressRunners"]
): Promise<OpenReceiveExpressRunnerModule> {
  if (override !== undefined) return override();
  try {
    return await import("@openreceive/express") as unknown as OpenReceiveExpressRunnerModule;
  } catch {
    throw new Error(
      "OpenReceive worker/poll/listen commands require installing `@openreceive/express` in the app."
    );
  }
}

async function waitForTerminationSignal(
  cleanup: () => Promise<void> | void
): Promise<void> {
  await new Promise<void>((resolve) => {
    const keepAlive = globalThis.setInterval(() => {}, 2_147_483_647);
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void cleanupPromise().finally(resolve);
    };
    const cleanupPromise = async () => {
      try {
        await cleanup();
      } finally {
        globalThis.clearInterval(keepAlive);
        globalThis.process?.off?.("SIGINT", stop);
        globalThis.process?.off?.("SIGTERM", stop);
      }
    };
    globalThis.process?.once?.("SIGINT", stop);
    globalThis.process?.once?.("SIGTERM", stop);
  });
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return redactPotentialSecrets(error.message);
  if (typeof error === "string") return redactPotentialSecrets(error);
  return "OpenReceive command failed.";
}

function redactPotentialSecrets(message: string): string {
  return message
    .replace(/nostr\+walletconnect:\/\/[^\s"'`<>]+/g, "[REDACTED_NWC]")
    .replace(/([?&](?:_or_evt|token|secret)=)[^&\s"'`<>]+/gi, "$1[REDACTED]");
}

function formatPreflightDetails(summary: unknown): string {
  if (!isRecord(summary)) return "";

  const details = [];
  if (typeof summary.encryption === "string" && summary.encryption.length > 0) {
    details.push(`encryption=${summary.encryption}`);
  }
  if (Array.isArray(summary.methods)) {
    const methods = summary.methods.filter((method): method is string => typeof method === "string");
    if (methods.length > 0) details.push(`methods=${methods.join(",")}`);
  }
  if (Array.isArray(summary.notifications)) {
    const notifications = summary.notifications.filter((notification): notification is string => typeof notification === "string");
    if (notifications.length > 0) details.push(`notifications=${notifications.join(",")}`);
  }

  return details.length === 0 ? "" : ` (${details.join("; ")})`;
}

function readPreflightWarnings(summary: unknown): string[] {
  if (!isRecord(summary) || !Array.isArray(summary.warnings)) return [];
  return summary.warnings
    .filter((warning): warning is string => typeof warning === "string")
    .map(redactPotentialSecrets);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
