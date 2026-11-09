<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Nwc;

use GuzzleHttp\Psr7\Utils;
use OpenReceive\Nwc\Transport\WholeFrameStream;
use PHPUnit\Framework\TestCase;
use RuntimeException;
use Valtzu\WebSocketMiddleware\WebSocketStream;

final class WholeFrameStreamTest extends TestCase
{
    /** @var resource The relay's end of the socket. */
    private $relay;

    /** A server's unmasked text frame, with the length encoding its size calls for. */
    private static function frame(string $payload): string
    {
        $first = chr(0x81);
        $length = strlen($payload);
        return $first . match (true) {
            $length < 126 => chr($length),
            $length < 65536 => chr(126) . pack('n', $length),
            default => chr(127) . pack('J', $length),
        } . $payload;
    }

    /** The real reader on a real socket, in the Guzzle stream the HTTP layer hands over. */
    private function reader(): WebSocketStream
    {
        $pair = stream_socket_pair(STREAM_PF_UNIX, STREAM_SOCK_STREAM, STREAM_IPPROTO_IP);
        self::assertNotFalse($pair);
        [$this->relay, $client] = $pair;
        $body = Utils::streamFor($client);
        $frames = new WholeFrameStream($body);
        self::assertNull($body->detach(), 'the socket now belongs to the frame stream');
        self::assertFalse(stream_get_meta_data($client)['blocked'], 'a read must never wait on the relay');
        return new WebSocketStream($frames, ['synchronous' => false]);
    }

    private function arrive(string $bytes): void
    {
        fwrite($this->relay, $bytes);
    }

    public function testAReplyAcrossSeveralTlsRecordsArrivesWhole(): void
    {
        $reply = str_repeat('x', 40_000);
        $frame = self::frame($reply);
        $reader = $this->reader();
        $this->arrive(substr($frame, 0, 16_384));
        self::assertSame('', $reader->read(65536), 'nothing until the message is complete');
        $this->arrive(substr($frame, 16_384, 16_384));
        self::assertSame('', $reader->read(65536));
        $this->arrive(substr($frame, 32_768));
        self::assertSame($reply, $reader->read(65536));
    }

    public function testAHeaderSplitAcrossReadsIsNotMistakenForAnIdleSocket(): void
    {
        $reply = str_repeat('y', 300);
        $frame = self::frame($reply);
        $reader = $this->reader();
        $this->arrive(substr($frame, 0, 1));
        self::assertSame('', $reader->read(65536));
        $this->arrive(substr($frame, 1, 2));
        self::assertSame('', $reader->read(65536));
        $this->arrive(substr($frame, 3));
        self::assertSame($reply, $reader->read(65536));
    }

    public function testTwoMessagesInOneReadBothArrive(): void
    {
        $reader = $this->reader();
        $this->arrive(self::frame('first') . self::frame('second'));
        self::assertSame('first', $reader->read(65536));
        self::assertSame('second', $reader->read(65536));
        self::assertSame('', $reader->read(65536));
    }

    public function testNothingArrivedIsAnIdleSocket(): void
    {
        self::assertSame('', $this->reader()->read(65536));
    }

    public function testARequestReachesTheRelay(): void
    {
        $reader = $this->reader();
        self::assertTrue($reader->isWritable());
        $reader->write('hello');
        stream_set_blocking($this->relay, false);
        $frame = (string) fread($this->relay, 64);
        self::assertSame(0x81, ord($frame[0]));
        self::assertSame(0x80 | 5, ord($frame[1]));
        $mask = substr($frame, 2, 4);
        self::assertSame('hello', substr($frame, 6) ^ str_repeat($mask, 2));
    }

    public function testALostRelayIsAnErrorAndNeverAPrintedWarning(): void
    {
        $reader = $this->reader();
        fclose($this->relay);
        $printed = [];
        $reporting = error_reporting(E_ALL);
        set_error_handler(static function (int $level, string $message) use (&$printed): bool {
            if ((error_reporting() & $level) !== 0) {
                $printed[] = $message;
            }
            return true;
        });
        try {
            $reader->write('hello');
            self::fail('a write to a closed relay must throw');
        } catch (RuntimeException $error) {
            self::assertSame('Unable to write to the relay socket.', $error->getMessage());
        } finally {
            restore_error_handler();
            error_reporting($reporting);
        }
        self::assertSame([], $printed, 'display_errors would print this into the response');
    }

    public function testABodyWithNoSocketIsRefused(): void
    {
        $body = Utils::streamFor('');
        $body->detach();
        $this->expectException(RuntimeException::class);
        new WholeFrameStream($body);
    }
}
