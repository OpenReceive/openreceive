<?php

declare(strict_types=1);

namespace OpenReceive;

use OpenReceive\Generated\Tables;

/**
 * Kernel constants shared with the JS, Ruby and C# engines. The numbers come
 * from spec/data/kernel-tables.json through the generated Tables class; this
 * class only names them the way the rest of the engine reads them.
 */
final class Kernel
{
    public const NWC_CODE_HELP_URL = 'https://openreceive.org/get_a_nwc_code_to_receive_payments';
    public const HEX_64_PATTERN = '/\A[0-9a-fA-F]{64}\z/';
    public const LOWER_HEX_64_PATTERN = '/\A[0-9a-f]{64}\z/';
    public const NWC_METADATA_MAX_BYTES = Tables::NWC_METADATA_MAX_BYTES;
    public const MIN_AMOUNT_MSATS = Tables::MIN_AMOUNT_MSATS;
    public const MAX_AMOUNT_MSATS = Tables::MAX_AMOUNT_MSATS;
    /** The page size every wallet-history walk requests. */
    public const TRANSACTION_PAGE_LIMIT = Tables::TRANSACTION_PAGE_LIMIT;

    /** msats are 64-bit ints everywhere in this engine; a 32-bit PHP cannot hold the wire ceiling. */
    public static function assertRuntime(): void
    {
        if (PHP_INT_SIZE < 8) {
            throw new \RuntimeException('OpenReceive requires a 64-bit PHP build: amount_msats values exceed 32-bit integers.');
        }
    }
}
