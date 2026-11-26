<?php

/**
 * @package     pkg_openreceive
 * @copyright   (C) 2026 OpenReceive
 * @license     GPL-2.0-or-later; see LICENSE
 */

declare(strict_types=1);

namespace OpenReceiveHikaShop;

use OpenReceive\Storage\DatabaseConnection;

/**
 * The engine's database seam over the mysqli link of Joomla's own database
 * driver (Joomla's default, `mysqli`). The settlement transaction runs on
 * that link, so what HikaShop writes through Joomla's driver inside onPaid
 * commits with the payment row, or rolls back with it. Every value is bound
 * through a prepared statement; nothing is concatenated into the SQL.
 */
final class MysqliConnection implements DatabaseConnection
{
    private int $depth = 0;

    public function __construct(private readonly \mysqli $link)
    {
    }

    public function dialect(): string
    {
        return 'mysql';
    }

    public function query(string $sql, array $params = []): array
    {
        $statement = $this->run($sql, $params);
        try {
            $result = $statement->get_result();
            if ($result === false) {
                if ($statement->errno !== 0) {
                    throw new \RuntimeException('OpenReceive database read failed: ' . $statement->error);
                }
                return [];
            }
            /** @var list<array<string, mixed>> $rows */
            $rows = $result->fetch_all(MYSQLI_ASSOC);
            $result->free();
            return $rows;
        } finally {
            $statement->close();
        }
    }

    public function execute(string $sql, array $params = []): int
    {
        $statement = $this->run($sql, $params);
        try {
            $result = $statement->get_result();
            if ($result instanceof \mysqli_result) {
                $result->free();
            }
            return max(0, (int) $statement->affected_rows);
        } finally {
            $statement->close();
        }
    }

    public function transaction(callable $fn): mixed
    {
        if ($this->depth > 0) {
            return $fn($this);
        }
        if (!$this->link->begin_transaction()) {
            throw new \RuntimeException('OpenReceive could not start a database transaction: ' . $this->link->error);
        }
        $this->depth++;
        try {
            $result = $fn($this);
            if (!$this->link->commit()) {
                throw new \RuntimeException('OpenReceive could not commit a database transaction: ' . $this->link->error);
            }
            return $result;
        } catch (\Throwable $error) {
            $this->link->rollback();
            throw $error;
        } finally {
            $this->depth--;
        }
    }

    public function lastInsertId(): string
    {
        return (string) $this->link->insert_id;
    }

    /** @param list<mixed> $params */
    private function run(string $sql, array $params): \mysqli_stmt
    {
        $statement = $this->link->prepare($sql);
        if (!$statement instanceof \mysqli_stmt) {
            throw new \RuntimeException('OpenReceive database statement failed: ' . $this->link->error);
        }
        if ($params !== []) {
            $types = '';
            $values = [];
            foreach (array_values($params) as $value) {
                [$type, $bound] = match (true) {
                    is_int($value) => ['i', $value],
                    is_bool($value) => ['i', (int) $value],
                    is_float($value) => ['d', $value],
                    $value === null => ['s', null],
                    default => ['s', (string) $value],
                };
                $types .= $type;
                $values[] = $bound;
            }
            $statement->bind_param($types, ...$values);
        }
        if (!$statement->execute()) {
            $error = $statement->error;
            $statement->close();
            throw new \RuntimeException('OpenReceive database statement failed: ' . $error);
        }
        return $statement;
    }
}
