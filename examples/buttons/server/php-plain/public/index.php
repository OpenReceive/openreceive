<?php

/**
 * Buy a Button on plain PHP — the whole server, one front controller.
 *
 * No framework. `php -S 127.0.0.1:3008 -t public public/index.php` runs it:
 * the built-in server calls this file for every request and serves a static
 * file itself whenever this returns `false`. The shop's routes, the engine's
 * PSR-15 mount, the artwork and the SPA fallback are the path switch below;
 * THE THREE HOOKS are the anonymous Host class, and they are the only bridge
 * between OpenReceive and this shop's tables.
 *
 * Every request is a fresh PHP process. That is the one property that makes
 * PHP different from the Node, Python and Ruby stacks, and it shows up exactly
 * twice: the engine's settlement discovery is the durable openreceive_meta
 * gate in the database (nothing in memory to lose), and testkit mode has to
 * persist its fakes between requests (src/Testkit.php).
 */

declare(strict_types=1);

use ButtonShop\Identity;
use ButtonShop\ShopRoutes;
use ButtonShop\StderrLogger;
use ButtonShop\Store;
use ButtonShop\Testkit;
use Nyholm\Psr7\Factory\Psr17Factory;
use Nyholm\Psr7Server\ServerRequestCreator;
use OpenReceive\Host;
use OpenReceive\PaymentSettlement;
use OpenReceive\Rates\StaticPriceProvider;
use OpenReceive\Server\AuthorizeContext;
use OpenReceive\Server\Engine;
use OpenReceive\Server\Service;
use OpenReceive\Storage\PdoConnection;
use OpenReceive\Storage\SqlPaymentRepository;

require dirname(__DIR__) . '/vendor/autoload.php';

$publicDir = __DIR__;
$buttonsDir = dirname(__DIR__, 3);                 // examples/buttons
$path = rawurldecode((string) (parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/'));
$method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');

// 1. Static files under public/: the built shop (vite build) and the standalone
//    checkout under public/openreceive/. `return false` hands them to php -S.
$file = realpath($publicDir . $path);
if ($path !== '/' && $file !== false && is_file($file) && str_starts_with($file, $publicDir . DIRECTORY_SEPARATOR)) {
    return false;
}

// 2. The shop's own state: ONE SQLite file the application opens, holding its four
//    tables and the engine's two. OPENRECEIVE_DEMO_DB (a directory) relocates it.
$dataDir = getenv('OPENRECEIVE_DEMO_DB') ?: $buttonsDir . '/.data';
$store = Store::open($dataDir, $buttonsDir . '/shared');
$secret = Identity::secret($dataDir, 'php-plain');
$prefix = '/openreceive';
$logger = new StderrLogger();

/** The response writer: status, headers, then a JSON body or a file. @param array{0: int, 1: array<string, string>, 2: mixed} $result */
$send = static function (array $result): void {
    [$status, $headers, $body] = $result;
    http_response_code($status);
    foreach ($headers as $name => $value) {
        header("{$name}: {$value}", $name !== 'Set-Cookie');
    }
    if (is_array($body) && isset($body['file'])) {
        header("Content-Type: {$body['content_type']}");
        header('Content-Disposition: attachment; filename="' . $body['filename'] . '"');
        readfile($body['file']);
        return;
    }
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($body, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
};
$jsonBody = static fn (): array => is_array($decoded = json_decode((string) file_get_contents('php://input'), true)) ? $decoded : [];
$cookieHeader = $_SERVER['HTTP_COOKIE'] ?? '';
$secure = ($_SERVER['HTTPS'] ?? '') !== '' && $_SERVER['HTTPS'] !== 'off';

// 3. THE THREE HOOKS. OpenReceive never sees an order, a product, a visitor, the
//    cart or the download; this class is the entire bridge. It mirrors the Node
//    stacks' openreceive-config.ts line for line.
$host = new class($store, $secret, $logger) implements Host {
    public function __construct(private readonly Store $store, private readonly string $secret, private readonly StderrLogger $logger)
    {
    }

    /**
     * THE HOST AUTHORIZES EVERY REQUEST. An order id is a uuid the payer's browser
     * sent back — a CLAIM, not proof — so the order has to belong to THIS browser:
     * the signed shop_user_id cookie, read straight off the PSR-7 request.
     */
    public function authorize(AuthorizeContext $context): bool
    {
        $record = $this->store->orderByReference($context->reference());
        if ($record === null) {
            return false;
        }
        $visitor = Identity::visitorIdFrom($context->request->getHeaderLine('cookie'), $this->secret);
        return $visitor !== null && $record['order']['shop_user_id'] === $visitor;
    }

    /**
     * The price for a reference from OUR OWN ROW — nothing a payer sends can reach
     * it. `value` is a decimal STRING from integer cents; `description` is what the
     * payer is buying, the one line the checkout renders above the amount.
     */
    public function amountFor(string $reference): ?array
    {
        $record = $this->store->orderByReference($reference);
        if ($record === null) {
            return null;
        }
        return ['currency' => $record['order']['currency'], 'value' => Store::formatAmount((int) $record['order']['total_cents']), 'description' => Store::checkoutDescription($record)];
    }

    /**
     * INSIDE the settlement transaction, once per reference. The guarded UPDATE
     * runs on `$settlement->connection` — the transaction the payment record is
     * being written in — so the order flip and the payment commit together.
     * DATABASE WRITES ONLY: flipping the order to `paid` IS the delivery here,
     * because the download route serves the artwork only from a paid row.
     */
    public function onPaid(PaymentSettlement $settlement): void
    {
        if ($settlement->connection === null || !Store::claimPaid($settlement->connection, $settlement->reference, $settlement->paidAt, $settlement->paymentHash)) {
            return;
        }
        $this->logger->info('openreceive.on_paid Checkout settled — the order is paid and its downloads unlocked.', ['reference' => $settlement->reference, 'payment_hash' => $settlement->paymentHash]);
    }
};

// 4. Testkit mode (DEMO_WALLET=testkit): the engine's fakes, restored from the
//    previous request, and the /__testkit control routes. Off: a JSON 404.
$testkit = getenv('DEMO_WALLET') === 'testkit' ? Testkit::open($dataDir) : null;

try {
    if ($path === $prefix || str_starts_with($path, $prefix . '/')) {
        // The engine: the wallet (real or fake), the library repository over the SAME
        // PDO the shop uses, the host above, and the PSR-15 mount. Every payment route
        // first runs the gated opportunistic reconcile, which is how settlement lands
        // without a worker: the gate lives in openreceive_meta, shared by every process.
        $service = $testkit !== null
            ? new Service($testkit->wallet, new StaticPriceProvider(), [$testkit->swap], ['USD'], null, false, null, $logger)
            : Service::fromEnvironment(null, ['USD'], null, null, false, $logger);
        $engine = new Engine($host, new SqlPaymentRepository(new PdoConnection($store->pdo)), $service, true, false, null, null, $logger, $prefix);
        $factory = new Psr17Factory();
        $response = $engine->psr15Handler()->handle((new ServerRequestCreator($factory, $factory, $factory, $factory))->fromGlobals());
        http_response_code($response->getStatusCode());
        foreach ($response->getHeaders() as $name => $values) {
            foreach ($values as $value) {
                header("{$name}: {$value}", false);
            }
        }
        echo (string) $response->getBody();
    } elseif ($path === Testkit::PREFIX || str_starts_with($path, Testkit::PREFIX . '/')) {
        $result = $testkit?->control(ltrim(substr($path, strlen(Testkit::PREFIX)), '/'), $jsonBody()) ?? [404, Testkit::errorBody(404, 'Not found.')];
        $send([$result[0], ['Cache-Control' => 'no-store'], $result[1]]);
    } elseif (str_starts_with($path, '/shop/')) {
        // The shop's own JSON API. OpenReceive owns none of it.
        $shop = new ShopRoutes($store, $secret, $prefix, $buttonsDir . '/images');
        $send(match (true) {
            $method === 'GET' && $path === '/shop/bootstrap' => $shop->bootstrap($cookieHeader, $secure),
            $method === 'POST' && $path === '/shop/orders' => $shop->createOrder($cookieHeader, $secure, $jsonBody()),
            $method === 'GET' && $path === '/shop/recent_orders' => $shop->recentOrders(),
            $method === 'GET' && preg_match('#^/shop/orders/([^/]+)/downloads/([^/]+)$#', $path, $m) === 1 => $shop->download($cookieHeader, $secure, $m[1], $m[2]),
            $method === 'GET' && preg_match('#^/shop/orders/([^/]+)$#', $path, $m) === 1 => $shop->showOrder($cookieHeader, $secure, $m[1]),
            default => [404, [], ['error' => 'Not found.']],
        });
    } elseif (str_starts_with($path, ShopRoutes::IMAGES_PREFIX . '/')) {
        // Catalog thumbnails are public: the one copy of the artwork, outside the docroot.
        $image = $buttonsDir . '/images/' . basename($path);
        if (!is_file($image)) {
            $send([404, [], ['error' => 'Not found.']]);
        } else {
            header('Content-Type: image/webp');
            header('Cache-Control: public, max-age=86400');
            readfile($image);
        }
    } elseif ($method === 'GET' && is_file($publicDir . '/index.html')) {
        // The SPA, including /checkout/:reference — a payer with a deposit in flight
        // has to be able to reload it.
        header('Content-Type: text/html; charset=utf-8');
        readfile($publicDir . '/index.html');
    } else {
        $send([404, [], ['error' => 'Not found.']]);
    }
} finally {
    $testkit?->save();
}
