import {
  mkdirSync
} from "node:fs";
import path from "node:path";
import {
  InMemoryInvoiceKvStore,
  type OpenReceiveInvoiceKvStore
} from "@openreceive/core";
import {
  createOpenReceivePostgresKvStore,
  type OpenReceivePostgresQueryClient
} from "./postgres-store.ts";
import {
  createOpenReceiveSqliteKvStore,
  createOpenReceiveSqliteQueryClient,
  type OpenReceiveSqliteDatabase
} from "./sqlite-store.ts";

export interface ResolveOpenReceiveStoreOptions {
  namespace?: string;
  cwd?: string;
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
  close?: () => Promise<void> | void;
};

const DEFAULT_NAMESPACE = "default";
const DEFAULT_STORE_URI = "local-sqlite";

export async function resolveOpenReceiveStore(
  uri = process.env.OPENRECEIVE_STORE,
  options: ResolveOpenReceiveStoreOptions = {}
): Promise<OpenReceiveResolvedStore> {
  const namespace = options.namespace ?? process.env.OPENRECEIVE_NAMESPACE ?? DEFAULT_NAMESPACE;
  const cwd = options.cwd ?? process.cwd();
  const storeUri = uri?.trim() || DEFAULT_STORE_URI;

  if (storeUri === "memory:" || storeUri === "memory") {
    return new InMemoryInvoiceKvStore();
  }

  if (storeUri === "local-sqlite") {
    const root = path.resolve(cwd, ".openreceive");
    mkdirSync(root, { recursive: true });
    const sqlite = await loadSqlite(options.loadSqlite);
    const database = new sqlite.DatabaseSync(path.join(root, `${namespace}.sqlite3`));
    const store = createOpenReceiveSqliteKvStore({
      client: createOpenReceiveSqliteQueryClient(database),
      namespace
    });
    await store.ensureSchema();
    return Object.assign(store, {
      close: () => database.close?.()
    });
  }

  if (storeUri.startsWith("sqlite:")) {
    const sqlitePath = sqlitePathFromUri(storeUri);
    if (sqlitePath !== ":memory:" && !sqlitePath.startsWith("file:")) {
      mkdirSync(path.dirname(path.resolve(sqlitePath)), { recursive: true });
    }
    const sqlite = await loadSqlite(options.loadSqlite);
    const database = new sqlite.DatabaseSync(sqlitePath);
    const store = createOpenReceiveSqliteKvStore({
      client: createOpenReceiveSqliteQueryClient(database),
      namespace
    });
    await store.ensureSchema();
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
    await store.ensureSchema();
    return Object.assign(store, {
      close: () => pool.end?.()
    });
  }

  if (/^mysql:\/\//.test(storeUri)) {
    throw new Error("MySQL store URI support is planned but not installed in this package build.");
  }

  if (/^redis(?:s)?:\/\//.test(storeUri)) {
    throw new Error("Redis store URI support is planned but not installed in this package build.");
  }

  throw new Error(`Unsupported OPENRECEIVE_STORE URI: ${storeUri}`);
}

function sqlitePathFromUri(uri: string): string {
  if (uri.startsWith("sqlite:///")) return uri.slice("sqlite://".length);
  if (uri.startsWith("sqlite://")) return uri.slice("sqlite://".length);
  return uri.replace(/^sqlite:/, "");
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
    const sqlite3Module = await import(/* @vite-ignore */ `sqlite${"3"}`) as unknown as {
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
  } catch {
    throw new Error("SQLite store requires a Node runtime with built-in SQLite support, the `sqlite3` package, or an injected SQLite loader.");
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
