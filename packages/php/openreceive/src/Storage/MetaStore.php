<?php

declare(strict_types=1);

namespace OpenReceive\Storage;

use OpenReceive\ConfigurationError;
use OpenReceive\Support\Integers;

/**
 * Engine-owned key/value/rev rows in the host database: the durable reconcile
 * gate every worker and process on this database shares (so rapid
 * OpenReceive calls collapse to one real wallet scan per interval), and the
 * installed schema-version marker the engine refuses to run past. Mirrors the
 * JS claimReconcileGate / assertSupportedSchema and the Rails OpenReceiveMeta.
 */
final class MetaStore
{
    public const RECONCILE_GATE_KEY = 'transaction_scan_gate';
    public const SCHEMA_VERSION_KEY = 'schema_version';
    public const CAS_RETRIES = 6;
    /**
     * Tolerance when reading a timestamp another worker wrote. Beyond it a
     * claim stamped in the future is a backwards clock step, not a fresh
     * claim: without this clamp the gate would read as busy until wall-clock
     * time caught up.
     */
    public const CLOCK_SKEW_SECONDS = 60;

    private bool $schemaChecked = false;

    public function __construct(
        private readonly DatabaseConnection $db,
        private readonly string $table = PaymentsSchema::DEFAULT_META_TABLE,
    ) {
        PaymentsSchema::assertIdentifier($table);
    }

    /**
     * One probe per instance, on the engine's first database touch: a database
     * written by a NEWER library must not be operated by this one. An absent
     * marker is "not versioned", not a refusal; a missing TABLE is diagnosable
     * as "the migration never ran here" and said so.
     */
    public function assertSupportedSchema(): void
    {
        if ($this->schemaChecked) {
            return;
        }
        try {
            $stored = $this->storedSchemaVersion();
        } catch (\PDOException | \RuntimeException $e) {
            if (self::isMissingTableError($e)) {
                throw new ConfigurationError(
                    "The {$this->table} table does not exist — the OpenReceive tables have not been migrated in this "
                    . 'database. Run the statements from OpenReceive\\Storage\\PaymentsSchema::statements() through your '
                    . 'migration workflow. https://openreceive.org/guides/storage.md',
                    0,
                    $e
                );
            }
            // Any other failure keeps the silent pre-versioned behavior; the real query surfaces it.
            return;
        }
        if ($stored !== null && $stored > PaymentsSchema::SCHEMA_VERSION) {
            throw new ConfigurationError(
                "{$this->table} reports openreceive schema version {$stored}, newer than this library's "
                . PaymentsSchema::SCHEMA_VERSION . '. Upgrade openreceive/openreceive before serving this database.'
            );
        }
        $this->schemaChecked = true;
    }

    public function storedSchemaVersion(): ?int
    {
        $rows = $this->db->query("SELECT value FROM {$this->table} WHERE {$this->key()} = ? LIMIT 1", [self::SCHEMA_VERSION_KEY]);
        if ($rows === []) {
            return null;
        }
        try {
            return Integers::parse($rows[0]['value'], 'schema_version');
        } catch (\InvalidArgumentException) {
            return null;
        }
    }

    /**
     * Claim the durable global reconcile gate: optimistic compare-and-set over
     * one shared row. True when this caller may run a wallet scan now; false
     * (gate_busy) when another worker scanned within `$intervalSeconds`. The
     * winner is identified by reading back its own token — the portable
     * equivalent of an affected-row count. A failed scan leaves claimed_at in
     * place on purpose so a broken wallet cannot stampede.
     */
    public function claimReconcileGate(int $now, int $intervalSeconds): bool
    {
        $this->assertSupportedSchema();
        $claim = json_encode(['claimed_at' => $now, 'token' => self::uuid()], JSON_THROW_ON_ERROR);
        for ($attempt = 0; $attempt < self::CAS_RETRIES; $attempt++) {
            $rows = $this->db->query("SELECT value, rev FROM {$this->table} WHERE {$this->key()} = ? LIMIT 1", [self::RECONCILE_GATE_KEY]);
            if ($rows === []) {
                $this->db->execute($this->insertIfAbsentSql(), [self::RECONCILE_GATE_KEY, $claim]);
            } else {
                $claimedAt = self::parseClaimedAt($rows[0]['value']);
                if ($claimedAt !== null && self::isFreshTimestamp($now, $claimedAt, $intervalSeconds)) {
                    return false;
                }
                $this->db->execute(
                    "UPDATE {$this->table} SET value = ?, rev = rev + 1 WHERE {$this->key()} = ? AND rev = ?",
                    [$claim, self::RECONCILE_GATE_KEY, Integers::parse($rows[0]['rev'], 'rev')]
                );
            }
            $readback = $this->db->query("SELECT value FROM {$this->table} WHERE {$this->key()} = ? LIMIT 1", [self::RECONCILE_GATE_KEY]);
            if ($readback !== [] && (string) $readback[0]['value'] === $claim) {
                return true;
            }
        }
        return false;
    }

    /** True when `$timestamp` is inside `$windowSeconds` of `$now`, allowing for skew. */
    public static function isFreshTimestamp(int $now, int $timestamp, int $windowSeconds): bool
    {
        $age = $now - $timestamp;
        if ($age < -self::CLOCK_SKEW_SECONDS) {
            return false;
        }
        return $age < $windowSeconds;
    }

    private function insertIfAbsentSql(): string
    {
        return match ($this->db->dialect()) {
            'pgsql' => "INSERT INTO {$this->table} (key, value, rev) VALUES (?, ?, 0) ON CONFLICT (key) DO NOTHING",
            'mysql' => "INSERT IGNORE INTO {$this->table} (`key`, value, rev) VALUES (?, ?, 0)",
            default => "INSERT OR IGNORE INTO {$this->table} (key, value, rev) VALUES (?, ?, 0)",
        };
    }

    /** `key` is a reserved word in MySQL only. */
    private function key(): string
    {
        return $this->db->dialect() === 'mysql' ? '`key`' : 'key';
    }

    private static function parseClaimedAt(mixed $value): ?int
    {
        $parsed = json_decode((string) $value, true);
        $claimedAt = is_array($parsed) ? ($parsed['claimed_at'] ?? null) : null;
        return is_int($claimedAt) ? $claimedAt : null;
    }

    /**
     * sqlite: "no such table"; postgres: SQLSTATE 42P01; mysql: 1146 / 42S02.
     * Everything else — connection refused, permissions — is not a migration diagnosis.
     */
    private static function isMissingTableError(\Throwable $error): bool
    {
        $message = $error->getMessage();
        return str_contains($message, 'no such table')
            || str_contains($message, '42P01')
            || str_contains($message, '42S02')
            || preg_match('/relation .+ does not exist/i', $message) === 1
            || preg_match("/Table '.+' doesn't exist/i", $message) === 1;
    }

    private static function uuid(): string
    {
        $bytes = random_bytes(16);
        $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
        $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));
    }
}
