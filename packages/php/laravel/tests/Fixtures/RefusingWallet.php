<?php

declare(strict_types=1);

namespace OpenReceive\Laravel\Tests\Fixtures;

use OpenReceive\Nwc\NwcRequestError;
use OpenReceive\Nwc\ReceiveNwcClient;
use OpenReceive\Testing\FakeWallet;

/** A wallet that publishes its methods for anyone but refuses every signed request. */
final class RefusingWallet implements ReceiveNwcClient
{
    private readonly FakeWallet $inner;

    public function __construct()
    {
        $this->inner = new FakeWallet();
    }

    public function preflight(): array
    {
        return $this->inner->preflight();
    }

    public function makeInvoice(array $request): array
    {
        return $this->inner->makeInvoice($request);
    }

    public function listTransactions(array $request): array
    {
        throw new NwcRequestError('UNAUTHORIZED', 'this public key has no wallet connected');
    }

    public function subscribeNotifications(callable $handler, ?callable $onIdle = null): void
    {
        $this->inner->subscribeNotifications($handler, $onIdle);
    }
}
