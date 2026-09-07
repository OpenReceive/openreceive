<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;
use OpenReceive\Storage\PaymentsSchema;

/**
 * Both engine-owned tables, in one migration: `openreceive_payments` (one row
 * per payment attempt) and `openreceive_meta` (the durable reconcile gate and
 * the installed schema version). Same host database, never a second one.
 *
 * The DDL is the library's, rendered per driver by PaymentsSchema — this file
 * writes none of it by hand, so an engine upgrade that changes the schema ships
 * a new migration rather than a diff you maintain. It runs against the
 * connection named in config('openreceive.connection') (null = default).
 */
return new class extends Migration
{
    public function getConnection(): ?string
    {
        return config('openreceive.connection');
    }

    public function up(): void
    {
        $connection = DB::connection($this->getConnection());
        foreach (PaymentsSchema::statements(self::dialect($connection->getDriverName())) as $statement) {
            $connection->statement($statement);
        }
    }

    public function down(): void
    {
        $connection = DB::connection($this->getConnection());
        foreach (PaymentsSchema::dropStatements() as $statement) {
            $connection->statement($statement);
        }
    }

    /** Laravel's driver names are pgsql | mysql | mariadb | sqlite; MariaDB takes the MySQL DDL. */
    private static function dialect(string $driver): string
    {
        return $driver === 'mariadb' ? 'mysql' : $driver;
    }
};
