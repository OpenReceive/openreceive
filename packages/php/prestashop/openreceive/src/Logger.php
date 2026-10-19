<?php

declare(strict_types=1);

namespace PrestaShop\Module\OpenReceive;

use Psr\Log\AbstractLogger;
use Psr\Log\LogLevel;

/**
 * The engine's log lines, in PrestaShop's own logs. The engine never logs a
 * code. Every line goes to var/logs/openreceive.log; warnings and errors also
 * go to PrestaShop's log in the back office (Advanced Parameters > Logs),
 * where routine lines (a reconcile pass every few seconds while a checkout is
 * open) would only be noise.
 */
final class Logger extends AbstractLogger
{
    private const ROUTINE = [LogLevel::DEBUG, LogLevel::INFO, LogLevel::NOTICE];

    /** PrestaShopLogger's severities: 1 informative, 2 warning, 3 error, 4 major. */
    private const SEVERITY = [LogLevel::WARNING => 2, LogLevel::ERROR => 3, LogLevel::CRITICAL => 4, LogLevel::ALERT => 4, LogLevel::EMERGENCY => 4];

    public function log($level, string|\Stringable $message, array $context = []): void
    {
        $line = 'OpenReceive: ' . $message;
        if ($context !== []) {
            $line .= ' ' . json_encode($context, JSON_UNESCAPED_SLASHES | JSON_PARTIAL_OUTPUT_ON_ERROR);
        }
        $level = (string) $level;
        if (defined('_PS_ROOT_DIR_')) {
            @file_put_contents(_PS_ROOT_DIR_ . '/var/logs/openreceive.log', gmdate('Y-m-d\TH:i:s\Z') . ' ' . strtoupper($level) . ' ' . $line . "\n", FILE_APPEND | LOCK_EX);
        }
        if (!in_array($level, self::ROUTINE, true) && class_exists(\PrestaShopLogger::class)) {
            \PrestaShopLogger::addLog($line, self::SEVERITY[$level] ?? 3, null, null, null, true);
        }
    }
}
