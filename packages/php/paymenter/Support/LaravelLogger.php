<?php

declare(strict_types=1);

namespace Paymenter\Extensions\Gateways\OpenReceive\Support;

use Illuminate\Support\Facades\Log;
use Psr\Log\AbstractLogger;

/** The engine's log lines, in Paymenter's own log. The engine never logs a code. */
final class LaravelLogger extends AbstractLogger
{
    public function log($level, string|\Stringable $message, array $context = []): void
    {
        Log::log((string) $level, 'OpenReceive: ' . $message, $context);
    }
}
