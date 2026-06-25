import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  reconcileOnce
} from "@openreceive/core";
import type {
  OpenReceive,
  OpenReceiveNodeOptions
} from "./service.ts";
import type {
  OpenReceiveSqliteDatabase
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

type OpenReceiveNodeConfig = OpenReceive | OpenReceiveNodeOptions;

const HELP = `
Usage: openreceive <command> [options]

Commands:
  migrate             Ensure the OpenReceive store schema exists; --print emits DDL.
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
      case "migrate":
        return await runMigrate({
          args,
          env,
          cwd,
          stdout,
          loadSqlite: options.loadSqlite,
          loadPostgres: options.loadPostgres
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
        stderr.write(`OpenReceive ${command} was removed. Use service-backed recovery plus \`openreceive poll --once\` for optional schedulers.\n`);
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
  if (isOpenReceiveServiceConfig(config)) {
    const result = await config.poll();
    input.stdout.write(`OpenReceive poll checked ${result.checked} wallet invoice(s) across ${result.invoice_ids.length} open invoice(s).\n`);
    return 0;
  }
  if (config.store === undefined) {
    throw new Error("OpenReceive poll requires config.store.");
  }
  const result = await reconcileOnce({
    store: config.store,
    client: config.client,
    settlementAction: async ({ invoice, metadata, source, lookup_invoice }) => {
      await config.onPaid?.({
        invoice,
        orderUuid: invoice.idempotency_key,
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

function isOpenReceiveServiceConfig(config: OpenReceiveNodeConfig): config is OpenReceive {
  return (
    typeof (config as { poll?: unknown }).poll === "function" &&
    !("client" in config)
  );
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

function detectStoreUri(args: readonly string[], env: NodeJS.ProcessEnv): string {
  const storeUri = readFlag(args, "--store") ?? env.OPENRECEIVE_STORE;
  if (storeUri !== undefined && storeUri.trim().length > 0) return storeUri;
  return "local-sqlite";
}

function detectNamespace(args: readonly string[], env: NodeJS.ProcessEnv): string {
  return readFlag(args, "--namespace") ?? env.OPENRECEIVE_NAMESPACE ?? "default";
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
