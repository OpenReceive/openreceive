<?php

/**
 * One PHP app of a two-instance shop on real Postgres or MySQL, driven by
 * tests/deployment/two-instances.test.mjs (the contract is at the top of that
 * file). `php -S` with workers calls this for every request: each request
 * builds everything from scratch, as any PHP deployment does.
 */

declare(strict_types=1);

use Nyholm\Psr7\Factory\Psr17Factory;
use OpenReceive\Host;
use OpenReceive\Nwc\ReceiveNwcClient;
use OpenReceive\PaymentSettlement;
use OpenReceive\Server\AuthorizeContext;
use OpenReceive\Server\Engine;
use OpenReceive\Server\Service;
use OpenReceive\Storage\PaymentsSchema;
use OpenReceive\Storage\PdoConnection;
use OpenReceive\Storage\SqlPaymentRepository;
use OpenReceive\Testing\FakeSwapProvider;

require dirname(__DIR__, 3) . '/packages/php/openreceive/vendor/autoload.php';

$instance = getenv('EDGE_INSTANCE') ?: 'a';
$kind = getenv('EDGE_DB_KIND') ?: 'postgres';
$walletUrl = (string) getenv('EDGE_WALLET_URL');

function postWallet(string $walletUrl, string $instance, string $path, array $body): array
{
    $context = stream_context_create(['http' => [
        'method' => 'POST',
        'header' => "content-type: application/json\r\nx-edge-instance: {$instance}\r\n",
        'content' => json_encode($body, JSON_THROW_ON_ERROR),
        'timeout' => 10,
        'ignore_errors' => true,
    ]]);
    $text = file_get_contents($walletUrl . $path, false, $context);
    if ($text === false) {
        throw new RuntimeException("wallet call {$path} failed");
    }
    $decoded = json_decode($text === '' ? '{}' : $text, true, 512, JSON_THROW_ON_ERROR);
    return is_array($decoded) ? $decoded : [];
}

final class SharedWalletClient implements ReceiveNwcClient
{
    public function __construct(private readonly string $walletUrl, private readonly string $instance)
    {
    }

    public function preflight(): array
    {
        return [
            'wallet_pubkey' => str_repeat('f', 64),
            'relays' => ['wss://relay.test.openreceive.local'],
            'methods' => ['make_invoice', 'list_transactions'],
            'encryption' => ['nip04'],
        ];
    }

    public function makeInvoice(array $request): array
    {
        return postWallet($this->walletUrl, $this->instance, '/make_invoice', $request);
    }

    public function listTransactions(array $request): array
    {
        return postWallet($this->walletUrl, $this->instance, '/list_transactions', $request);
    }

    public function subscribeNotifications(callable $handler, ?callable $onIdle = null): void
    {
        throw new RuntimeException('this instance receives notifications through /__notify');
    }
}

function openDatabase(string $kind): PdoConnection
{
    $parts = parse_url((string) getenv('EDGE_DB_URL'));
    $database = ltrim((string) ($parts['path'] ?? ''), '/');
    $host = $parts['host'] ?? '127.0.0.1';
    $port = $parts['port'] ?? ($kind === 'mysql' ? 3306 : 5432);
    $dsn = $kind === 'mysql'
        ? "mysql:host={$host};port={$port};dbname={$database};charset=utf8mb4"
        : "pgsql:host={$host};port={$port};dbname={$database}";
    return PdoConnection::fromDsn($dsn, $parts['user'] ?? null, isset($parts['pass']) ? rawurldecode($parts['pass']) : null);
}

$db = openDatabase($kind);

if (PHP_SAPI === 'cli' && in_array('migrate', $argv, true)) {
    PaymentsSchema::migrate($db);
    $db->execute('CREATE TABLE edge_fulfillments (reference VARCHAR(255) NOT NULL, payment_hash VARCHAR(64) NOT NULL, instance VARCHAR(16) NOT NULL)');
    exit(0);
}

$sendJson = static function (int $status, array $body): void {
    http_response_code($status);
    header('content-type: application/json');
    echo json_encode($body === [] ? new stdClass() : $body, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
};

$path = (string) (parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/');

if ($path === '/__health') {
    $sendJson(200, ['instance' => $instance]);
    return;
}

$raw = (string) file_get_contents('php://input');
$body = $raw === '' ? [] : json_decode($raw, true, 512, JSON_THROW_ON_ERROR);

$host = new class($instance, $walletUrl) implements Host {
    public function __construct(private readonly string $instance, private readonly string $walletUrl)
    {
    }

    public function authorize(AuthorizeContext $context): bool
    {
        return true;
    }

    public function amountFor(string $reference): ?array
    {
        return ['sats' => 1234];
    }

    public function onPaid(PaymentSettlement $settlement): void
    {
        $settlement->connection?->execute(
            'INSERT INTO edge_fulfillments (reference, payment_hash, instance) VALUES (?, ?, ?)',
            [$settlement->reference, $settlement->paymentHash, $this->instance]
        );
        postWallet($this->walletUrl, $this->instance, '/fulfilled', ['reference' => $settlement->reference, 'payment_hash' => $settlement->paymentHash, 'instance' => $this->instance]);
    }
};

$factory = new Psr17Factory();
$engine = new Engine(
    host: $host,
    repository: new SqlPaymentRepository($db),
    service: new Service(new SharedWalletClient($walletUrl, $instance), false, [new FakeSwapProvider()]),
    rateLimiting: ['limit_per_hour' => (int) (getenv('EDGE_RATE_LIMIT_PER_HOUR') ?: 60)],
    clientIp: static function (mixed $request): ?string {
        if (!$request instanceof Psr\Http\Message\ServerRequestInterface) {
            return null;
        }
        $value = $request->getHeaderLine('x-edge-client-ip');
        return $value === '' ? null : $value;
    },
    responseFactory: $factory,
);

function waitUntilMs(mixed $atMs): void
{
    $delay = (float) $atMs / 1000 - microtime(true);
    if ($delay > 0) {
        usleep((int) ($delay * 1_000_000));
    }
}

try {
    if ($path === '/__settle') {
        waitUntilMs($body['at_ms'] ?? 0);
        $engine->settle(['payment_hash' => $body['payment_hash'], 'paid_at' => $body['paid_at']]);
        $sendJson(200, ['ok' => true]);
        return;
    }
    if ($path === '/__reconcile') {
        waitUntilMs($body['at_ms'] ?? 0);
        $sendJson(200, ['reason' => $engine->maybeReconcile()['reason'] ?? null]);
        return;
    }
    if ($path === '/__notify') {
        waitUntilMs($body['at_ms'] ?? 0);
        $engine->reconciler()->handleNotification(['notification_type' => 'payment_received', 'notification' => $body['transaction']]);
        $sendJson(200, ['ok' => true]);
        return;
    }
    $request = $factory->createServerRequest($_SERVER['REQUEST_METHOD'] ?? 'GET', 'http://127.0.0.1' . ($_SERVER['REQUEST_URI'] ?? '/'), $_SERVER)
        ->withBody($factory->createStream($raw));
    foreach (getallheaders() as $name => $value) {
        $request = $request->withHeader($name, $value);
    }
    $response = $engine->psr15Handler()->handle($request);
    http_response_code($response->getStatusCode());
    foreach ($response->getHeaders() as $name => $values) {
        foreach ($values as $value) {
            header("{$name}: {$value}", false);
        }
    }
    echo (string) $response->getBody();
} catch (Throwable $error) {
    $sendJson(500, ['error' => $error::class . ': ' . $error->getMessage()]);
}
