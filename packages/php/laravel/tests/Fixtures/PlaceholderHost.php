<?php

declare(strict_types=1);

namespace OpenReceive\Laravel\Tests\Fixtures;

use OpenReceive\Host;
use OpenReceive\Hosts\AllowAllAuthorize;
use OpenReceive\Hosts\LoggingOnPaid;

/** The scaffold as `openreceive:install` leaves it: both placeholders still wired. */
final class PlaceholderHost implements Host
{
    use AllowAllAuthorize;
    use LoggingOnPaid;

    public function amountFor(string $reference): ?array
    {
        return ['sats' => 2100];
    }

    protected function openReceiveLog(string $line): void
    {
        // Silent in tests.
    }
}
