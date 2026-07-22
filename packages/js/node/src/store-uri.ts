import {
  mkdirSync
} from "node:fs";
import {
  createRequire
} from "node:module";
import path from "node:path";
import type {
  OpenReceiveInvoiceKvStore
} from "@openreceive/core";
import { OpenReceiveConfigError } from "./config-error.ts";
import {
  createOpenReceivePostgresKvStore,
  type OpenReceivePostgresQueryClient
} from "./postgres-store.ts";
import {
  assertOpenReceiveStoreConfiguration,
  sqlitePathFromUri
} from "./storage-guard.ts";
import {
  createOpenReceiveSqliteKvStore,
  createOpenReceiveSqliteQueryClient,
  type OpenReceiveSqliteDatabase
} from "./sqlite-store.ts";

export interface ResolveOpenReceiveStoreOptions {
  namespace?: string;
  cwd?: string;
  schemaMode?: OpenReceiveSchemaMode;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  loadSqlite?: () => Promise<{
    DatabaseSync: new (filename: string) => OpenReceiveSqliteDatabase & {
      close?: () => void | Promise<void>;
    };
  }>;
  loadPostgres?: () => Promise<{
    Pool: new (options: { connectionString: string }) => OpenReceivePostgresQueryClient & {
      end?: () => Promise<void>;
    };
  }>;
}

export type OpenReceiveResolvedStore = OpenReceiveInvoiceKvStore & {
  ensureSchema?: () => Promise<void>;
  assertSchemaReady?: () => Promise<void>;
  close?: () => Promise<void> | void;
};

export type OpenReceiveSchemaMode = "auto" | "check" | "skip";

export type OpenReceiveStoreUriSource =
  | "explicit"
  | "database_private_url"
  | "database_url"
  | "local-sqlite";

export interface ResolvedOpenReceiveStoreUri {
  readonly storeUri: string;
  readonly source: OpenReceiveStoreUriSource;
}

const DEFAULT_NAMESPACE = "default";
const DEFAULT_STORE_URI = "local-sqlite";
const require = createRequire(import.meta.url);

/**
 * Resolve which store URI to use.
 *
 * Precedence: explicit `store` → postgres DATABASE_PRIVATE_URL →
 * postgres DATABASE_URL → local-sqlite. Non-postgres DATABASE_* values are ignored.
 */
export function resolveOpenReceiveStoreUri(input: {
  readonly storeUri?: string;
  readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
} = {}): ResolvedOpenReceiveStoreUri {
  const explicit = input.storeUri?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    return { storeUri: explicit, source: "explicit" };
  }
  const env = input.env ?? globalThis.process?.env ?? {};
  const privateUrl = readPostgresDatabaseEnv(env.DATABASE_PRIVATE_URL);
  if (privateUrl !== undefined) {
    return { storeUri: privateUrl, source: "database_private_url" };
  }
  const databaseUrl = readPostgresDatabaseEnv(env.DATABASE_URL);
  if (databaseUrl !== undefined) {
    return { storeUri: databaseUrl, source: "database_url" };
  }
  return { storeUri: DEFAULT_STORE_URI, source: "local-sqlite" };
}

function readPostgresDatabaseEnv(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (!/^postgres(?:ql)?:\/\//i.test(trimmed)) return undefined;
  return trimmed;
}

export async function resolveOpenReceiveStore(
  uri?: string,
  options: ResolveOpenReceiveStoreOptions = {}
): Promise<OpenReceiveResolvedStore> {
  const namespace = options.namespace ?? DEFAULT_NAMESPACE;
  const cwd = options.cwd ?? process.cwd();
  const resolved = resolveOpenReceiveStoreUri({ storeUri: uri, env: options.env });
  assertOpenReceiveStoreConfiguration({ storeUri: resolved.storeUri, env: options.env });
  const storeUri = resolved.storeUri;
  const schemaMode = options.schemaMode ?? defaultSchemaMode(storeUri);

  if (storeUri === "local-sqlite") {
    const root = path.resolve(cwd, ".openreceive");
    mkdirSync(root, { recursive: true });
    const sqlite = await loadSqlite(options.loadSqlite);
    const database = new sqlite.DatabaseSync(path.join(root, `${namespace}.sqlite3`));
    const store = createOpenReceiveSqliteKvStore({
      client: createOpenReceiveSqliteQueryClient(database),
      namespace
    });
    await applyStoreSchemaMode(store, schemaMode, storeUri, namespace);
    return Object.assign(store, {
      close: () => database.close?.()
    });
  }

  if (storeUri.startsWith("sqlite:")) {
    const sqlitePath = sqlitePathFromUri(storeUri);
    if (!sqlitePath.startsWith("file:")) {
      mkdirSync(path.dirname(path.resolve(sqlitePath)), { recursive: true });
    }
    const sqlite = await loadSqlite(options.loadSqlite);
    const database = new sqlite.DatabaseSync(sqlitePath);
    const store = createOpenReceiveSqliteKvStore({
      client: createOpenReceiveSqliteQueryClient(database),
      namespace
    });
    await applyStoreSchemaMode(store, schemaMode, storeUri, namespace);
    return Object.assign(store, {
      close: () => database.close?.()
    });
  }

  if (/^postgres(?:ql)?:\/\//.test(storeUri)) {
    const postgres = await loadPostgres(options.loadPostgres);
    const pool = new postgres.Pool({ connectionString: storeUri });
    const store = createOpenReceivePostgresKvStore({
      client: pool,
      namespace
    });
    try {
      await applyStoreSchemaMode(store, schemaMode, storeUri, namespace);
    } catch (error) {
      await pool.end?.();
      throw error;
    }
    return Object.assign(store, {
      close: () => pool.end?.()
    });
  }

  throw new Error(`Unsupported store URI: ${storeUri}`);
}

export function defaultSchemaMode(storeUri: string): OpenReceiveSchemaMode {
  return storeUri === "local-sqlite" ? "auto" : "check";
}

export async function applyStoreSchemaMode(
  store: OpenReceiveResolvedStore,
  schemaMode: OpenReceiveSchemaMode,
  storeUri: string,
  namespace: string
): Promise<void> {
  if (schemaMode === "skip") return;
  if (schemaMode === "auto") {
    await store.ensureSchema?.();
    return;
  }
  try {
    await store.assertSchemaReady?.();
  } catch (error) {
    throw migrationsRequiredError(storeUri, namespace, error);
  }
}

function migrationsRequiredError(
  storeUri: string,
  namespace: string,
  cause: unknown
): OpenReceiveConfigError {
  const storeName = /^postgres(?:ql)?:\/\//.test(storeUri)
    ? "Postgres"
    : storeUri.startsWith("sqlite:")
      ? "SQLite"
      : "SQL";
  return new OpenReceiveConfigError({
    code: "STORE_MIGRATIONS_REQUIRED",
    message: `OpenReceive ${storeName} store schema is not ready; refusing to boot without migrations.`,
    hint: [
      `Run \`openreceive migrate --store <uri> --namespace ${namespace}\` before starting the app.`,
      "If `store` is omitted, migrate uses DATABASE_PRIVATE_URL / DATABASE_URL when they are Postgres URIs.",
      "To review the SQL first, run `openreceive migrate --store <uri> --print`.",
    ].join(" "),
    cause
  });
}

async function loadSqlite(
  override: ResolveOpenReceiveStoreOptions["loadSqlite"]
): Promise<{
  DatabaseSync: new (filename: string) => OpenReceiveSqliteDatabase & {
    close?: () => void | Promise<void>;
  };
}> {
  if (override !== undefined) return override();
  try {
    return await import(/* @vite-ignore */ `node:${"sqlite"}`) as unknown as {
      DatabaseSync: new (filename: string) => OpenReceiveSqliteDatabase & {
        close?: () => void | Promise<void>;
      };
    };
  } catch {
    return await loadSqlite3Package();
  }
}

async function loadSqlite3Package(): Promise<{
  DatabaseSync: new (filename: string) => OpenReceiveSqliteDatabase & {
    close?: () => Promise<void>;
  };
}> {
  try {
    const sqlite3Module = require("sqlite3") as {
      default?: {
        Database?: new (filename: string) => NodeSqlite3Database;
      };
      Database?: new (filename: string) => NodeSqlite3Database;
    };
    const Database = sqlite3Module.Database ?? sqlite3Module.default?.Database;
    if (Database === undefined) throw new Error("sqlite3 Database export not found");
    const NodeSqlite3Database = Database;
    return {
      DatabaseSync: class OpenReceiveNodeSqlite3Database implements OpenReceiveSqliteDatabase {
        readonly #database: NodeSqlite3Database;

        constructor(filename: string) {
          this.#database = new NodeSqlite3Database(filename);
          this.#database.configure?.("busyTimeout", 5000);
        }

        prepare(sql: string) {
          return {
            get: (...values: unknown[]) => new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
              this.#database.get(sql, values, (error, row) => {
                if (error !== null) {
                  reject(error);
                  return;
                }
                resolve(row);
              });
            }),
            all: (...values: unknown[]) => new Promise<Record<string, unknown>[]>((resolve, reject) => {
              this.#database.all(sql, values, (error, rows) => {
                if (error !== null) {
                  reject(error);
                  return;
                }
                resolve(rows);
              });
            }),
            run: (...values: unknown[]) => new Promise<void>((resolve, reject) => {
              this.#database.run(sql, values, (error) => {
                if (error !== null) {
                  reject(error);
                  return;
                }
                resolve();
              });
            })
          };
        }

        exec(sql: string): Promise<void> {
          return new Promise((resolve, reject) => {
            this.#database.exec(sql, (error) => {
              if (error !== null) {
                reject(error);
                return;
              }
              resolve();
            });
          });
        }

        close(): Promise<void> {
          return new Promise((resolve, reject) => {
            this.#database.close((error) => {
              if (error !== null) {
                reject(error);
                return;
              }
              resolve();
            });
          });
        }
      }
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `SQLite store requires a Node runtime with built-in SQLite support, the \`sqlite3\` package, or an injected SQLite loader. sqlite3 load failed: ${reason}`,
      { cause: error }
    );
  }
}

interface NodeSqlite3Database {
  configure?(option: "busyTimeout", value: number): void;
  get(
    sql: string,
    values: readonly unknown[],
    callback: (error: Error | null, row: Record<string, unknown> | undefined) => void
  ): void;
  all(
    sql: string,
    values: readonly unknown[],
    callback: (error: Error | null, rows: Record<string, unknown>[]) => void
  ): void;
  run(
    sql: string,
    values: readonly unknown[],
    callback: (error: Error | null) => void
  ): void;
  exec(sql: string, callback: (error: Error | null) => void): void;
  close(callback: (error: Error | null) => void): void;
}

async function loadPostgres(
  override: ResolveOpenReceiveStoreOptions["loadPostgres"]
): Promise<{
  Pool: new (options: { connectionString: string }) => OpenReceivePostgresQueryClient & {
    end?: () => Promise<void>;
  };
}> {
  if (override !== undefined) return override();
  try {
    const pg = await import("pg") as unknown as {
      default?: {
        Pool?: new (options: { connectionString: string }) => OpenReceivePostgresQueryClient & {
          end?: () => Promise<void>;
        };
      };
      Pool?: new (options: { connectionString: string }) => OpenReceivePostgresQueryClient & {
        end?: () => Promise<void>;
      };
    };
    const Pool = pg.Pool ?? pg.default?.Pool;
    if (Pool === undefined) throw new Error("pg Pool export not found");
    return { Pool };
  } catch {
    throw new Error("Postgres store requires installing the `pg` package in the app.");
  }
}
