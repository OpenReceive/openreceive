<?php

/**
 * @package     pkg_openreceive
 * @copyright   (C) 2026 OpenReceive
 * @license     GPL-2.0-or-later; see LICENSE
 */

declare(strict_types=1);

namespace OpenReceiveHikaShop;

\defined('_JEXEC') or die;

/**
 * Whether the cron line runs. Joomla and HikaShop run nothing on their own
 * between page views, so without it a customer who pays and leaves the page
 * gets their order only when the next checkout request runs a pass, which
 * on a quiet shop can be hours later. `openreceive:reconcile` records each
 * pass it finishes; the payment method's settings page and `doctor` read
 * that time. Pure, so it is tested without a shop.
 */
final class CronStatus
{
    /** Three missed runs of the five-minute cron line. */
    public const STALE_SECONDS = 900;

    /** The line the quickstart gives, with this site's Joomla console. */
    public static function cronLine(string $console): string
    {
        return '*/5 * * * * php ' . $console . ' openreceive:reconcile';
    }

    /**
     * The settings page's warning, or null while the cron line runs.
     *
     * @param int $lastRun Unix seconds of the last finished pass; 0 for never
     */
    public static function warning(int $lastRun, int $now, string $console): ?string
    {
        if ($lastRun > 0 && $now - $lastRun < self::STALE_SECONDS) {
            return null;
        }
        $since = $lastRun > 0
            ? 'The cron line last ran ' . gmdate('Y-m-d H:i', $lastRun) . ' UTC.'
            : 'The cron line has not run yet.';
        return $since . ' Until it runs every five minutes, a customer who pays and leaves the page'
            . ' gets their order only when the next checkout runs. Add it as the web server\'s user: '
            . self::cronLine($console);
    }

    /** One line for `doctor`. */
    public static function describe(int $lastRun, int $now): string
    {
        if ($lastRun <= 0) {
            return 'never, so add the cron line';
        }
        $line = gmdate('Y-m-d H:i', $lastRun) . ' UTC';
        return $now - $lastRun < self::STALE_SECONDS ? $line : $line . ', over 15 minutes ago, so check the cron line';
    }
}
