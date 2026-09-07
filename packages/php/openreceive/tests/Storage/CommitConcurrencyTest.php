<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Storage;

use OpenReceive\Server\Errors\ConflictError;
use OpenReceive\Storage\SqlPaymentRepository;
use PHPUnit\Framework\Attributes\DataProvider;

/**
 * Real concurrency on the commit path (AGENTS.md: invoice behavior needs
 * host-row retry/concurrency tests): forked processes race commitAttempt for
 * ONE reference. Same hash from every process = a retry storm: every caller
 * gets the one row. Distinct hashes on one rail = exactly one wins the live
 * slot, the rest are refused with the agreed conflict. sqlite runs on a file
 * (BEGIN IMMEDIATE + busy timeout); pgsql/mysql exercise the advisory / named lock.
 */
final class CommitConcurrencyTest extends DatabaseCase
{
    private const WORKERS = 6;

    /** @return iterable<string, array{0: string}> */
    public static function forkDialects(): iterable
    {
        if (!function_exists('pcntl_fork')) {
            return;
        }
        yield from self::dialects();
    }

    /** @return array{0: string, 1: ?string} dialect + sqlite file path */
    private function prepare(string $dialect): array
    {
        $path = $dialect === 'sqlite' ? tempnam(sys_get_temp_dir(), 'openreceive-commit-') : null;
        $db = self::freshDatabase($dialect, $path);
        $db->execute("INSERT INTO openreceive_payments (reference, payment_hash, status, expires_at, checkout_data, inserted_at, created_at, updated_at) VALUES ('warm', ?, 'expired', '2000-01-01 00:00:00', '{}', '2000-01-01 00:00:00', '2000-01-01 00:00:00', '2000-01-01 00:00:00')", [str_repeat('e', 64)]);
        return [$dialect, $path];
    }

    /** @param callable(SqlPaymentRepository, int): string $work @return list<string> per-worker outcome tokens */
    private function race(string $dialect, ?string $path, callable $work): array
    {
        $children = [];
        for ($i = 0; $i < self::WORKERS; $i++) {
            $pipe = tmpfile();
            if ($pipe === false) {
                self::fail('cannot open a pipe');
            }
            $pid = pcntl_fork();
            if ($pid === -1) {
                self::fail('fork failed');
            }
            if ($pid === 0) {
                // Child: its own connection, its own repository; write one token and exit without running PHPUnit teardown.
                try {
                    $repo = new SqlPaymentRepository(self::connect($dialect, $path), static fn (): int => 1_100);
                    $token = $work($repo, $i);
                } catch (ConflictError $e) {
                    $token = 'conflict:' . $e->getMessage();
                } catch (\Throwable $e) {
                    $token = 'error:' . $e::class . ':' . $e->getMessage();
                }
                fwrite($pipe, $token);
                fflush($pipe);
                posix_kill(posix_getpid(), SIGKILL);
            }
            $children[] = [$pid, $pipe];
        }
        $tokens = [];
        foreach ($children as [$pid, $pipe]) {
            pcntl_waitpid($pid, $status);
            rewind($pipe);
            $tokens[] = (string) stream_get_contents($pipe);
            fclose($pipe);
        }
        return $tokens;
    }

    #[DataProvider('forkDialects')]
    public function testARetryStormForOneHashCommitsExactlyOneRow(string $dialect): void
    {
        [$dialect, $path] = $this->prepare($dialect);
        $hash = self::hash('storm');
        $tokens = $this->race($dialect, $path, static function (SqlPaymentRepository $repo) use ($hash): string {
            $row = $repo->commitAttempt('order-storm', $hash, self::checkout('order-storm', $hash), null, '10.0.0.1');
            return 'ok:' . $row->paymentHash;
        });
        self::assertSame(array_fill(0, self::WORKERS, "ok:{$hash}"), $tokens, implode(' | ', $tokens));
        $db = self::connect($dialect, $path);
        self::assertSame(1, self::countRows($db, "SELECT COUNT(*) AS n FROM openreceive_payments WHERE reference = 'order-storm'"));
    }

    #[DataProvider('forkDialects')]
    public function testConcurrentDistinctAttemptsOnOneRailLeaveExactlyOneLive(string $dialect): void
    {
        [$dialect, $path] = $this->prepare($dialect);
        $tokens = $this->race($dialect, $path, static function (SqlPaymentRepository $repo, int $worker): string {
            $hash = self::hash("race-{$worker}");
            $repo->commitAttempt('order-race', $hash, self::checkout('order-race', $hash));
            return 'ok';
        });
        $wins = count(array_filter($tokens, static fn (string $token): bool => $token === 'ok'));
        $conflicts = count(array_filter($tokens, static fn (string $token): bool => $token === 'conflict:An unpaid checkout for this payment method is already in progress for this reference.'));
        self::assertSame(1, $wins, implode(' | ', $tokens));
        self::assertSame(self::WORKERS - 1, $conflicts, implode(' | ', $tokens));
        $db = self::connect($dialect, $path);
        self::assertSame(1, self::countRows($db, "SELECT COUNT(*) AS n FROM openreceive_payments WHERE reference = 'order-race'"));
    }
}
