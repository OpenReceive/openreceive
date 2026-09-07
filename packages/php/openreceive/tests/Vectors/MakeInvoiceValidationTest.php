<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Vectors;

use OpenReceive\Nwc\Requests;
use OpenReceive\Tests\VectorSupport;
use PHPUnit\Framework\TestCase;

final class MakeInvoiceValidationTest extends TestCase
{
    use VectorSupport;

    public function testRequestValidationMatchesTheSharedVectors(): void
    {
        foreach (self::vector('make-invoice-validation')['cases'] as $case) {
            $request = $case['request'];
            // The vector encodes oversized metadata by note length instead of inlining kilobytes of JSON.
            if (isset($request['metadata_note_length'])) {
                $request['metadata'] = ['note' => str_repeat('x', $request['metadata_note_length'])];
                unset($request['metadata_note_length']);
            }
            try {
                Requests::makeInvoiceRequest($request);
                $valid = true;
            } catch (\InvalidArgumentException) {
                $valid = false;
            }
            self::assertSame($case['expected']['valid'], $valid, $case['name']);
        }
    }
}
