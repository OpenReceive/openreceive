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
      close?: () => void;
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
    throw new Error("SQLite store requires a Node runtime with node:sqlite support.");
  }
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
