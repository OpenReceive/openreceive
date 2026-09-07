<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Vectors;

use OpenReceive\Nwc\Requests;
use OpenReceive\Tests\VectorSupport;
use PHPUnit\Framework\TestCase;

final class NwcRequestResponseTest extends TestCase
{
    use VectorSupport;

    public function testRequestMappingAndResponseNormalizationMatchTheSharedVectors(): void
    {
        foreach (self::vector('nwc-request-response')['cases'] as $case) {
            if ($case['method'] === 'make_invoice') {
                self::assertSameRecord($case['expected_nip47_request'], Requests::makeInvoiceRequest($case['openreceive_request']), $case['name']);
                if (isset($case['expected_openreceive_response'])) {
                    $actual = Requests::normalizeMakeInvoiceResponse($case['raw_response']);
                    foreach ($case['expected_openreceive_response'] as $key => $value) {
                        self::assertSame($value, $actual[$key] ?? null, "{$case['name']} response {$key}");
                    }
                }
                continue;
            }
            self::assertSameRecord($case['expected_nip47_request'], Requests::listTransactionsRequest($case['openreceive_request']), $case['name']);
            if (isset($case['expected_openreceive_response'])) {
                $actual = Requests::normalizeListTransactionsResponse($case['raw_response']);
                $expected = $case['expected_openreceive_response'];
                self::assertCount(count($expected['transactions']), $actual['transactions'], "{$case['name']} row count");
                foreach ($expected['transactions'] as $index => $row) {
                    foreach ($row as $key => $value) {
                        self::assertSame($value, $actual['transactions'][$index][$key] ?? null, "{$case['name']} row {$index} {$key}");
                    }
                }
            }
        }
    }

    public function testAnUnrecognizedNonEmptyReplyFailsTheScanInsteadOfLookingEmpty(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        Requests::normalizeListTransactionsResponse(['result' => ['items' => [['payment_hash' => 'x']]]]);
    }

    public function testAllRowsUnusableFailsTheScan(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        Requests::normalizeListTransactionsResponse(['transactions' => [['payment_hash' => 'not-hex']]]);
    }

    public function testOneQuirkyRowIsSkippedAndCounted(): void
    {
        $result = Requests::normalizeListTransactionsResponse(['transactions' => [
            ['payment_hash' => 'not-hex'],
            ['payment_hash' => str_repeat('a', 64), 'amount' => 1000, 'state' => 'settled'],
        ]]);
        self::assertCount(1, $result['transactions']);
        self::assertSame(1, $result['skipped_rows']);
    }

    public function testBigIntAmountsDecodedAsStringsCoerceToInts(): void
    {
        $raw = json_decode('{"invoice":"lnbc1","payment_hash":"' . str_repeat('b', 64) . '","amount":9007199254740991}', true, 512, JSON_BIGINT_AS_STRING);
        self::assertSame(9007199254740991, Requests::normalizeMakeInvoiceResponse($raw)['amount_msats']);
    }
}
