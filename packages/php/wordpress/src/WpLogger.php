<?php
declare(strict_types=1);
namespace OpenReceive\WP;
defined('ABSPATH') || exit;

use Psr\Log\AbstractLogger;
use Psr\Log\LogLevel;

/**
 * The engine's warnings and errors, in the store's own log: WooCommerce →
 * Status → Logs, else Easy Digital Downloads' debug log. Routine lines (a
 * reconcile pass while a checkout is open) are dropped. The engine never
 * logs a code.
 */
final class WpLogger extends AbstractLogger
{
    private const ROUTINE = [LogLevel::DEBUG, LogLevel::INFO, LogLevel::NOTICE];

    public function log($level, string|\Stringable $message, array $context = []): void
    {
        if (in_array((string) $level, self::ROUTINE, true)) { return; }
        Plugin::logError((string) $message . ($context === [] ? '' : ' ' . wp_json_encode($context)));
    }
}
