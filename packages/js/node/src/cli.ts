import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  InMemoryInvoiceKvStore,
  idempotencyScopeKey,
  reconcileOnce,
  type OpenReceiveInvoiceKvStore,
  type StoredRecord
} from "@openreceive/core";
import type {
  OpenReceiveNodeOptions,
  OpenReceiveServer
} from "./http.ts";
import {
  createOpenReceiveSqliteQueryClient,
  type OpenReceiveSqliteDatabase
} from "./sqlite-store.ts";
import {
  OPENRECEIVE_POSTGRES_MIGRATION_SQL
} from "./postgres-store.ts";
import {
  OPENRECEIVE_SQLITE_MIGRATION_SQL
} from "./sqlite-store.ts";
import {
  OPENRECEIVE_DATABASE_SCHEMA_VERSION
} from "./storage-schema.ts";
import {
  resolveOpenReceiveStore,
  type OpenReceiveResolvedStore,
  type ResolveOpenReceiveStoreOptions
} from "./store-uri.ts";

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
  loadPostgres?: ResolveOpenReceiveStoreOptions["loadPostgres"];
  loadConfigModule?: (specifier: string) => Promise<Record<string, unknown>>;
}

type OpenReceiveNodeConfig = OpenReceiveNodeOptions | OpenReceiveServer;

const HELP = `
Usage: openreceive <command> [options]

Commands:
  init                 Generate server-only config/env for route-mounted OpenReceive.
  migrate             Ensure the OpenReceive store schema exists; --print emits DDL.
  doctor              Check store CAS/idempotency/listOpen, config, NWC, and auth readiness.
  poll --once          Run one bounded store-throttled recovery sweep.

Store options:
  --store <uri>        memory:, local-sqlite, sqlite:///path, or postgres://...
  --namespace <name>   Operational namespace. Defaults to OPENRECEIVE_NAMESPACE or default.
  --print             Print SQL for the selected SQL store instead of executing it.

Config options:
  --config <path>      Import a server-only module. Defaults to openreceive.config.mjs.

Removed:
  worker, listen       v0.1-v2 is poll-only and worker-free; use poll --once from a scheduler.
`.trim();

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
        return await runMigrate({
          args,
          env,
          cwd,
          stdout,
          loadSqlite: options.loadSqlite,
          loadPostgres: options.loadPostgres
        });
      case "doctor":
        return await runDoctor({
          args,
          env,
          cwd,
          stdout,
          stderr,
          loadSqlite: options.loadSqlite,
          loadPostgres: options.loadPostgres,
          loadConfigModule: options.loadConfigModule
        });
      case "poll":
        return await runPoll({
          args,
          env,
          cwd,
          stdout,
          loadConfigModule: options.loadConfigModule
        });
      case "worker":
      case "listen":
        stderr.write(`OpenReceive ${command} was removed. Use route-mounted recovery plus \`openreceive poll --once\` for optional schedulers.\n`);
        return 1;
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
        "# OPENRECEIVE_STORE defaults to local-sqlite.",
        "OPENRECEIVE_NAMESPACE=default",
        "# Only needed when calling /openreceive/v1/poll from an external scheduler.",
        "OPENRECEIVE_CRON_SECRET=",
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
        "import {",
        "  createOpenReceive,",
        "  formatOpenReceiveInvalidNwcMessage,",
        "  formatOpenReceiveMissingNwcMessage,",
        "  parseNwcConnectionUri,",
        "  resolveOpenReceiveStore",
        "} from \"@openreceive/node\";",
        "",
        "const nwc = process.env.OPENRECEIVE_NWC;",
        "if (nwc === undefined || nwc.trim() === \"\") {",
        "  const message = formatOpenReceiveMissingNwcMessage({ subject: \"OpenReceive\" });",
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
        "const store = await resolveOpenReceiveStore();",
        "",
        "export const openreceive = await createOpenReceive({",
        "  nwc,",
        "  store,",
        "  cronSecret: process.env.OPENRECEIVE_CRON_SECRET,",
        "  authorize: {",
        "    request: () => false,",
        "    invoice: () => false,",
        "    scheduler: () => false",
        "  },",
        "  onPaid: async ({ invoice }) => {",
        "    // MUST be idempotent. Dedupe by invoice.payment_hash.",
        "  }",
        "});",
        "",
        "export default openreceive;",
        ""
      ].join("\n")
    },
    {
      relativePath: "server/openreceive-routes.mjs",
      text: [
        "import { openreceive } from \"../openreceive.config.mjs\";",
        "",
        "export function mountOpenReceiveRoutes(app) {",
        "  return openreceive.mountExpress(app);",
        "}",
        "",
        "export default mountOpenReceiveRoutes;",
        ""
      ].join("\n")
    },
    {
      relativePath: "scripts/openreceive-poll.mjs",
      text: [
        "import { runOpenReceiveCli } from \"@openreceive/node/cli\";",
        "",
        "process.exitCode = await runOpenReceiveCli({",
        "  argv: [\"poll\", \"--once\"],",
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

  ensureGitignoreContains(input.cwd, ".openreceive/");
  input.stdout.write("updated .gitignore for .openreceive/\n");
  return 0;
}

async function runMigrate(input: {
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout: OpenReceiveCliIo;
  loadSqlite?: OpenReceiveCliOptions["loadSqlite"];
  loadPostgres?: OpenReceiveCliOptions["loadPostgres"];
}): Promise<number> {
  const storeUri = detectStoreUri(input.args, input.env);
  const namespace = detectNamespace(input.args, input.env);

  if (input.args.includes("--print")) {
    if (storeUri === "local-sqlite" || storeUri.startsWith("sqlite:")) {
      input.stdout.write(`${OPENRECEIVE_SQLITE_MIGRATION_SQL}\n`);
      return 0;
    }
    if (/^postgres(?:ql)?:\/\//.test(storeUri)) {
      input.stdout.write(`${OPENRECEIVE_POSTGRES_MIGRATION_SQL}\n`);
      return 0;
    }
    input.stdout.write("No SQL DDL is required for this OpenReceive store.\n");
    return 0;
  }

  const store = await resolveStoreForCli(input, storeUri, namespace);
  try {
    await store.ensureSchema?.();
  } finally {
    await store.close?.();
  }
  input.stdout.write(`OpenReceive store schema ready (${OPENRECEIVE_DATABASE_SCHEMA_VERSION}).\n`);
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
}): Promise<number> {
  const storeUri = detectStoreUri(input.args, input.env);
  const namespace = detectNamespace(input.args, input.env);
  const store = await resolveStoreForCli(input, storeUri, namespace);
  let ok = true;

  try {
    await runStoreDiagnostics(store);
    input.stdout.write(`ok store ${redactStoreUri(storeUri)} namespace=${namespace}\n`);
    input.stdout.write("ok store putIfAbsent/casMeta/listOpen round-trip\n");
  } catch (error) {
    input.stderr.write(`OpenReceive store diagnostics failed: ${safeErrorMessage(error)}\n`);
    ok = false;
  } finally {
    await store.close?.();
  }

  if ((input.env.OPENRECEIVE_NWC ?? "").trim().length > 0) {
    input.stdout.write("ok OPENRECEIVE_NWC configured (redacted)\n");
  } else {
    input.stdout.write("warn OPENRECEIVE_NWC is not configured; invoice creation will fail closed.\n");
  }

  if (hasConfigTarget(input.args, input.env, input.cwd)) {
    ok = (await runConfigDoctor(input)) && ok;
  } else {
    input.stdout.write("warn config not checked; create openreceive.config.mjs or pass --config.\n");
  }

  return ok ? 0 : 1;
}

async function runConfigDoctor(input: {
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout: OpenReceiveCliIo;
  stderr: OpenReceiveCliIo;
  loadConfigModule?: OpenReceiveCliOptions["loadConfigModule"];
}): Promise<boolean> {
  let ok = true;
  let config: OpenReceiveNodeConfig;

  try {
    config = await loadOpenReceiveConfig(input);
    input.stdout.write("ok config loaded\n");
  } catch (error) {
    input.stderr.write(`OpenReceive config failed to load: ${safeErrorMessage(error)}\n`);
    return false;
  }

  const storeCheck = checkConfiguredStore(config.store);
  if (storeCheck.ok) {
    input.stdout.write("ok config store implements OpenReceive KV contract\n");
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
    input.stdout.write("ok production auth diagnostics passed\n");
  }

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

async function runPoll(input: {
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout: OpenReceiveCliIo;
  loadConfigModule?: OpenReceiveCliOptions["loadConfigModule"];
}): Promise<number> {
  if (!input.args.includes("--once")) {
    throw new Error("OpenReceive poll is one-shot only. Pass --once and run it from a scheduler.");
  }
  const config = await loadOpenReceiveConfig(input);
  if (config.store === undefined) {
    throw new Error("OpenReceive poll requires config.store.");
  }
  const result = await reconcileOnce({
    store: config.store,
    client: config.client,
    settlementAction: async ({ invoice, metadata, source, lookup_invoice }) => {
      await config.onPaid?.({
        invoice,
        metadata,
        source,
        lookup_invoice
      });
    },
    lookupBurst: config.lookupBurst ?? readPositiveIntegerEnv(input.env, "OPENRECEIVE_LOOKUP_BURST"),
    lookupRatePerSecond: config.lookupRatePerSecond ?? readPositiveNumberEnv(input.env, "OPENRECEIVE_LOOKUP_RATE_PER_SEC"),
    actionLeaseTtlSeconds: config.actionLeaseTtlSeconds ?? readPositiveIntegerEnv(input.env, "OPENRECEIVE_ACTION_LEASE_TTL_SEC"),
    sweepIntervalSeconds: config.sweepIntervalSeconds ?? readPositiveIntegerEnv(input.env, "OPENRECEIVE_SWEEP_INTERVAL_SEC"),
    sweepBatch: config.sweepBatch ?? readPositiveIntegerEnv(input.env, "OPENRECEIVE_SWEEP_BATCH"),
    clock: config.clock
  });
  input.stdout.write(`OpenReceive poll checked ${result.checked} wallet invoice(s) across ${result.invoice_ids.length} open invoice(s).\n`);
  return 0;
}

function readPositiveIntegerEnv(
  env: NodeJS.ProcessEnv,
  name: string
): number | undefined {
  const value = env[name];
  if (value === undefined || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return parsed;
}

function readPositiveNumberEnv(
  env: NodeJS.ProcessEnv,
  name: string
): number | undefined {
  const value = env[name];
  if (value === undefined || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new RangeError(`${name} must be a positive number`);
  }
  return parsed;
}

async function resolveStoreForCli(
  input: {
    cwd: string;
    loadSqlite?: OpenReceiveCliOptions["loadSqlite"];
    loadPostgres?: OpenReceiveCliOptions["loadPostgres"];
  },
  uri: string,
  namespace: string
): Promise<OpenReceiveResolvedStore> {
  return await resolveOpenReceiveStore(uri, {
    cwd: input.cwd,
    namespace,
    loadSqlite: input.loadSqlite,
    loadPostgres: input.loadPostgres
  });
}

async function runStoreDiagnostics(store: OpenReceiveInvoiceKvStore): Promise<void> {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const record = diagnosticRecord(suffix);
  const created = await store.putIfAbsent(record);
  if (created.status !== "created") {
    throw new Error("putIfAbsent did not create a fresh diagnostic record");
  }

  const duplicate = await store.putIfAbsent(record);
  if (duplicate.status !== "conflict" || duplicate.on !== "idempotency_scope") {
    throw new Error("putIfAbsent did not report idempotency_scope conflict");
  }

  const metaKey = `doctor:${suffix}`;
  const createdMeta = await store.casMeta(metaKey, "one", null);
  if (createdMeta.status !== "ok") throw new Error("casMeta create failed");
  const updatedMeta = await store.casMeta(metaKey, "two", createdMeta.row.rev);
  if (updatedMeta.status !== "ok") throw new Error("casMeta update failed");
  const staleMeta = await store.casMeta(metaKey, "stale", createdMeta.row.rev);
  if (staleMeta.status !== "conflict") throw new Error("casMeta stale update did not conflict");

  const open = await store.listOpen({ now: record.row.created_at, limit: 1 });
  if (!open.some((item) => item.row.invoice_id === record.row.invoice_id)) {
    throw new Error("listOpen did not return the diagnostic record");
  }
}

function diagnosticRecord(suffix: string): StoredRecord {
  return {
    rev: 0,
    row: {
      invoice_id: `or_inv_doctor_${suffix}`,
      merchant_scope: "doctor",
      operation: "invoice.create",
      idempotency_key: `doctor-${suffix}`,
      idempotency_request_hash: `sha256:${"a".repeat(64)}`,
      payment_hash: "b".repeat(48) + suffix.slice(0, 16).padEnd(16, "0"),
      invoice: `lnbc-doctor-${suffix}`,
      amount_msats: 1000,
      transaction_state: "pending",
      workflow_state: "invoice_created",
      settlement_action_state: "pending",
      created_at: 1000,
      expires_at: 1600,
      metadata: {},
      fiat_quote: null
    }
  };
}

function checkProductionSecurityConfig(
  config: OpenReceiveNodeConfig,
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

  const authorize = (config as unknown as {
    readonly authorize?: {
      readonly request?: unknown;
      readonly invoice?: unknown;
      readonly scheduler?: unknown;
    };
  }).authorize;
  if (typeof authorize?.request !== "function") {
    errors.push("OpenReceive production config is missing authorize.request.");
  }
  if (typeof authorize?.invoice !== "function") {
    errors.push("OpenReceive production config is missing authorize.invoice.");
  }

  if (
    typeof authorize?.scheduler !== "function" &&
    (config.cronSecret ?? env.OPENRECEIVE_CRON_SECRET ?? "").length === 0
  ) {
    errors.push(
      "OpenReceive production config must protect /poll with authorize.scheduler or OPENRECEIVE_CRON_SECRET."
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

function checkConfiguredStore(store: OpenReceiveNodeConfig["store"]):
  | { ok: true }
  | { ok: false; message: string } {
  if (store === undefined || store === null) {
    return {
      ok: false,
      message:
        "OpenReceive config must set a durable OpenReceive KV store. Use createOpenReceive() or resolveOpenReceiveStore()."
    };
  }

  const missingMethods = [
    "putIfAbsent",
    "put",
    "get",
    "getByPaymentHash",
    "getByBolt11Invoice",
    "getByIdempotencyScope",
    "listOpen",
    "getMeta",
    "casMeta"
  ].filter((method) => {
    const candidate = (store as unknown as Record<string, unknown>)[method];
    return typeof candidate !== "function";
  });
  if (missingMethods.length > 0) {
    return {
      ok: false,
      message: `OpenReceive config store is missing KV methods: ${missingMethods.join(", ")}.`
    };
  }

  if (store instanceof InMemoryInvoiceKvStore) {
    return {
      ok: false,
      message:
        "OpenReceive config uses InMemoryInvoiceKvStore. Configure local-sqlite, SQLite, or Postgres for durable checkout."
    };
  }

  return { ok: true };
}

function detectStoreUri(args: readonly string[], env: NodeJS.ProcessEnv): string {
  const storeUri = readFlag(args, "--store") ?? env.OPENRECEIVE_STORE;
  if (storeUri !== undefined && storeUri.trim().length > 0) return storeUri;
  return "local-sqlite";
}

function detectNamespace(args: readonly string[], env: NodeJS.ProcessEnv): string {
  return readFlag(args, "--namespace") ?? env.OPENRECEIVE_NAMESPACE ?? "default";
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

async function loadOpenReceiveConfig(input: {
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  loadConfigModule?: OpenReceiveCliOptions["loadConfigModule"];
}): Promise<OpenReceiveNodeConfig> {
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

  return config as OpenReceiveNodeConfig;
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

function ensureGitignoreContains(cwd: string, entry: string): void {
  const gitignore = path.join(cwd, ".gitignore");
  const existing = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
  if (existing.split(/\r?\n/).includes(entry)) return;
  appendFileSync(gitignore, `${existing.endsWith("\n") || existing.length === 0 ? "" : "\n"}${entry}\n`);
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return redactPotentialSecrets(error.message);
  if (typeof error === "string") return redactPotentialSecrets(error);
  return "OpenReceive command failed.";
}

function redactPotentialSecrets(message: string): string {
  return message
    .replace(/nostr\+walletconnect:\/\/[^\s"'`<>]+/g, "[REDACTED_NWC]")
    .replace(/([?&](?:token|secret)=)[^&\s"'`<>]+/gi, "$1[REDACTED]");
}

function redactStoreUri(uri: string): string {
  return uri.replace(/:\/\/([^:@/]+):([^@/]+)@/, "://$1:[REDACTED]@");
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
  return summary.warnings.filter((warning): warning is string => typeof warning === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
