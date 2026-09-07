<?php

declare(strict_types=1);

namespace OpenReceive\Laravel\Console;

use Illuminate\Console\Command;
use OpenReceive\Laravel\OpenReceiveServiceProvider;
use OpenReceive\Server\Engine;
use OpenReceive\Server\Notifications;

/**
 * `php artisan openreceive:notifications` — the OPTIONAL long-lived worker:
 * NWC-02 `payment_received` listener plus a periodic reconcile pass every
 * OPENRECEIVE_NOTIFICATIONS_RECONCILE_INTERVAL_SECONDS (default 15), with the
 * shared resubscribe backoff when the relay drops. One per deployment, not per
 * web instance; the web processes never start a timer.
 */
final class NotificationsCommand extends Command
{
    protected $signature = 'openreceive:notifications {--iterations= : Stop after this many subscription attempts (tests); unlimited by default}';

    protected $description = 'Optional worker: listen for NWC-02 payment notifications and reconcile periodically (long-running)';

    public function handle(Engine $engine): int
    {
        $env = OpenReceiveServiceProvider::engineEnvironment((array) $this->laravel->make('config')->get('openreceive'));
        $interval = Notifications::intervalFromEnvironment($env);
        $this->line("openreceive:notifications listening for NWC-02 payment_received and reconciling every {$interval}s. "
            . 'Notifications are authenticated wallet data; the periodic pass covers notifications missed while this worker was down.');

        $worker = $engine->notificationsWorker($env);
        $limit = $this->option('iterations');
        $remaining = is_numeric($limit) ? (int) $limit : null;
        if (function_exists('pcntl_async_signals')) {
            pcntl_async_signals(true);
            foreach ([SIGINT, SIGTERM] as $signal) {
                pcntl_signal($signal, static function () use ($worker): void {
                    $worker->stop();
                });
            }
        }
        $worker->run($remaining === null ? null : static function () use (&$remaining): bool {
            return $remaining-- > 0;
        });
        return self::SUCCESS;
    }
}
