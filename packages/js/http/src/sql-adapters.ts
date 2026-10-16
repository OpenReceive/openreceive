// The database boundary for the library-owned payment repository: the adapter
// contract every query goes through, and the built-in bindings that wrap a `pg`
// Pool/Client, a mysql2 Pool/Connection or a SQLite handle (node:sqlite or
// better-sqlite3) in it without adding dependencies. The repository itself —
// the tables, the SQL, the settlement and reconciliation transitions — lives in
// sql-payments.ts and only ever talks to an SqlAdapter.

/**
 * Runs one SQL statement and returns SELECT rows (`[]` otherwise). The SQL
 * arrives written for the adapter's own dialect — `?` placeholders on sqlite
 * and mysql, `$1`-style on postgres — so pass it to the driver verbatim.
 * Nothing rewrites it: a `?` inside a string literal, a comment, or a postgres
 * JSON operator (`data ? 'field'`) must survive untouched.
 */
export type SqlQuery = (
  sql: string,
  params?: readonly unknown[],
) => Promise<readonly Record<string, unknown>[]>;

export interface SqlClient {
  readonly query: SqlQuery;
}

/**
 * The escape-hatch database boundary: a dialect, a query function, and a
 * transaction wrapper. The built-in bindings cover `pg` pools/clients, mysql2
 * pools/connections and SQLite (`node:sqlite` or better-sqlite3) without
 * adding dependencies. `mysql` covers MariaDB too.
 */
export interface SqlAdapter extends SqlClient {
  readonly dialect: "postgres" | "sqlite" | "mysql";
  transaction<T>(run: (tx: SqlClient) => Promise<T>): Promise<T>;
}

/**
 * Structural view of a `pg` Pool or Client. A Pool's `connect()` checks out a
 * per-transaction client; a Client's `connect()` opens its one socket and
 * resolves nothing, so it must be called at most once. A handle with only
 * `query` is treated as a single connection and transactions serialize on it.
 */
interface PgLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  // A Pool resolves a pooled client; a pg Client resolves nothing (void).
  connect?(): Promise<unknown>;
}

interface PgPooledClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}

/** Structural view of `node:sqlite` DatabaseSync or a better-sqlite3 Database. */
interface SqliteLike {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
  exec(sql: string): void;
}

/**
 * Structural view of a mysql2/promise Pool or Connection. A Pool checks out a
 * connection per transaction with `getConnection()`; a Connection is one
 * session whose transactions serialize in-process, like a pg Client. The
 * callback API's Pool and Connection reach this shape through `promise()`.
 */
interface MysqlLike extends MysqlSessionLike {
  execute(sql: string, values?: unknown[]): Promise<unknown>;
  getConnection?(): Promise<MysqlSessionLike>;
}

interface MysqlSessionLike {
  query(sql: string, values?: unknown[]): Promise<readonly unknown[]>;
  beginTransaction?(): Promise<void>;
  commit?(): Promise<void>;
  rollback?(): Promise<void>;
  release?(): void;
}

/** A mysql2 callback-API Pool or Connection. */
interface MysqlCallbackLike {
  promise(): MysqlLike;
}

/** Any database handle `createSqlPayments` accepts. */
export type SqlDatabase = SqlAdapter | PgLike | MysqlLike | MysqlCallbackLike | SqliteLike;

/**
 * How long SQLite waits for another connection's write lock before reporting
 * SQLITE_BUSY. The library's transactions are short (one order's rows), so a
 * few seconds covers ordinary contention with the host's own writes.
 */
const SQLITE_BUSY_TIMEOUT_MS = 5_000;

/** Wrap a supported database handle in the uniform adapter interface. */
export function resolveSqlAdapter(db: SqlDatabase): SqlAdapter {
  if (isSqlAdapter(db)) return db;
  // Before pg, which is recognized by query() alone.
  if (isMysqlLike(db)) {
    return mysqlAdapter(isMysqlCallbackLike(db) ? db.promise() : (db as MysqlLike));
  }
  if (isSqliteLike(db)) return sqliteAdapter(db);
  if (isPgLike(db)) return pgAdapter(db);
  throw new TypeError(
    "Unsupported database handle. Pass a pg Pool/Client, a mysql2 Pool/Connection, a SQLite database (node:sqlite or better-sqlite3), or an SqlAdapter.",
  );
}

function isSqlAdapter(db: SqlDatabase): db is SqlAdapter {
  const candidate = db as Partial<SqlAdapter>;
  return (
    (candidate.dialect === "postgres" ||
      candidate.dialect === "sqlite" ||
      candidate.dialect === "mysql") &&
    typeof candidate.transaction === "function" &&
    typeof candidate.query === "function"
  );
}

/**
 * mysql2 Pools and Connections, promise or callback API, carry `execute`
 * beside `query`, plus `getConnection` (a Pool) or `beginTransaction` (a
 * Connection). pg and SQLite handles have neither `execute` nor those.
 */
function isMysqlLike(db: SqlDatabase): boolean {
  const candidate = db as Partial<MysqlLike>;
  return (
    typeof candidate.query === "function" &&
    typeof candidate.execute === "function" &&
    (typeof candidate.getConnection === "function" ||
      typeof candidate.beginTransaction === "function")
  );
}

function isMysqlCallbackLike(db: SqlDatabase): db is MysqlCallbackLike {
  return typeof (db as Partial<MysqlCallbackLike>).promise === "function";
}

function isSqliteLike(db: SqlDatabase): db is SqliteLike {
  const candidate = db as Partial<SqliteLike>;
  return typeof candidate.prepare === "function" && typeof candidate.exec === "function";
}

function isPgLike(db: SqlDatabase): db is PgLike {
  return typeof (db as Partial<PgLike>).query === "function";
}

/**
 * In-process serialization for a single database connection: transactions (and
 * reads that must not observe another request's uncommitted state) run one at
 * a time, in arrival order.
 */
function createSerialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (task) => {
    const result = tail.then(task, task);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

function sqliteAdapter(db: SqliteLike): SqlAdapter {
  // Without a busy timeout, BEGIN IMMEDIATE fails instantly with SQLITE_BUSY
  // whenever another connection (the host's own, typically) holds the write
  // lock, surfacing as a 503 on a checkout that would have succeeded a
  // millisecond later. The pragma makes SQLite wait instead of throwing.
  try {
    db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  } catch {
    // A handle that rejects the pragma (a wrapper, a read-only connection)
    // keeps SQLite's default behaviour rather than failing construction.
  }
  const query: SqlQuery = async (sql, params = []) => {
    const statement = db.prepare(sql);
    if (sqliteStatementReturnsRows(sql, statement)) {
      return statement.all(...params) as Record<string, unknown>[];
    }
    statement.run(...params);
    return [];
  };
  // node:sqlite / better-sqlite3 expose one connection, so concurrent requests
  // serialize through an in-process queue; top-level reads join the same queue
  // so they never observe an open transaction's uncommitted state.
  const enqueue = createSerialQueue();
  return {
    dialect: "sqlite",
    query: (sql, params) => enqueue(() => query(sql, params)),
    transaction(run) {
      return enqueue(async () => {
        // BEGIN IMMEDIATE takes the write lock up front, making concurrent
        // commits for one order serialize at the database.
        db.exec("BEGIN IMMEDIATE");
        try {
          const result = await run({ query });
          db.exec("COMMIT");
          return result;
        } catch (error) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // The transaction may already have rolled back on error.
          }
          throw error;
        }
      });
    },
  };
}

/**
 * Whether a prepared sqlite statement produces rows. better-sqlite3 reports it
 * directly (`reader`); node:sqlite does not, so statements are classified by
 * shape: `SELECT`/`VALUES`/`WITH` heads and any `RETURNING` clause run through
 * `.all()`, per the `SqlQuery` contract. A row-less `WITH … INSERT`
 * still executes correctly under `.all()` and yields `[]`.
 */
function sqliteStatementReturnsRows(sql: string, statement: unknown): boolean {
  const reader = (statement as { reader?: unknown }).reader;
  if (typeof reader === "boolean") return reader;
  return /^\s*(?:select|values|with)\b/i.test(sql) || /\breturning\b/i.test(sql);
}

function isPooledClient(value: unknown): value is PgPooledClientLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PgPooledClientLike).query === "function" &&
    typeof (value as PgPooledClientLike).release === "function"
  );
}

function pgAdapter(db: PgLike): SqlAdapter {
  const queryOn =
    (client: { query: PgLike["query"] }): SqlQuery =>
    async (sql, params = []) => {
      // Verbatim: the library already wrote `$n` for this dialect, and host SQL
      // (the settlement hook's own statements) must not be rewritten at all.
      const result = await client.query(sql, [...params]);
      return result.rows;
    };
  const directQuery = queryOn(db);
  const enqueue = createSerialQueue();

  // A pg Pool checks out a dedicated client per transaction; a pg Client (or a
  // custom query-only handle) is one shared connection whose transactions must
  // serialize in-process — and Client.connect() opens the socket, so it must
  // never be treated as a checkout. Pools are recognized structurally by their
  // counter getters; otherwise the first caller probes connect() once:
  // a Pool returns a client with query + release, a Client resolves undefined
  // (connecting it as a side effect) or rejects because it is already connected.
  let mode: "pool" | "single" | undefined =
    db.connect === undefined
      ? "single"
      : typeof (db as { totalCount?: unknown }).totalCount === "number"
        ? "pool"
        : undefined;

  // The probe is shared: concurrent first callers wait for one in-flight
  // connect() to settle the mode instead of racing their own — a pg Client
  // tolerates exactly one connect(), and the loser's "already been connected"
  // rejection must never surface as a transaction failure.
  let probe: Promise<PgPooledClientLike | undefined> | undefined;

  const probeConnect = async (): Promise<PgPooledClientLike | undefined> => {
    try {
      const client = await db.connect?.();
      if (isPooledClient(client)) {
        mode = "pool";
        return client;
      }
      // pg.Client.connect() resolves undefined after opening its one socket.
      mode = "single";
      return undefined;
    } catch (error) {
      if (error instanceof Error && /already been connected/i.test(error.message)) {
        mode = "single";
        return undefined;
      }
      throw error;
    }
  };

  /** Checks out a per-transaction client on a pool; undefined in single mode. */
  const checkoutPooledClient = async (): Promise<PgPooledClientLike | undefined> => {
    while (mode === undefined) {
      if (probe === undefined) {
        probe = probeConnect();
        try {
          // The probe's connect() doubles as this caller's checkout.
          return await probe;
        } finally {
          if (mode === undefined) probe = undefined;
        }
      }
      // Another caller's probe is in flight; its client belongs to that caller.
      // Wait it out, then re-read the settled mode (an outright connection
      // failure leaves mode unset, and the loop retries with a fresh probe).
      const pending = probe;
      await pending.then(
        () => undefined,
        () => undefined,
      );
      if (probe === pending && mode === undefined) probe = undefined;
    }
    if (mode === "single") return undefined;
    const client = await db.connect?.();
    return isPooledClient(client) ? client : undefined;
  };

  // A plain read must also route through the probe: pg queues query() calls on
  // a never-connected Client indefinitely, so the read would hang until
  // something else happened to call connect().
  const ensureMode = async (): Promise<void> => {
    if (mode !== undefined) return;
    const client = await checkoutPooledClient();
    client?.release();
  };

  const runTransaction = async <T>(
    query: SqlQuery,
    run: (tx: SqlClient) => Promise<T>,
  ): Promise<T> => {
    await query("BEGIN");
    try {
      const result = await run({ query });
      await query("COMMIT");
      return result;
    } catch (error) {
      try {
        await query("ROLLBACK");
      } catch {
        // Connection-level failures surface via the original error.
      }
      throw error;
    }
  };

  return {
    dialect: "postgres",
    // Pooled reads are isolated per checked-out connection; single-connection
    // reads join the transaction queue so they never see uncommitted state.
    query: async (sql, params) => {
      await ensureMode();
      return mode === "pool" ? directQuery(sql, params) : enqueue(() => directQuery(sql, params));
    },
    async transaction(run) {
      const client = await checkoutPooledClient();
      if (client !== undefined) {
        try {
          return await runTransaction(queryOn(client), run);
        } finally {
          client.release();
        }
      }
      return enqueue(() => runTransaction(directQuery, run));
    },
  };
}

function mysqlAdapter(db: MysqlLike): SqlAdapter {
  const queryOn =
    (session: MysqlSessionLike): SqlQuery =>
    async (sql, params = []) => {
      // Verbatim, like pg: `?` is already MySQL's placeholder, and host SQL
      // must not be rewritten. query() resolves [rows, fields] for a SELECT
      // and [ResultSetHeader] for a write; no values means no formatting.
      const [result] = await session.query(sql, params.length === 0 ? undefined : [...params]);
      return Array.isArray(result) ? (result as Record<string, unknown>[]) : [];
    };
  const directQuery = queryOn(db);
  const enqueue = createSerialQueue();
  const pooled = typeof db.getConnection === "function";

  const runTransaction = async <T>(
    session: MysqlSessionLike,
    run: (tx: SqlClient) => Promise<T>,
  ): Promise<T> => {
    if (session.beginTransaction === undefined || session.commit === undefined) {
      throw new TypeError("A mysql2 connection needs beginTransaction() and commit().");
    }
    await session.beginTransaction();
    try {
      const result = await run({ query: queryOn(session) });
      await session.commit();
      return result;
    } catch (error) {
      try {
        await session.rollback?.();
      } catch {
        // Connection-level failures surface via the original error.
      }
      throw error;
    }
  };

  return {
    dialect: "mysql",
    // Pooled reads run on any free connection; a single Connection's reads
    // join the transaction queue so they never see uncommitted state.
    query: (sql, params) =>
      pooled ? directQuery(sql, params) : enqueue(() => directQuery(sql, params)),
    async transaction(run) {
      if (db.getConnection !== undefined) {
        const session = await db.getConnection();
        try {
          return await runTransaction(session, run);
        } finally {
          session.release?.();
        }
      }
      return enqueue(() => runTransaction(db, run));
    },
  };
}

/**
 * Renders one LIBRARY-authored statement for postgres. Only ever applied to
 * SQL written in sql-payments.ts, which contains no string literals, comments,
 * or JSON operators — host SQL is never passed through here.
 */
export function toPgPlaceholders(sql: string): string {
  let index = 0;
  return sql.replaceAll("?", () => {
    index += 1;
    return `$${index}`;
  });
}
