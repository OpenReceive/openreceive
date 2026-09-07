<?php

declare(strict_types=1);

namespace OpenReceive\Laravel\Tests\Fixtures;

use OpenReceive\Nwc\ReceiveNwcClient;
use OpenReceive\Testing\FakeWallet;

/** A wallet whose info event advertises `pay_invoice`: the preflight must refuse it. */
final class SpendCapableWallet implements ReceiveNwcClient
{
    private readonly FakeWallet $inner;

    public function __construct()
    {
        $this->inner = new FakeWallet();
    }

    public function preflight(): array
    {
        $info = $this->inner->preflight();
        $info['methods'] = [...$info['methods'], 'pay_invoice'];
        return $info;
    }

    public function makeInvoice(array $request): array
    {
        return $this->inner->makeInvoice($request);
    }

    public function listTransactions(array $request): array
    {
        return $this->inner->listTransactions($request);
    }

    public function subscribeNotifications(callable $handler, ?callable $onIdle = null): void
    {
        $this->inner->subscribeNotifications($handler, $onIdle);
    }
}
