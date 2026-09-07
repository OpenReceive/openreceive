<?php

declare(strict_types=1);

namespace OpenReceive\Storage;

/**
 * The engine-owned tables, as DDL statements per dialect: `openreceive_payments`
 * (one row per payment attempt) and `openreceive_meta` (the durable reconcile
 * gate and the installed schema version). The shape is the Rails engine's —
 * datetime columns, JSON as TEXT — so the Laravel migration and the WordPress
 * activation hook both call this and no host writes DDL by hand. Run the
 * statements through the host's own migration workflow; the engine refuses
 * to serve a database stamped with a NEWER schema version.
 *
 * There is deliberately NO unique index over live attempts: liveness is
 * time-dependent (a superseded row stays pending with a future expires_at, an
 * expired row stays pending until a wallet scan closes it), so any such index
 * would reject legitimate reminting. The repository enforces that predicate
 * inside the per-reference commit lock.
 */
final class PaymentsSchema
{
    public const SCHEMA_VERSION = 1;
    public const DEFAULT_TABLE = 'openreceive_payments';
    public const DEFAULT_META_TABLE = 'openreceive_meta';
    public const STATUSES = ['pending', 'settled', 'expired', 'failed', 'attention'];

    /** @return list<string> */
    public static function statements(string $dialect, string $table = self::DEFAULT_TABLE, string $metaTable = self::DEFAULT_META_TABLE): array
    {
        self::assertIdentifier($table);
        self::assertIdentifier($metaTable);
        $statusList = "'" . implode("', '", self::STATUSES) . "'";
        return match ($dialect) {
            'pgsql' => [
                "CREATE TABLE IF NOT EXISTS {$table} (\n"
                . "  id BIGSERIAL PRIMARY KEY,\n"
                . "  reference VARCHAR(255) NOT NULL,\n"
                . "  payment_hash VARCHAR(64) NOT NULL,\n"
                . "  status VARCHAR(255) NOT NULL DEFAULT 'pending',\n"
                . "  status_reason VARCHAR(255),\n"
                . "  paid_at TIMESTAMP(6),\n"
                . "  expires_at TIMESTAMP(6) NOT NULL,\n"
                . "  checkout_data TEXT NOT NULL,\n"
                . "  swap_data TEXT,\n"
                . "  client_ip VARCHAR(255),\n"
                . "  inserted_at TIMESTAMP(6) NOT NULL,\n"
                . "  created_at TIMESTAMP(6) NOT NULL,\n"
                . "  updated_at TIMESTAMP(6) NOT NULL,\n"
                . "  CONSTRAINT {$table}_status_check CHECK (status IN ({$statusList})),\n"
                . "  CONSTRAINT {$table}_payment_hash_check CHECK (payment_hash ~ '^[0-9a-f]{64}$')\n"
                . ')',
                "CREATE UNIQUE INDEX IF NOT EXISTS index_{$table}_on_payment_hash ON {$table} (payment_hash)",
                "CREATE INDEX IF NOT EXISTS index_{$table}_on_reference_and_created_at ON {$table} (reference, created_at)",
                "CREATE INDEX IF NOT EXISTS index_{$table}_on_status_and_created_at ON {$table} (status, created_at)",
                "CREATE INDEX IF NOT EXISTS index_{$table}_on_client_ip_and_inserted_at ON {$table} (client_ip, inserted_at)",
                "CREATE TABLE IF NOT EXISTS {$metaTable} (\n"
                . "  key VARCHAR(255) PRIMARY KEY,\n"
                . "  value TEXT NOT NULL,\n"
                . "  rev BIGINT NOT NULL DEFAULT 0\n"
                . ')',
                "INSERT INTO {$metaTable} (key, value, rev) VALUES ('schema_version', '" . self::SCHEMA_VERSION . "', 0) ON CONFLICT (key) DO NOTHING",
            ],
            'mysql' => [
                // MySQL has no CREATE INDEX IF NOT EXISTS, so the indexes ride inside the table statement.
                "CREATE TABLE IF NOT EXISTS {$table} (\n"
                . "  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,\n"
                . "  reference VARCHAR(255) NOT NULL,\n"
                . "  payment_hash VARCHAR(64) NOT NULL,\n"
                . "  status VARCHAR(255) NOT NULL DEFAULT 'pending',\n"
                . "  status_reason VARCHAR(255),\n"
                . "  paid_at DATETIME(6),\n"
                . "  expires_at DATETIME(6) NOT NULL,\n"
                . "  checkout_data TEXT NOT NULL,\n"
                . "  swap_data TEXT,\n"
                . "  client_ip VARCHAR(255),\n"
                . "  inserted_at DATETIME(6) NOT NULL,\n"
                . "  created_at DATETIME(6) NOT NULL,\n"
                . "  updated_at DATETIME(6) NOT NULL,\n"
                . "  UNIQUE KEY index_{$table}_on_payment_hash (payment_hash),\n"
                . "  KEY index_{$table}_on_reference_and_created_at (reference, created_at),\n"
                . "  KEY index_{$table}_on_status_and_created_at (status, created_at),\n"
                . "  KEY index_{$table}_on_client_ip_and_inserted_at (client_ip, inserted_at),\n"
                . "  CONSTRAINT {$table}_status_check CHECK (status IN ({$statusList})),\n"
                . "  CONSTRAINT {$table}_payment_hash_check CHECK (payment_hash REGEXP '^[0-9a-f]{64}$')\n"
                . ')',
                "CREATE TABLE IF NOT EXISTS {$metaTable} (\n"
                . "  `key` VARCHAR(191) NOT NULL PRIMARY KEY,\n"
                . "  value TEXT NOT NULL,\n"
                . "  rev BIGINT NOT NULL DEFAULT 0\n"
                . ')',
                "INSERT IGNORE INTO {$metaTable} (`key`, value, rev) VALUES ('schema_version', '" . self::SCHEMA_VERSION . "', 0)",
            ],
            'sqlite' => [
                "CREATE TABLE IF NOT EXISTS {$table} (\n"
                . "  id INTEGER PRIMARY KEY AUTOINCREMENT,\n"
                . "  reference VARCHAR(255) NOT NULL,\n"
                . "  payment_hash VARCHAR(64) NOT NULL,\n"
                . "  status VARCHAR(255) NOT NULL DEFAULT 'pending',\n"
                . "  status_reason VARCHAR(255),\n"
                . "  paid_at DATETIME,\n"
                . "  expires_at DATETIME NOT NULL,\n"
                . "  checkout_data TEXT NOT NULL,\n"
                . "  swap_data TEXT,\n"
                . "  client_ip VARCHAR(255),\n"
                . "  inserted_at DATETIME NOT NULL,\n"
                . "  created_at DATETIME NOT NULL,\n"
                . "  updated_at DATETIME NOT NULL,\n"
                . "  CONSTRAINT {$table}_status_check CHECK (status IN ({$statusList})),\n"
                . "  CONSTRAINT {$table}_payment_hash_check CHECK (length(payment_hash) = 64 AND payment_hash NOT GLOB '*[^0-9a-f]*')\n"
                . ')',
                "CREATE UNIQUE INDEX IF NOT EXISTS index_{$table}_on_payment_hash ON {$table} (payment_hash)",
                "CREATE INDEX IF NOT EXISTS index_{$table}_on_reference_and_created_at ON {$table} (reference, created_at)",
                "CREATE INDEX IF NOT EXISTS index_{$table}_on_status_and_created_at ON {$table} (status, created_at)",
                "CREATE INDEX IF NOT EXISTS index_{$table}_on_client_ip_and_inserted_at ON {$table} (client_ip, inserted_at)",
                "CREATE TABLE IF NOT EXISTS {$metaTable} (\n"
                . "  key VARCHAR(255) NOT NULL PRIMARY KEY,\n"
                . "  value TEXT NOT NULL,\n"
                . "  rev BIGINT NOT NULL DEFAULT 0\n"
                . ')',
                "INSERT OR IGNORE INTO {$metaTable} (key, value, rev) VALUES ('schema_version', '" . self::SCHEMA_VERSION . "', 0)",
            ],
            default => throw new \InvalidArgumentException("OpenReceive has no schema for dialect {$dialect}; use pgsql, mysql or sqlite."),
        };
    }

    /**
     * `DROP TABLE` statements for a host's migration `down()`.
     *
     * @return list<string>
     */
    public static function dropStatements(string $table = self::DEFAULT_TABLE, string $metaTable = self::DEFAULT_META_TABLE): array
    {
        self::assertIdentifier($table);
        self::assertIdentifier($metaTable);
        return ["DROP TABLE IF EXISTS {$table}", "DROP TABLE IF EXISTS {$metaTable}"];
    }

    /** Run every statement against a connection (a convenience for tests and the plain-PHP host). */
    public static function migrate(DatabaseConnection $connection, string $table = self::DEFAULT_TABLE, string $metaTable = self::DEFAULT_META_TABLE): void
    {
        foreach (self::statements($connection->dialect(), $table, $metaTable) as $statement) {
            $connection->execute($statement);
        }
    }

    public static function assertIdentifier(string $name): void
    {
        if (preg_match('/\A[A-Za-z_][A-Za-z0-9_]*\z/', $name) !== 1) {
            throw new \InvalidArgumentException("Unsafe SQL identifier: {$name}");
        }
    }
}
