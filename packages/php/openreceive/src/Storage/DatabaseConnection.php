<?php

declare(strict_types=1);

namespace OpenReceive\Storage;

/**
 * The five-method seam between the repository and a database driver. PDO
 * ships here (PdoConnection); WordPress supplies a `$wpdb`/mysqli adapter.
 * Positional `?` placeholders only — an adapter rewrites them if its driver
 * needs another style. Kept this small on purpose.
 */
interface DatabaseConnection
{
    /** One of `pgsql`, `mysql`, `sqlite`. */
    public function dialect(): string;

    /**
     * Run a statement that returns rows.
     *
     * @param list<mixed> $params
     * @return list<array<string, mixed>>
     */
    public function query(string $sql, array $params = []): array;

    /**
     * Run a statement that returns no rows; the affected-row count.
     *
     * @param list<mixed> $params
     */
    public function execute(string $sql, array $params = []): int;

    /**
     * Run `$fn` inside a transaction (committed on return, rolled back on a
     * throw). A nested call joins the transaction already open: the host's
     * `onPaid` statements land in the settlement transaction that way.
     *
     * @template T
     * @param callable(DatabaseConnection): T $fn
     * @return T
     */
    public function transaction(callable $fn): mixed;

    public function lastInsertId(): string;
}
