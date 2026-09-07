<?php

declare(strict_types=1);

namespace OpenReceive\Hosts;

use OpenReceive\PaymentSettlement;

/**
 * The scaffolded host's placeholder `onPaid`: logs the settlement and
 * fulfills nothing. Kept as a named trait so the engine can detect it at boot
 * and warn while a host still ships it — orders recorded as settled without
 * ever being fulfilled must not pass silently. Override `openReceiveLog` to
 * route the line into the framework logger.
 */
trait LoggingOnPaid
{
    public function onPaid(PaymentSettlement $settlement): void
    {
        $this->openReceiveLog("[openreceive] order {$settlement->reference} paid (payment_hash {$settlement->paymentHash})");
    }

    protected function openReceiveLog(string $line): void
    {
        error_log($line);
    }
}
