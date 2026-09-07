<?php

declare(strict_types=1);

namespace OpenReceive\Hosts;

use OpenReceive\Server\AuthorizeContext;

/**
 * The scaffolded host's placeholder `authorize`: allows every request,
 * treating possession of the reference as the authorization. Named so the
 * engine says out loud at boot that anyone holding an order id can mint
 * invoices, poll status and request refunds for it.
 */
trait AllowAllAuthorize
{
    public function authorize(AuthorizeContext $context): bool
    {
        return true;
    }
}
