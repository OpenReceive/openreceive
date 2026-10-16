<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;
use OpenReceive\Storage\PaymentsSchema;

/**
 * The engine's two tables in Paymenter's own database: openreceive_payments
 * (one row per payment attempt) and openreceive_meta (the reconcile gate and
 * the schema version). The DDL is the library's, rendered for this database.
 * The tables stay when the gateway is deleted: they are a payment record.
 */
return new class extends Migration
{
    public function up(): void
    {
        $connection = DB::connection();
        $dialect = in_array($connection->getDriverName(), ['mysql', 'mariadb'], true) ? 'mysql' : $connection->getDriverName();
        foreach (PaymentsSchema::statements($dialect) as $statement) {
            // A MySQL server's default engine may be MyISAM; settlement needs transactions.
            if ($dialect === 'mysql' && str_starts_with($statement, 'CREATE TABLE')) {
                $statement .= ' ENGINE=InnoDB';
            }
            $connection->statement($statement);
        }
    }

    public function down(): void
    {
        $connection = DB::connection();
        foreach (PaymentsSchema::dropStatements() as $statement) {
            $connection->statement($statement);
        }
    }
};
