<?php

declare(strict_types=1);

namespace ButtonShop;

use Psr\Log\AbstractLogger;

/**
 * The host's console logger: one line per event on stderr, which is where
 * `php -S` prints error_log. Same job as the Node demos' console logger; it
 * carries the engine's INFO/WARN lines and this shop's own `on_paid` line.
 */
final class StderrLogger extends AbstractLogger
{
    public function __construct(private readonly string $prefix = 'buttons:php-plain')
    {
    }

    public function log($level, \Stringable|string $message, array $context = []): void
    {
        $line = "[{$this->prefix}] {$level} {$message}";
        if ($context !== []) {
            $line .= ' ' . json_encode($context, JSON_UNESCAPED_SLASHES);
        }
        error_log($line);
    }
}
