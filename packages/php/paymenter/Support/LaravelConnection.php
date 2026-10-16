<?php

declare(strict_types=1);

namespace Paymenter\Extensions\Gateways\OpenReceive\Support;

use Illuminate\Database\Connection;
use OpenReceive\Storage\DatabaseConnection;

/**
 * The engine's database seam over Paymenter's own Laravel connection. The
 * settlement transaction runs through Laravel's transaction manager, so
 * Paymenter's addPayment inside onPaid nests as a savepoint of it, and the
 * work Paymenter defers with DB::afterCommit (the invoice's Paid event:
 * service activation, the receipt email) runs once the settlement commits.
 */
final class LaravelConnection implements DatabaseConnection
{
    public function __construct(private readonly Connection $connection)
    {
    }

    public function dialect(): string
    {
        return match ($this->connection->getDriverName()) {
            'mysql', 'mariadb' => 'mysql',
            'pgsql' => 'pgsql',
            'sqlite' => 'sqlite',
            default => throw new \InvalidArgumentException('OpenReceive supports MySQL, MariaDB, PostgreSQL and SQLite; this Paymenter uses ' . $this->connection->getDriverName() . '.'),
        };
    }

    public function query(string $sql, array $params = []): array
    {
        return array_map(static fn (object $row): array => (array) $row, $this->connection->select($sql, $params, false));
    }

    public function execute(string $sql, array $params = []): int
    {
        return $this->connection->affectingStatement($sql, $params);
    }

    public function transaction(callable $fn): mixed
    {
        return $this->connection->transaction(fn (): mixed => $fn($this));
    }

    public function lastInsertId(): string
    {
        return (string) $this->connection->getPdo()->lastInsertId();
    }
}
