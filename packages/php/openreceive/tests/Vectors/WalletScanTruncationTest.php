<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Vectors;

use OpenReceive\Payments\WalletScan;
use OpenReceive\Tests\VectorSupport;
use PHPUnit\Framework\TestCase;

/**
 * Both the core walk and the service's reconcile_payments run these cases;
 * this file covers the walk (rows + truncated flag), ServiceReconcileTest
 * covers the pass results the vector actually spells out.
 */
final class WalletScanTruncationTest extends TestCase
{
    use VectorSupport;

    /** @return array<string, mixed> */
    public static function fillerRow(int $page, int $index): array
    {
        return [
            'type' => 'incoming',
            'payment_hash' => str_repeat('f', 56) . sprintf('%08d', $page * 10_000 + $index),
            'amount_msats' => 1000,
            'transaction_state' => 'settled',
            'created_at' => 1000,
            'settled_at' => 1100,
        ];
    }

    /** @param list<array<string, mixed>>|null $specs @return list<list<array<string, mixed>>> */
    public static function buildPages(?array $specs): array
    {
        $pages = [];
        foreach ($specs ?? [] as $page => $spec) {
            $rows = $spec['rows'] ?? [];
            for ($index = 0; $index < ($spec['filler_rows'] ?? 0); $index++) {
                $rows[] = self::fillerRow($page, $index);
            }
            $pages[] = $rows;
        }
        return $pages;
    }

    /** @param array<string, mixed> $walletSpec @return callable(array<string, mixed>): array<string, mixed> */
    public static function walletFor(array $walletSpec): callable
    {
        $pages = self::buildPages($walletSpec['pages']);
        $unpaidPages = isset($walletSpec['unpaid_pages']) ? self::buildPages($walletSpec['unpaid_pages']) : $pages;
        $pageLimit = self::vector('wallet-scan-truncation')['page_limit'];
        return static function (array $request) use ($pages, $unpaidPages, $walletSpec, $pageLimit): array {
            $source = ($request['unpaid'] ?? false) === true ? $unpaidPages : $pages;
            $index = ($walletSpec['ignores_offset'] ?? false) ? 0 : intdiv((int) ($request['offset'] ?? 0), $pageLimit);
            return ['transactions' => $source[$index] ?? []];
        };
    }

    public function testATruncatedWalkNeverProvesAHashAbsent(): void
    {
        $family = self::vector('wallet-scan-truncation');
        self::assertSame(\OpenReceive\Kernel::TRANSACTION_PAGE_LIMIT, $family['page_limit']);
        foreach ($family['cases'] as $case) {
            $expected = array_column($case['attempts'], 'payment_hash');
            $scan = WalletScan::listIncomingTransactions(
                self::walletFor($case['wallet']),
                $expected,
                null,
                null,
                $case['max_pages'] ?? null,
            );
            foreach ($case['expected']['results'] as $row) {
                if ($row['status'] === 'settled') {
                    self::assertArrayHasKey($row['payment_hash'], $scan['rows'], $case['name']);
                }
            }
            // Every omitted hash sits behind a truncated walk; a complete walk omits nothing.
            if ($case['expected']['omitted'] !== []) {
                self::assertTrue($scan['truncated'] || $case['wallet']['unpaid_pages'] !== null, $case['name']);
            }
        }
    }
}
