import type {
  OpenReceiveSqliteDatabase
} from "./sqlite-store.ts";
import {
  readOpenReceiveConfigFile,
  type OpenReceiveFileConfig
} from "./config.ts";
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
  assertOpenReceiveStoreConfiguration
} from "./storage-guard.ts";
import {
  redactSecrets
} from "./service/logging.ts";
import {
  resolveOpenReceiveStore,
  resolveOpenReceiveStoreUri,
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
}

const HELP = `
Usage: openreceive <command> [options]

Commands:
  migrate             Ensure the OpenReceive store schema exists; --print emits DDL.
  doctor              Validate server-only configuration and print redacted diagnostics.
  debug-report        Print a redacted support report for local diagnostics.

Store options:
  --store <uri>        local-sqlite, sqlite:/absolute/path, or postgres://...
  --namespace <name>   Operational namespace. Defaults to openreceive.yml or default.
  --print             Print SQL for the selected SQL store instead of executing it.

Config options:
  --config <path>      YAML config file. Defaults to openreceive.yml.
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
      case "debug-report":
        return await runDiagnostics({
          command,
          args,
          env,
          cwd,
          stdout
        });
      default:
        stderr.write(`Unknown OpenReceive command: ${command}\n\n${HELP}\n`);
        return 1;
    }
  } catch (error) {
    stderr.write(`${safeErrorMessage(error)}\n`);
    return 1;
  }
}

async function runMigrate(input: {
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout: OpenReceiveCliIo;
  loadSqlite?: OpenReceiveCliOptions["loadSqlite"];
  loadPostgres?: OpenReceiveCliOptions["loadPostgres"];
}): Promise<number> {
  const config = readCliFileConfig(input.args, input.cwd);
  const storeUri = detectStoreUri(input.args, config, input.env);
  const namespace = detectNamespace(input.args, config);
  assertOpenReceiveStoreConfiguration({
    storeUri,
    env: input.env,
    emitWarning: false
  });

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
  // Capability tokens (route-shipping spec PART 2) persist the per-order token hash in the
  // store's meta KV, which ensureSchema provisions — nothing further to migrate on the KV
  // path. Hosts running the fully normalized schema apply migrations/002 for the column.
  input.stdout.write("Capability tokens ready (order_access_token stored in meta KV).\n");
  return 0;
}

async function runDiagnostics(input: {
  command: "doctor" | "debug-report";
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout: OpenReceiveCliIo;
}): Promise<number> {
  let config: OpenReceiveFileConfig | undefined;
  let configError: unknown;
  try {
    config = readCliFileConfig(input.args, input.cwd);
  } catch (error) {
    configError = error;
  }

  const storeUri =
    configError === undefined ? detectStoreUri(input.args, config, input.env) : "local-sqlite";
  const namespace = configError === undefined ? detectNamespace(input.args, config) : "default";
  const nwc = configError === undefined ? config?.nwc : undefined;
  const lines: string[] = [
    `OpenReceive ${input.command}`,
    `node: ${process.version}`,
    `cwd: ${input.cwd}`,
    `namespace: ${namespace}`,
    `nwc: ${nwc === undefined || nwc.trim().length === 0 ? "missing" : "present-redacted"}`,
    `store: ${redactSecrets(storeUri)}`
  ];

  if (configError !== undefined) {
    lines.push(`config: ${safeErrorMessage(configError)}`);
  } else if (config === undefined) {
    lines.push("config: missing openreceive.yml");
  } else {
    lines.push("config: loaded openreceive.yml");
    lines.push(`swap_providers: ${config.swap?.providers?.length ?? 0}`);
  }

  input.stdout.write(`${lines.join("\n")}\n`);
  return configError !== undefined || nwc === undefined || nwc.trim().length === 0 ? 1 : 0;
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
    schemaMode: "auto",
    loadSqlite: input.loadSqlite,
    loadPostgres: input.loadPostgres
  });
}

function readCliFileConfig(args: readonly string[], cwd: string): OpenReceiveFileConfig | undefined {
  return readOpenReceiveConfigFile({
    cwd,
    configPath: readFlag(args, "--config")
  });
}

function detectStoreUri(
  args: readonly string[],
  config: OpenReceiveFileConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveOpenReceiveStoreUri({
    storeUri: readFlag(args, "--store") ?? config?.storeUri,
    env,
  }).storeUri;
}

function detectNamespace(args: readonly string[], config: OpenReceiveFileConfig | undefined): string {
  return readFlag(args, "--namespace") ?? config?.namespace ?? "default";
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

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return redactSecrets(error.message);
  if (typeof error === "string") return redactSecrets(error);
  return "OpenReceive command failed.";
}
