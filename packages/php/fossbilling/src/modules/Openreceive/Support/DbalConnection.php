<?php

declare(strict_types=1);

namespace Box\Mod\Openreceive\Support;

use Doctrine\DBAL\Connection;
use Doctrine\DBAL\ParameterType;
use Doctrine\DBAL\Platforms\AbstractMySQLPlatform;
use Doctrine\DBAL\Platforms\PostgreSQLPlatform;
use Doctrine\DBAL\Platforms\SQLitePlatform;
use OpenReceive\Storage\DatabaseConnection;

/**
 * The engine's database seam over FOSSBilling's shared DBAL connection, the
 * one its Doctrine and RedBeanPHP code use too. The settlement transaction
 * runs through DBAL, so FOSSBilling's own writes inside onPaid (the
 * transaction log, the client's balance) commit or roll back with it, and a
 * Doctrine flush there nests as a savepoint.
 */
final class DbalConnection implements DatabaseConnection
{
    public function __construct(private readonly Connection $connection)
    {
    }

    /** FOSSBilling itself runs only on MySQL or MariaDB. */
    public function dialect(): string
    {
        $platform = $this->connection->getDatabasePlatform();
        return match (true) {
            $platform instanceof AbstractMySQLPlatform => 'mysql',
            $platform instanceof PostgreSQLPlatform => 'pgsql',
            $platform instanceof SQLitePlatform => 'sqlite',
            default => throw new \InvalidArgumentException('OpenReceive supports MySQL, MariaDB, PostgreSQL and SQLite; this database is ' . $platform::class . '.'),
        };
    }

    public function query(string $sql, array $params = []): array
    {
        return $this->connection->fetchAllAssociative($sql, $params, self::types($params));
    }

    public function execute(string $sql, array $params = []): int
    {
        return (int) $this->connection->executeStatement($sql, $params, self::types($params));
    }

    public function transaction(callable $fn): mixed
    {
        return $this->connection->transactional(fn (): mixed => $fn($this));
    }

    public function lastInsertId(): string
    {
        return (string) $this->connection->lastInsertId();
    }

    /**
     * DBAL binds an untyped parameter as a string, which MySQL refuses in
     * LIMIT ('200'). Bind each value by its PHP type, as PDO hosts do.
     *
     * @param list<mixed> $params
     * @return list<ParameterType>
     */
    private static function types(array $params): array
    {
        return array_map(static fn (mixed $value): ParameterType => match (true) {
            is_int($value) => ParameterType::INTEGER,
            is_bool($value) => ParameterType::BOOLEAN,
            $value === null => ParameterType::NULL,
            default => ParameterType::STRING,
        }, array_values($params));
    }
}
