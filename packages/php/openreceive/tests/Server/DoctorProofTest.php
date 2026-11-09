<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Server;

use OpenReceive\Host;
use OpenReceive\Hosts\AllowAllAuthorize;
use OpenReceive\Hosts\LoggingOnPaid;
use OpenReceive\Nwc\NwcRequestError;
use OpenReceive\Nwc\ReceiveNwcClient;
use OpenReceive\Nwc\WalletUnavailableError;
use OpenReceive\Server\Doctor;
use PHPUnit\Framework\TestCase;
use RuntimeException;

/** A wallet publishes its methods for anyone, so only a signed request can show a wrong secret. */
final class DoctorProofTest extends TestCase
{
    public function testTheProofReadsOneHistoryRowAndMakesNothing(): void
    {
        $wallet = $this->createMock(ReceiveNwcClient::class);
        $wallet->expects(self::once())->method('listTransactions')->with(['limit' => 1])->willReturn(['transactions' => []]);
        $wallet->expects(self::never())->method('makeInvoice');
        Doctor::proveCodeAccepted($wallet);
    }

    public function testARefusedCodeIsNamed(): void
    {
        $wallet = $this->createStub(ReceiveNwcClient::class);
        $wallet->method('listTransactions')->willThrowException(new NwcRequestError('UNAUTHORIZED', 'this public key has no wallet connected'));
        $this->expectExceptionMessage('the wallet refused this code (UNAUTHORIZED)');
        Doctor::proveCodeAccepted($wallet);
    }

    public function testASilentWalletIsNamed(): void
    {
        $wallet = $this->createStub(ReceiveNwcClient::class);
        $wallet->method('listTransactions')->willThrowException(new WalletUnavailableError('The wallet did not answer in time.'));
        $this->expectExceptionMessage('did not answer a signed request');
        Doctor::proveCodeAccepted($wallet);
    }

    public function testAnAnonymousHostIsReportedWithoutANulByte(): void
    {
        $host = new class implements Host {
            use AllowAllAuthorize;
            use LoggingOnPaid;

            public function amountFor(string $reference): ?array
            {
                return null;
            }
        };
        $report = implode("\n", Doctor::report([], $host));
        self::assertStringContainsString('host:             an anonymous class', $report);
        self::assertStringNotContainsString("\0", $report);
    }

    public function testAnyOtherFailureIsLeftAlone(): void
    {
        $wallet = $this->createStub(ReceiveNwcClient::class);
        $wallet->method('listTransactions')->willThrowException(new RuntimeException('something else'));
        $this->expectExceptionMessage('something else');
        Doctor::proveCodeAccepted($wallet);
    }
}
