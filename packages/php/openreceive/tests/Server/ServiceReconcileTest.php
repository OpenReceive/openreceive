<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Server;

use OpenReceive\Nwc\ReceiveNwcClient;
use OpenReceive\Server\Service;
use OpenReceive\Tests\VectorSupport;
use OpenReceive\Tests\Vectors\WalletScanTruncationTest;
use PHPUnit\Framework\TestCase;

/** The production reconcile pass against the wallet-scan-truncation vectors (the crosslang harness's reading). */
final class ServiceReconcileTest extends TestCase
{
    use VectorSupport;

    /** @param callable(array<string, mixed>): array<string, mixed> $list */
    private static function wallet(callable $list): ReceiveNwcClient
    {
        return new class ($list) implements ReceiveNwcClient {
            /** @var callable(array<string, mixed>): array<string, mixed> */
            private $list;

            public function __construct(callable $list)
            {
                $this->list = $list;
            }

            public function makeInvoice(array $request): array
            {
                throw new \LogicException('not minted here');
            }

            public function listTransactions(array $request): array
            {
                return ($this->list)($request);
            }

            public function preflight(): array
            {
                return ['methods' => ['make_invoice', 'list_transactions'], 'encryption' => ['nip04']];
            }

            public function subscribeNotifications(callable $handler, ?callable $onIdle = null): void
            {
            }
        };
    }

    public function testATruncatedPassOmitsUndecidedHashesInsteadOfClosingThem(): void
    {
        $family = self::vector('wallet-scan-truncation');
        foreach ($family['cases'] as $case) {
            $service = new Service(self::wallet(WalletScanTruncationTest::walletFor($case['wallet'])), false, [], ['USD'], static fn (): int => $case['clock']);
            $input = ['attempts' => $case['attempts']];
            if (isset($case['max_pages'])) {
                $input['max_pages'] = $case['max_pages'];
            }
            $results = $service->reconcilePayments($input);
            $byHash = [];
            foreach ($results as $row) {
                $byHash[$row['payment_hash']] = $row['status'];
            }
            foreach ($case['expected']['results'] as $row) {
                self::assertSame($row['status'], $byHash[$row['payment_hash']] ?? null, "{$case['name']} {$row['payment_hash']}");
            }
            foreach ($case['expected']['omitted'] as $hash) {
                self::assertArrayNotHasKey($hash, $byHash, "{$case['name']} {$hash} must be omitted");
            }
            self::assertCount(count($case['expected']['results']), $results, "{$case['name']} result count");
        }
    }

    public function testADeadlineCutWalkEndsTruncated(): void
    {
        $pages = 0;
        $wallet = self::wallet(static function () use (&$pages): array {
            $pages++;
            return ['transactions' => WalletScanTruncationTest::buildPages([['filler_rows' => 20]])[0]];
        });
        $service = new Service($wallet, false, [], ['USD'], static fn (): int => 2000);
        $results = $service->reconcilePayments([
            'attempts' => [['payment_hash' => str_repeat('2', 64), 'created_at' => 1000]],
            'deadline' => hrtime(true) / 1e9 - 1,
        ]);
        self::assertSame([], $results, 'a deadline-cut walk proves nothing');
        self::assertLessThanOrEqual(4, $pages, 'the walk replays the previous page and stops instead of paging to the cap');
    }

    public function testANegativeOverlapIsRefused(): void
    {
        $service = new Service(self::wallet(static fn (): array => ['transactions' => []]), false, []);
        $this->expectException(\InvalidArgumentException::class);
        $service->reconcilePayments(['attempts' => [['payment_hash' => str_repeat('1', 64), 'created_at' => 1]], 'overlap_seconds' => -1]);
    }
}
