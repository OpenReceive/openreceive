<?php

declare(strict_types=1);

namespace ButtonShop;

/**
 * The shop's five handlers — bootstrap, create order, show order, download,
 * recent orders — as plain functions returning [status, headers, body|file].
 * The PHP twin of shared/server-node/shop-routes.ts, same routes, same
 * payloads, so the shared vanilla client runs against it unchanged.
 *
 * OpenReceive owns none of this. The SPA talks to these for everything except
 * the payment itself, which goes to the mounted engine.
 */
final class ShopRoutes
{
    public const IMAGES_PREFIX = '/images';

    public function __construct(
        private readonly Store $store,
        private readonly string $secret,
        private readonly string $openreceivePrefix,
        private readonly string $artworkDir,
    ) {
    }

    /**
     * The visitor, minting a row the first time this browser is seen. Called
     * from the SHOP handlers only — never from an asset, the feed or a probe.
     *
     * @return array{0: array<string, mixed>, 1: string} the user row and the Set-Cookie line
     */
    private function resolveVisitor(string $cookieHeader, bool $secure): array
    {
        $id = Identity::visitorIdFrom($cookieHeader, $this->secret);
        $user = ($id === null ? null : $this->store->userById($id)) ?? $this->store->createUser();
        $this->store->touchSeen($user);
        return [$user, Identity::setCookie($user['id'], $this->secret, $secure)];
    }

    /** Possession of an order id is a CLAIM: another visitor's order is 404, never 403. */
    private function authorizedOrder(mixed $reference, array $user): ?array
    {
        $record = $this->store->orderByReference($reference);
        return $record !== null && $record['order']['shop_user_id'] === $user['id'] ? $record : null;
    }

    /** @return array{0: int, 1: array<string, string>, 2: mixed} */
    public function bootstrap(string $cookieHeader, bool $secure): array
    {
        [$user, $cookie] = $this->resolveVisitor($cookieHeader, $secure);
        $catalog = [];
        foreach ($this->store->activeCatalog() as $product) {
            $catalog[] = ['sku' => $product['sku'], 'name' => $product['name'], 'price_cents' => (int) $product['price_cents'], 'image_url' => $this->imageUrl($product['image_name']) ?? ''];
        }
        // The catalog ships FROM THE SERVER: the browser supplies neither a price nor an image url.
        return [200, ['Set-Cookie' => $cookie, 'Cache-Control' => 'no-store'], ['shop' => [
            'currency' => 'USD',
            'max_per_sku' => Store::MAX_PER_SKU,
            'openreceive_prefix' => $this->openreceivePrefix,
            'catalog' => $catalog,
            'visitor' => ['public_ref' => $user['public_ref']],
        ]]];
    }

    /** One cart becomes one order becomes one reference — minted here, once, before checkout. */
    public function createOrder(string $cookieHeader, bool $secure, mixed $body): array
    {
        [$user, $cookie] = $this->resolveVisitor($cookieHeader, $secure);
        $lines = $this->store->normalizedLines(is_array($body) ? ($body['items'] ?? null) : null);
        if ($lines === []) {
            return [422, ['Set-Cookie' => $cookie], ['error' => 'Your cart is empty.']];
        }
        return [201, ['Set-Cookie' => $cookie], self::orderPayload($this->store->createOrder($lines, $user['id']))];
    }

    /** The order as THIS browser may see it; `state` flips only in onPaid. */
    public function showOrder(string $cookieHeader, bool $secure, string $reference): array
    {
        [$user, $cookie] = $this->resolveVisitor($cookieHeader, $secure);
        $record = $this->authorizedOrder($reference, $user);
        if ($record === null) {
            return [404, ['Set-Cookie' => $cookie], ['error' => 'Not found.']];
        }
        return [200, ['Set-Cookie' => $cookie, 'Cache-Control' => 'no-store'], self::orderPayload($record)];
    }

    /** The thing that was bought, gated on the ORDER ROW `paid` that onPaid wrote — never on anything the browser says. */
    public function download(string $cookieHeader, bool $secure, string $reference, string $sku): array
    {
        [$user, $cookie] = $this->resolveVisitor($cookieHeader, $secure);
        $record = $this->authorizedOrder($reference, $user);
        if ($record === null) {
            return [404, ['Set-Cookie' => $cookie], ['error' => 'Not found.']];
        }
        if (!Store::isPaid($record)) {
            return [403, ['Set-Cookie' => $cookie], ['error' => 'Not paid.']];
        }
        foreach ($record['items'] as $item) {
            if ($item['sku'] !== $sku) {
                continue;
            }
            // basename(): the name comes from a database column, and a column is only as trustworthy as its last editor.
            $file = $this->artworkDir . '/' . basename($item['image_name'] ?? "openreceive-{$item['sku']}-button.webp");
            if (!is_file($file)) {
                break;
            }
            return [200, ['Set-Cookie' => $cookie], ['file' => $file, 'filename' => basename($file), 'content_type' => 'image/webp']];
        }
        return [404, ['Set-Cookie' => $cookie], ['error' => 'Not found.']];
    }

    /** Public, unauthenticated, PAID orders only, cacheable: no visitor is minted here. */
    public function recentOrders(): array
    {
        $orders = [];
        foreach ($this->store->recentOrders(Store::FEED_LIMIT) as $record) {
            $orders[] = $this->feedPayload($record, $record['buyer']);
        }
        return [200, ['Cache-Control' => 'public, max-age=10'], ['orders' => $orders, 'totals' => $this->store->feedTotals()]];
    }

    /** The PRIVATE payload: carries `download_path`, a live URL on a paid order. */
    public static function orderPayload(array $record): array
    {
        $o = $record['order'];
        $paid = Store::isPaid($record);
        $items = [];
        foreach ($record['items'] as $item) {
            $items[] = [
                'sku' => $item['sku'],
                'name' => $item['name'] !== '' ? $item['name'] : $item['sku'],
                'quantity' => (int) $item['quantity'],
                'unit_price_cents' => (int) $item['unit_price_cents'],
                'download_path' => $paid ? '/shop/orders/' . rawurlencode($o['id']) . '/downloads/' . rawurlencode($item['sku']) : null,
            ];
        }
        return [
            'reference' => $o['id'],
            'state' => $o['state'],
            'currency' => $o['currency'],
            'total_cents' => (int) $o['total_cents'],
            'total_amount' => Store::formatAmount((int) $o['total_cents']),
            'description' => Store::checkoutDescription($record),
            'paid_at' => $o['paid_at'] === null ? null : (int) $o['paid_at'],
            'items' => $items,
        ];
    }

    /** A SECOND payload, an explicit whitelist: no order id (it IS the reference), no download path. */
    private function feedPayload(array $record, ?string $buyer): array
    {
        $o = $record['order'];
        $items = [];
        foreach ($record['items'] as $item) {
            $items[] = ['sku' => $item['sku'], 'name' => $item['name'] !== '' ? $item['name'] : $item['sku'], 'quantity' => (int) $item['quantity'], 'image_url' => $this->imageUrl($item['image_name'])];
        }
        return ['buyer' => $buyer, 'total_cents' => (int) $o['total_cents'], 'total_amount' => Store::formatAmount((int) $o['total_cents']), 'currency' => $o['currency'], 'paid_at' => $o['paid_at'] === null ? null : (int) $o['paid_at'], 'items' => $items];
    }

    private function imageUrl(?string $imageName): ?string
    {
        return $imageName === null ? null : self::IMAGES_PREFIX . '/' . rawurlencode($imageName);
    }
}
