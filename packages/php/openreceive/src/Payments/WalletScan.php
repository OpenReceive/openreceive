<?php

declare(strict_types=1);

namespace OpenReceive\Payments;

use OpenReceive\Kernel;
use OpenReceive\Nwc\Requests;
use OpenReceive\Support\Integers;

/**
 * The paged, deduped, truncation-safe wallet-history walk (the JS core
 * listIncomingTransactions): pages list_transactions until every expected
 * hash is seen, the wallet runs out of rows, or the page cap is reached. A
 * walk that ended before the wallet ran out of rows is TRUNCATED — a hash such
 * a walk did not see is unproven, never proven absent.
 */
final class WalletScan
{
    public const DEFAULT_MAX_PAGES = 10_000;

    /**
     * `$listTransactions` receives an OpenReceive request array and returns
     * the raw NIP-47 reply or an already-normalized response; both work.
     *
     * @param callable(array<string, mixed>): mixed $listTransactions
     * @param list<string> $expected
     * @return array{rows: array<string, array<string, mixed>>, truncated: bool}
     */
    public static function listIncomingTransactions(
        callable $listTransactions,
        array $expected,
        ?int $from = null,
        ?int $until = null,
        ?int $maxPages = null,
        bool $includeUnpaid = false,
    ): array {
        $pages = self::normalizeMaxPages($maxPages);
        $outstanding = array_map([self::class, 'normalizePaymentHash'], $expected);
        $scanFrom = $from === null ? null : self::normalizeUnix($from, 'from');
        $scanUntil = $until === null ? null : self::normalizeUnix($until, 'until');
        $rows = [];
        $offset = 0;
        $previousPage = null;
        // Proven false the moment the wallet runs out of rows or every
        // expected hash is accounted for; otherwise the walk hit its cap with
        // rows still to come.
        $truncated = true;
        for ($i = 0; $i < $pages; $i++) {
            $request = ['type' => 'incoming', 'limit' => Kernel::TRANSACTION_PAGE_LIMIT, 'offset' => $offset];
            if ($includeUnpaid) {
                $request['unpaid'] = true;
            }
            if ($scanFrom !== null) {
                $request['from'] = $scanFrom;
            }
            if ($scanUntil !== null) {
                $request['until'] = $scanUntil;
            }
            $page = Requests::normalizeListTransactionsResponse($listTransactions($request))['transactions'];
            foreach ($page as $row) {
                if (($row['type'] ?? null) !== null && $row['type'] !== 'incoming') {
                    continue;
                }
                $hash = self::rowPaymentHash($row);
                if ($hash === null) {
                    continue;
                }
                $rows[$hash] = $row;
                $outstanding = array_values(array_filter($outstanding, static fn (string $item): bool => $item !== $hash));
            }
            if ($outstanding === [] || count($page) < Kernel::TRANSACTION_PAGE_LIMIT) {
                $truncated = false;
                break;
            }
            // A wallet that ignores `offset` serves the same page forever; stop
            // instead of paging to the cap, and keep the scan marked incomplete.
            $pageKey = implode(',', array_map(static fn (array $row): string => (string) ($row['payment_hash'] ?? ''), $page));
            if ($pageKey === $previousPage) {
                break;
            }
            $previousPage = $pageKey;
            $offset += Kernel::TRANSACTION_PAGE_LIMIT;
        }
        return ['rows' => $rows, 'truncated' => $truncated];
    }

    public static function normalizeMaxPages(?int $value): int
    {
        if ($value === null) {
            return self::DEFAULT_MAX_PAGES;
        }
        if ($value <= 0) {
            throw new \InvalidArgumentException('max_pages must be a positive integer');
        }
        return $value;
    }

    public static function normalizePaymentHash(mixed $value): string
    {
        $normalized = strtolower(trim(is_scalar($value) ? (string) $value : ''));
        if (preg_match(Kernel::LOWER_HEX_64_PATTERN, $normalized) !== 1) {
            throw new \InvalidArgumentException('payment_hash must be 64 hexadecimal characters');
        }
        return $normalized;
    }

    /**
     * The scan key for one wallet row, or null when the row can never match
     * an attempt — a wallet-supplied row with a missing or malformed hash is
     * skipped rather than rejected, so one quirky row cannot livelock
     * reconciliation.
     *
     * @param array<string, mixed> $row
     */
    public static function rowPaymentHash(array $row): ?string
    {
        $hash = strtolower(trim((string) ($row['payment_hash'] ?? '')));
        return preg_match(Kernel::LOWER_HEX_64_PATTERN, $hash) === 1 ? $hash : null;
    }

    private static function normalizeUnix(int $value, string $field): int
    {
        if ($value < 0) {
            throw new \InvalidArgumentException("{$field} must be a non-negative integer");
        }
        return Integers::parse($value, $field);
    }
}
