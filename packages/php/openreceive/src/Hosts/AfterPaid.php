<?php

declare(strict_types=1);

namespace OpenReceive\Hosts;

use OpenReceive\PaymentSettlement;

/** Optional: runs after the settlement transaction COMMITTED, best-effort (a throw is logged, never retried). */
interface AfterPaid
{
    public function afterPaid(PaymentSettlement $settlement): void;
}
