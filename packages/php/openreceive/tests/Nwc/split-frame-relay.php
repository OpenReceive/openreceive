<?php

declare(strict_types=1);

// A throwaway websocket relay for RelayWebsocketTest, which starts it with
// proc_open and stops it by its handle:
//
//     php split-frame-relay.php <piece bytes> <pause ms> < reply
//
// It listens on a free port on 127.0.0.1, prints the address, accepts one
// connection, answers the HTTP Upgrade and waits for the client's NIP-47
// EVENT. It sends the reply from stdin, with that event's id in place of
// {request-id}, as one text frame written in pieces with a pause after each,
// so the client's reads find the frame partly arrived, as they do when a real
// relay's TLS records come in one by one. Then it waits for the client to hang
// up. Anything unexpected, or TIMEOUT_SECONDS of silence, ends it with a line
// on stderr and exit status 1.

const TIMEOUT_SECONDS = 5;

function fail(string $message): never
{
    fwrite(STDERR, "split-frame-relay: {$message}\n");
    exit(1);
}

/**
 * The client's next bytes; '' once it has hung up.
 *
 * @param resource $client
 */
function receive($client): string
{
    $read = [$client];
    $write = $except = null;
    if (stream_select($read, $write, $except, TIMEOUT_SECONDS) !== 1) {
        fail('the client went quiet');
    }
    return (string) @fread($client, 65536);
}

/**
 * The client's next bytes, which must come.
 *
 * @param resource $client
 */
function more($client, string $hungUp): string
{
    $bytes = receive($client);
    if ($bytes === '') {
        fail($hungUp);
    }
    return $bytes;
}

/**
 * Takes the first whole client frame off $buffer.
 *
 * @return array{int, string}|null its opcode and unmasked payload; null until it is whole
 */
function takeFrame(string &$buffer): ?array
{
    if (strlen($buffer) < 2) {
        return null;
    }
    $length = ord($buffer[1]) & 0x7f;
    $offset = 2;
    if ($length === 126) {
        $offset = 4;
    } elseif ($length === 127) {
        $offset = 10;
    }
    $masked = (ord($buffer[1]) & 0x80) !== 0;
    if (strlen($buffer) < $offset + ($masked ? 4 : 0)) {
        return null;
    }
    if ($offset > 2) {
        // The extended length: two or eight bytes, big-endian.
        $length = 0;
        foreach (str_split(substr($buffer, 2, $offset - 2)) as $byte) {
            $length = ($length << 8) | ord($byte);
        }
    }
    $mask = $masked ? substr($buffer, $offset, 4) : "\0\0\0\0";
    $offset += $masked ? 4 : 0;
    if (strlen($buffer) < $offset + $length) {
        return null;
    }
    $frame = [ord($buffer[0]) & 0x0f, substr($buffer, $offset, $length) ^ str_repeat($mask, intdiv($length, 4) + 1)];
    $buffer = substr($buffer, $offset + $length);
    return $frame;
}

$pieceBytes = (int) ($argv[1] ?? 0);
$pauseMicroseconds = (int) ($argv[2] ?? 0) * 1000;
if ($pieceBytes < 1) {
    fail('usage: split-frame-relay.php <piece bytes> <pause ms> < reply');
}
$reply = (string) stream_get_contents(STDIN);

$server = stream_socket_server('tcp://127.0.0.1:0', $errno, $error);
if ($server === false) {
    fail("cannot listen: {$error}");
}
fwrite(STDOUT, stream_socket_get_name($server, false) . "\n");
$client = @stream_socket_accept($server, TIMEOUT_SECONDS);
if ($client === false) {
    fail('nobody connected');
}
// One connection only: the port is free again from here on.
fclose($server);

$buffer = '';
while (($end = strpos($buffer, "\r\n\r\n")) === false) {
    $buffer .= more($client, 'the client hung up during the handshake');
}
if (preg_match('/^Sec-WebSocket-Key: *(\S+)/mi', substr($buffer, 0, $end), $key) !== 1) {
    fail('the upgrade request has no Sec-WebSocket-Key');
}
$accept = base64_encode(sha1($key[1] . '258EAFA5-E914-47DA-95CA-C5AB0DC85B11', true));
fwrite($client, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {$accept}\r\n\r\n");
$buffer = substr($buffer, $end + 4);

// The client subscribes (REQ), then sends its request (EVENT).
$id = null;
while ($id === null) {
    while (($frame = takeFrame($buffer)) === null) {
        $buffer .= more($client, 'the client hung up before its request');
    }
    $message = $frame[0] === 0x1 ? json_decode($frame[1], true) : null;
    if (is_array($message) && ($message[0] ?? null) === 'EVENT') {
        $id = (string) ($message[1]['id'] ?? fail('the EVENT has no id'));
    }
}

$message = str_replace('{request-id}', $id, $reply);
$length = strlen($message);
$frame = "\x81" . match (true) {
    $length < 126 => chr($length),
    $length < 65536 => chr(126) . pack('n', $length),
    default => chr(127) . pack('J', $length),
} . $message;
foreach (str_split($frame, $pieceBytes) as $piece) {
    if (@fwrite($client, $piece) !== strlen($piece)) {
        fail('the client hung up mid-reply');
    }
    usleep($pauseMicroseconds);
}

while (receive($client) !== '') {
    // The client's CLOSE and close frame; nothing to answer.
}
exit(0);
