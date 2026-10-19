<?php

declare(strict_types=1);

namespace PrestaShop\Module\OpenReceive;

/** What the engine needs from PHP: 64 bits, 8.2 or later, GMP and sodium. */
final class Requirements
{
    /** @return list<string> */
    public static function missing(): array
    {
        return array_keys(array_filter([
            '64-bit PHP' => PHP_INT_SIZE < 8,
            'PHP 8.2 or later' => PHP_VERSION_ID < 80200,
            'the gmp extension' => !extension_loaded('gmp'),
            'the sodium extension' => !extension_loaded('sodium'),
        ]));
    }
}
