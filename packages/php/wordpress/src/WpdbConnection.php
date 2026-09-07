<?php
declare(strict_types=1);
namespace OpenReceive\WP;

use OpenReceive\Storage\DatabaseConnection;

final class WpdbConnection implements DatabaseConnection
{
    private int $depth = 0;

    public function __construct(private readonly \wpdb $db) {}
    public function dialect(): string { return 'mysql'; }
    public function lastInsertId(): string { return (string) $this->db->insert_id; }

    private function sql(string $sql, array $params): string
    {
        if ($params === []) { return $sql; }
        // Engine SQL has positional parameters and no literal question marks.
        $parts = explode('?', $sql);
        if (count($parts) !== count($params) + 1) { throw new \LogicException('SQL parameter count mismatch.'); }
        $result = array_shift($parts);
        foreach ($params as $i => $value) {
            $result .= ($value === null ? 'NULL' : $this->db->prepare(is_int($value) ? '%d' : '%s', $value)) . $parts[$i];
        }
        return $result;
    }

    public function query(string $sql, array $params = []): array
    {
        $previous = $this->db->suppress_errors(true);
        try {
            $rows = $this->db->get_results($this->sql($sql, $params), ARRAY_A);
            if ($this->db->last_error !== '') { throw new \RuntimeException('OpenReceive database read failed.'); }
            return $rows ?? [];
        } finally { $this->db->suppress_errors($previous); }
    }

    public function execute(string $sql, array $params = []): int
    {
        $previous = $this->db->suppress_errors(true);
        try {
            $count = $this->db->query($this->sql($sql, $params));
            if ($count === false) { throw new \RuntimeException('OpenReceive database write failed.'); }
            return (int) $count;
        } finally { $this->db->suppress_errors($previous); }
    }

    public function transaction(callable $fn): mixed
    {
        if ($this->depth > 0) { return $fn($this); }
        $this->execute('START TRANSACTION');
        $this->depth++;
        try {
            $result = $fn($this);
            $this->execute('COMMIT');
            return $result;
        } catch (\Throwable $error) {
            $this->execute('ROLLBACK');
            throw $error;
        } finally { $this->depth--; }
    }
}
