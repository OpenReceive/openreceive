<?php

declare(strict_types=1);

namespace OpenReceive\Storage;

/**
 * DatabaseConnection over the host's PDO handle. The dialect comes from the
 * driver name; a driver this engine has no DDL/lock recipe for is refused at
 * construction rather than at the first query.
 */
final class PdoConnection implements DatabaseConnection
{
    /** SQLite busy timeout, seconds: writers wait on the file lock instead of failing with SQLITE_BUSY. */
    public const SQLITE_BUSY_TIMEOUT_SECONDS = 5;

    private readonly string $dialect;
    private int $depth = 0;

    public function __construct(private readonly \PDO $pdo)
    {
        $driver = (string) $pdo->getAttribute(\PDO::ATTR_DRIVER_NAME);
        if (!in_array($driver, ['pgsql', 'mysql', 'sqlite'], true)) {
            throw new \InvalidArgumentException("OpenReceive supports PDO drivers pgsql, mysql and sqlite; got {$driver}.");
        }
        $this->dialect = $driver;
        $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        if ($driver === 'sqlite') {
            // pdo_sqlite's busy timeout is PDO::ATTR_TIMEOUT, not a PRAGMA.
            $pdo->setAttribute(\PDO::ATTR_TIMEOUT, self::SQLITE_BUSY_TIMEOUT_SECONDS);
        }
    }

    public static function fromDsn(string $dsn, ?string $username = null, ?string $password = null): self
    {
        return new self(new \PDO($dsn, $username, $password));
    }

    public function pdo(): \PDO
    {
        return $this->pdo;
    }

    public function dialect(): string
    {
        return $this->dialect;
    }

    public function query(string $sql, array $params = []): array
    {
        $statement = $this->run($sql, $params);
        /** @var list<array<string, mixed>> $rows */
        $rows = $statement->fetchAll(\PDO::FETCH_ASSOC);
        return $rows;
    }

    public function execute(string $sql, array $params = []): int
    {
        return $this->run($sql, $params)->rowCount();
    }

    public function transaction(callable $fn): mixed
    {
        if ($this->depth > 0) {
            $this->depth++;
            try {
                return $fn($this);
            } finally {
                $this->depth--;
            }
        }
        $this->begin();
        $this->depth = 1;
        try {
            $result = $fn($this);
            $this->commit();
            return $result;
        } catch (\Throwable $e) {
            $this->rollBack();
            throw $e;
        } finally {
            $this->depth = 0;
        }
    }

    public function lastInsertId(): string
    {
        return (string) $this->pdo->lastInsertId();
    }

    /** @param list<mixed> $params */
    private function run(string $sql, array $params): \PDOStatement
    {
        $statement = $this->pdo->prepare($sql);
        foreach (array_values($params) as $index => $value) {
            $type = match (true) {
                $value === null => \PDO::PARAM_NULL,
                is_bool($value) => \PDO::PARAM_BOOL,
                is_int($value) => \PDO::PARAM_INT,
                default => \PDO::PARAM_STR,
            };
            $statement->bindValue($index + 1, $value, $type);
        }
        $statement->execute();
        return $statement;
    }

    private function begin(): void
    {
        if ($this->dialect === 'sqlite') {
            // BEGIN IMMEDIATE takes the write lock up front, so two committers
            // serialize on the file instead of one failing at COMMIT.
            $this->pdo->exec('BEGIN IMMEDIATE');
            return;
        }
        $this->pdo->beginTransaction();
    }

    private function commit(): void
    {
        if ($this->dialect === 'sqlite') {
            $this->pdo->exec('COMMIT');
            return;
        }
        $this->pdo->commit();
    }

    private function rollBack(): void
    {
        try {
            if ($this->dialect === 'sqlite') {
                $this->pdo->exec('ROLLBACK');
                return;
            }
            $this->pdo->rollBack();
        } catch (\PDOException) {
            // The server may already have ended the transaction (deadlock, lost connection).
        }
    }
}
