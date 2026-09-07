<?php

declare(strict_types=1);

namespace OpenReceive\Laravel\Console;

use Illuminate\Console\Command;
use OpenReceive\Server\Engine;

/** `php artisan openreceive:reconcile` — one reconciliation pass over pending attempts (the Rails rake task's twin). */
final class ReconcileCommand extends Command
{
    protected $signature = 'openreceive:reconcile';

    protected $description = 'Run one OpenReceive reconciliation pass over pending payment attempts';

    public function handle(Engine $engine): int
    {
        $checks = $engine->reconcile();
        $this->line('openreceive:reconcile checked ' . count($checks) . ' pending attempt(s)');
        return self::SUCCESS;
    }
}
