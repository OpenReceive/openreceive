<?php

declare(strict_types=1);

namespace OpenReceive\Nwc\Transport;

use GuzzleHttp\Psr7\StreamDecoratorTrait;
use GuzzleHttp\Psr7\Utils;
use Psr\Http\Message\StreamInterface;
use RuntimeException;

/**
 * Hands the websocket reader whole frames. The reader expects a frame it has
 * started to arrive at once on a non-blocking socket, and throws "Empty read;
 * connection dead?" when the rest is still on the wire. A reply spread over
 * several reads is therefore lost: a page of twenty wallet transactions is
 * enough. This buffers until the frame is complete and reports nothing
 * available until then, which the reader treats as an idle socket.
 */
final class WholeFrameStream implements StreamInterface
{
    use StreamDecoratorTrait;

    private const CHUNK_BYTES = 65536;

    private readonly StreamInterface $stream;
    /** @var resource */
    private $socket;
    private string $buffer = '';
    /** Bytes of the frame at the head of the buffer not yet handed over. */
    private int $frameLeft = 0;

    public function __construct(StreamInterface $body)
    {
        // The HTTP layer opens the socket blocking and read-only, and a
        // websocket needs neither, so this class takes the socket over.
        $socket = $body->detach();
        if ($socket === null) {
            throw new RuntimeException('The relay connection has no socket.');
        }
        stream_set_blocking($socket, false);
        $this->socket = $socket;
        $this->stream = Utils::streamFor($socket);
    }

    public function isWritable(): bool
    {
        return is_resource($this->socket);
    }

    public function write(string $string): int
    {
        // A dropped connection is reported by the false below. PHP also raises
        // a warning for it, which display_errors would print into the host's
        // response ahead of its headers, so the payer gets a broken 200.
        $written = is_resource($this->socket) ? @fwrite($this->socket, $string) : false;
        if ($written === false) {
            throw new RuntimeException('Unable to write to the relay socket.');
        }
        return $written;
    }

    public function read(int $length): string
    {
        $this->fill();
        if ($this->frameLeft === 0) {
            $size = self::frameBytes($this->buffer);
            if ($size === null || strlen($this->buffer) < $size) {
                return '';
            }
            $this->frameLeft = $size;
        }
        $served = substr($this->buffer, 0, min($length, $this->frameLeft));
        $this->buffer = substr($this->buffer, strlen($served));
        $this->frameLeft -= strlen($served);
        return $served;
    }

    private function fill(): void
    {
        do {
            $chunk = @$this->stream->read(self::CHUNK_BYTES);
            $this->buffer .= $chunk;
        } while ($chunk !== '');
    }

    /** One frame's whole length, null while its header is incomplete. */
    private static function frameBytes(string $data): ?int
    {
        $available = strlen($data);
        if ($available < 2) {
            return null;
        }
        $second = ord($data[1]);
        $length = $second & 0x7f;
        $header = 2;
        if ($length === 126) {
            if ($available < 4) {
                return null;
            }
            $length = self::bigEndian(substr($data, 2, 2));
            $header = 4;
        } elseif ($length === 127) {
            if ($available < 10) {
                return null;
            }
            $length = self::bigEndian(substr($data, 2, 8));
            $header = 10;
        }
        return $header + (($second & 0x80) !== 0 ? 4 : 0) + $length;
    }

    private static function bigEndian(string $bytes): int
    {
        $value = 0;
        foreach (str_split($bytes) as $byte) {
            $value = ($value << 8) | ord($byte);
        }
        return $value;
    }
}
