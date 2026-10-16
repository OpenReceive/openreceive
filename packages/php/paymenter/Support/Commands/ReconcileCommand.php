<?php

declare(strict_types=1);

namespace Paymenter\Extensions\Gateways\OpenReceive\Support\Commands;

use Illuminate\Console\Command;
use Paymenter\Extensions\Gateways\OpenReceive\Support\Runtime;

/**
 * `php artisan openreceive:reconcile` — one gated pass over the open payment
 * attempts. Paymenter's scheduler runs it every minute, so a payment whose
 * buyer closed the page still marks its invoice paid.
 */
final class ReconcileCommand extends Command
{
    public const NAME = 'openreceive:reconcile';

    protected $signature = self::NAME;

    protected $description = 'Record OpenReceive payments that settled while no buyer was watching';

    public function handle(): int
    {
        try {
            Runtime::reconcile();
        } catch (\Throwable $error) {
            $this->error('Reconcile failed: ' . Runtime::errorMessage($error));
            return self::FAILURE;
        }
        return self::SUCCESS;
    }
}
