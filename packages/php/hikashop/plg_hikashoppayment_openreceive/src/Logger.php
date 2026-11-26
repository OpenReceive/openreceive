<?php

/**
 * @package     pkg_openreceive
 * @copyright   (C) 2026 OpenReceive
 * @license     GPL-2.0-or-later; see LICENSE
 */

declare(strict_types=1);

namespace OpenReceiveHikaShop;

use Joomla\CMS\Log\Log;
use Psr\Log\AbstractLogger;
use Psr\Log\LogLevel;

\defined('_JEXEC') or die;

/**
 * The engine's log lines, in Joomla's and HikaShop's own logs. The engine
 * never logs a code. Every line goes to Joomla's log folder
 * (administrator/logs/openreceive.php); warnings and errors also go to
 * HikaShop's log in its back office (System > Logs), where routine lines (a
 * reconcile pass every few seconds while a checkout is open) would only be
 * noise.
 */
final class Logger extends AbstractLogger
{
    private const ROUTINE = [LogLevel::DEBUG, LogLevel::INFO, LogLevel::NOTICE];

    private const PRIORITY = [
        LogLevel::DEBUG => Log::DEBUG,
        LogLevel::INFO => Log::INFO,
        LogLevel::NOTICE => Log::NOTICE,
        LogLevel::WARNING => Log::WARNING,
        LogLevel::ERROR => Log::ERROR,
        LogLevel::CRITICAL => Log::CRITICAL,
        LogLevel::ALERT => Log::ALERT,
        LogLevel::EMERGENCY => Log::EMERGENCY,
    ];

    private static bool $registered = false;

    public function log($level, string|\Stringable $message, array $context = []): void
    {
        $line = 'OpenReceive: ' . $message;
        if ($context !== []) {
            $line .= ' ' . json_encode($context, JSON_UNESCAPED_SLASHES | JSON_PARTIAL_OUTPUT_ON_ERROR);
        }
        $level = (string) $level;
        try {
            if (!self::$registered) {
                Log::addLogger(['text_file' => 'openreceive.php'], Log::ALL, ['openreceive']);
                self::$registered = true;
            }
            Log::add($line, self::PRIORITY[$level] ?? Log::ERROR, 'openreceive');
        } catch (\Throwable) {
            // An unwritable log folder must not break a payment.
        }
        if (!in_array($level, self::ROUTINE, true) && function_exists('hikashop_writeToLog')) {
            hikashop_writeToLog($line, Runtime::PLUGIN, ['type' => 'payment']);
        }
    }
}
