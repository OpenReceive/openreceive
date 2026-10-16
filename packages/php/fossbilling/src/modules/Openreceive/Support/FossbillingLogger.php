<?php

declare(strict_types=1);

namespace Box\Mod\Openreceive\Support;

use Psr\Log\AbstractLogger;
use Psr\Log\LogLevel;

/**
 * The engine's log lines, in FOSSBilling's own logs. The engine never logs a
 * code. Routine lines (a reconcile pass every few seconds while a checkout is
 * open) go to the billing channel's file, which FOSSBilling keeps out of the
 * admin area's activity log; warnings and errors go to the application
 * channel, which shows there.
 */
final class FossbillingLogger extends AbstractLogger
{
    private const ROUTINE = [LogLevel::DEBUG, LogLevel::INFO, LogLevel::NOTICE];

    public function __construct(private readonly object $writer)
    {
    }

    public function log($level, string|\Stringable $message, array $context = []): void
    {
        $line = 'OpenReceive: ' . $message;
        if ($context !== []) {
            $line .= ' ' . json_encode($context, JSON_UNESCAPED_SLASHES | JSON_PARTIAL_OUTPUT_ON_ERROR);
        }
        // FOSSBilling's logger keeps the last channel set; every caller sets its own.
        $this->writer->setChannel(in_array((string) $level, self::ROUTINE, true) ? 'billing' : 'application');
        // One argument: FOSSBilling's logger formats with vsprintf only when given more.
        $this->writer->{(string) $level}($line);
    }
}
