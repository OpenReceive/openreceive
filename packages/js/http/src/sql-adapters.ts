// The database boundary for the library-owned payment repository: the adapter
// contract every query goes through, and the built-in bindings that wrap a `pg`
// Pool/Client or a SQLite handle (node:sqlite or better-sqlite3) in it without
// adding dependencies. The repository itself — the tables, the SQL, the
// settlement and reconciliation transitions — lives in sql-payments.ts and only
// ever talks to an OpenReceiveSqlAdapter.

/**
 * Runs one SQL statement and returns SELECT rows (`[]` otherwise). The SQL
 * arrives written for the adapter's own dialect — `?` placeholders on sqlite,
 * `$1`-style on postgres — so pass it to the driver verbatim. Nothing rewrites
 * it: a `?` inside a string literal, a comment, or a postgres JSON operator
 * (`data ? 'field'`) must survive untouched.
 */
export type OpenReceiveSqlQuery = (
  sql: string,
  params?: readonly unknown[],
) => Promise<readonly Record<string, unknown>[]>;

export interface OpenReceiveSqlClient {
  readonly query: OpenReceiveSqlQuery;
}

/**
 * The escape-hatch database boundary: a dialect, a query function, and a
 * transaction wrapper. The built-in bindings cover `pg` pools/clients and
 * SQLite (`node:sqlite` or better-sqlite3) without adding dependencies.
 */
export interface OpenReceiveSqlAdapter extends OpenReceiveSqlClient {
  readonly dialect: "postgres" | "sqlite";
  transaction<T>(run: (tx: OpenReceiveSqlClient) => Promise<T>): Promise<T>;
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

/** Any database handle `createOpenReceiveSqlPayments` accepts. */
export type OpenReceiveSqlDatabase = OpenReceiveSqlAdapter | PgLike | SqliteLike;

/**
 * How long SQLite waits for another connection's write lock before reporting
 * SQLITE_BUSY. The library's transactions are short (one order's rows), so a
 * few seconds covers ordinary contention with the host's own writes.
 */
const SQLITE_BUSY_TIMEOUT_MS = 5_000;

/** Wrap a supported database handle in the uniform adapter interface. */
export function resolveSqlAdapter(db: OpenReceiveSqlDatabase): OpenReceiveSqlAdapter {
  if (isSqlAdapter(db)) return db;
  if (isSqliteLike(db)) return sqliteAdapter(db);
  if (isPgLike(db)) return pgAdapter(db);
  throw new TypeError(
    "Unsupported database handle. Pass a pg Pool/Client, a SQLite database (node:sqlite or better-sqlite3), or an OpenReceiveSqlAdapter.",
  );
}

function isSqlAdapter(db: OpenReceiveSqlDatabase): db is OpenReceiveSqlAdapter {
  const candidate = db as Partial<OpenReceiveSqlAdapter>;
  return (
    (candidate.dialect === "postgres" || candidate.dialect === "sqlite") &&
    typeof candidate.transaction === "function" &&
    typeof candidate.query === "function"
  );
}

function isSqliteLike(db: OpenReceiveSqlDatabase): db is SqliteLike {
  const candidate = db as Partial<SqliteLike>;
  return typeof candidate.prepare === "function" && typeof candidate.exec === "function";
}

function isPgLike(db: OpenReceiveSqlDatabase): db is PgLike {
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

function sqliteAdapter(db: SqliteLike): OpenReceiveSqlAdapter {
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
  const query: OpenReceiveSqlQuery = async (sql, params = []) => {
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
 * `.all()`, per the `OpenReceiveSqlQuery` contract. A row-less `WITH … INSERT`
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

function pgAdapter(db: PgLike): OpenReceiveSqlAdapter {
  const queryOn =
    (client: { query: PgLike["query"] }): OpenReceiveSqlQuery =>
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
    query: OpenReceiveSqlQuery,
    run: (tx: OpenReceiveSqlClient) => Promise<T>,
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
