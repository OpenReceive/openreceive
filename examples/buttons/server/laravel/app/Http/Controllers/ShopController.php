<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Models\ShopOrder;
use App\Models\ShopOrderItem;
use App\Models\ShopProduct;
use App\Models\ShopUser;
use App\Support\Visitor;
use Illuminate\Contracts\View\View;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Symfony\Component\HttpFoundation\BinaryFileResponse;

/**
 * The shop's five routes plus the SPA shell and the artwork. OpenReceive owns
 * none of this: it never sees an order, a cart, a price, a product or a
 * download. The SPA talks to these routes for everything except the payment
 * itself, which goes to the mounted engine at /openreceive.
 */
final class ShopController
{
    /** The Blade shell: the CSRF meta the checkout client reads, and the Vite entry. Never cached — it names nothing, but the token is per session. */
    public function index(): View
    {
        return view('shop');
    }

    /**
     * What the SPA hydrates from: the catalog with its image urls, the engine
     * mount prefix, and this visitor's PUBLIC uuid. The catalog ships FROM THE
     * SERVER because the prices are ours: the browser must not be allowed to
     * supply either a price or an image url.
     */
    public function bootstrap(Request $request): JsonResponse
    {
        $user = Visitor::resolve($request);
        return response()->json(['shop' => [
            'currency' => 'USD',
            'max_per_sku' => ShopProduct::MAX_PER_SKU,
            'openreceive_prefix' => '/'.trim((string) config('openreceive.route_prefix'), '/'),
            'catalog' => ShopProduct::query()->active()->ordered()->get()->map(static fn (ShopProduct $product): array => [
                'sku' => $product->sku,
                'name' => $product->name,
                'price_cents' => $product->price_cents,
                'image_url' => self::imageUrl($product->image_name),
            ])->values()->all(),
            'visitor' => ['public_ref' => $user->public_ref],
        ]])->header('Cache-Control', 'no-store');
    }

    /**
     * One cart becomes one order becomes one reference, minted here, once, and
     * held by the browser for the life of this checkout. A fresh id per
     * attempt would leave one cart payable twice.
     */
    public function createOrder(Request $request): JsonResponse
    {
        $user = Visitor::resolve($request);
        $lines = $this->normalizedLines($request->json('items'));
        if ($lines === []) {
            return response()->json(['error' => 'Your cart is empty.'], 422);
        }
        $order = ShopOrder::createFromLines($lines, $user);
        return response()->json($this->orderPayload($order->fresh(['items.product'])), 201);
    }

    /** The order as THIS browser is allowed to see it. The SPA polls this after settlement to learn the downloads unlocked; `state` flips only in onPaid. */
    public function showOrder(Request $request, string $reference): JsonResponse
    {
        $order = $this->authorizedOrder($request, $reference);
        if ($order === null) {
            return response()->json(['error' => 'Not found.'], 404);
        }
        return response()->json($this->orderPayload($order))->header('Cache-Control', 'no-store');
    }

    /**
     * The thing that was bought. Fulfillment is gated on the ORDER ROW, not on
     * anything the browser says: `paid` is written inside OpenReceive's
     * settlement transaction and nowhere else.
     */
    public function download(Request $request, string $reference, string $sku): BinaryFileResponse|JsonResponse
    {
        $order = $this->authorizedOrder($request, $reference);
        if ($order === null) {
            return response()->json(['error' => 'Not found.'], 404);
        }
        if (!$order->isPaid()) {
            return response()->json(['error' => 'Not paid.'], 403);
        }
        $item = $order->items->first(static fn (ShopOrderItem $item): bool => $item->sku === $sku);
        if ($item === null) {
            return response()->json(['error' => 'Not found.'], 404);
        }
        // The product row when it still exists, the sku convention when it does
        // not — a deactivated or deleted product must not break a download
        // somebody paid for. basename() because the name comes from a column.
        $imageName = basename($item->product?->image_name ?? "openreceive-{$item->sku}-button.webp");
        $path = self::artworkRoot().'/'.$imageName;
        if (!is_file($path)) {
            return response()->json(['error' => 'Not found.'], 404);
        }
        return response()->download($path, $imageName, ['Content-Type' => 'image/webp']);
    }

    /**
     * Public, unauthenticated, paid orders only. NO VISITOR IS MINTED HERE, and
     * there is no per-visitor field in the body, so it is one identical,
     * cacheable response for everybody — the SPA draws its own "You" badge by
     * comparing each row's buyer against the bootstrap payload. Paid-only is
     * also the anti-spam design: an entry here costs a real payment.
     */
    public function recentOrders(): JsonResponse
    {
        $orders = ShopOrder::query()
            ->where('state', ShopOrder::PAID)
            ->orderByDesc('paid_at')
            ->orderByDesc('created_at')
            ->limit(ShopOrder::FEED_LIMIT)
            ->with(['shopUser', 'items.product'])
            ->get();
        return response()->json([
            'orders' => $orders->map(fn (ShopOrder $order): array => $this->feedPayload($order))->values()->all(),
            'totals' => [
                'paid_orders' => ShopOrder::query()->where('state', ShopOrder::PAID)->count(),
                'buttons_sold' => (int) ShopOrderItem::query()
                    ->join('shop_orders', 'shop_orders.id', '=', 'shop_order_items.shop_order_id')
                    ->where('shop_orders.state', ShopOrder::PAID)
                    ->sum('shop_order_items.quantity'),
            ],
        ])->header('Cache-Control', 'public, max-age=10');
    }

    /** The one copy of the artwork, examples/buttons/images, read by every stack. */
    public function image(string $name): BinaryFileResponse|Response
    {
        $path = self::artworkRoot().'/'.basename($name);
        if (!is_file($path)) {
            return response('Not found.', 404);
        }
        return response()->file($path, ['Content-Type' => 'image/webp', 'Cache-Control' => 'public, max-age=3600']);
    }

    public static function artworkRoot(): string
    {
        return realpath(base_path('../../images')) ?: base_path('../../images');
    }

    private static function imageUrl(string $imageName): string
    {
        return '/images/'.rawurlencode($imageName);
    }

    /** Possession of an order id is a CLAIM, not proof. Another visitor's order is 404 and never 403: do not confirm that an id exists. */
    private function authorizedOrder(Request $request, string $reference): ?ShopOrder
    {
        $user = Visitor::resolve($request);
        $order = ShopOrder::findByReference($reference);
        if ($order === null || $order->shop_user_id !== $user->id) {
            return null;
        }
        return $order->load('items.product');
    }

    /**
     * THE TRUST BOUNDARY. The cart is a claim: skus are looked up against the
     * live catalog, quantities are clamped, and prices come from the product
     * rows — never a number off the wire.
     *
     * @return list<array{product: ShopProduct, quantity: int}>
     */
    private function normalizedLines(mixed $requested): array
    {
        if (!is_array($requested)) {
            return [];
        }
        /** @var array<string, array{product: ShopProduct, quantity: int}> $lines */
        $lines = [];
        foreach ($requested as $line) {
            if (!is_array($line)) {
                continue;
            }
            $product = ShopProduct::activeBySku($line['sku'] ?? null);
            if ($product === null) {
                continue;
            }
            $quantity = is_numeric($line['quantity'] ?? null) ? (int) $line['quantity'] : 0;
            if ($quantity <= 0) {
                continue;
            }
            $current = $lines[$product->id]['quantity'] ?? 0;
            $lines[$product->id] = ['product' => $product, 'quantity' => min($current + $quantity, ShopProduct::MAX_PER_SKU)];
        }
        usort($lines, static fn (array $a, array $b): int => [$a['product']->position, $a['product']->price_cents] <=> [$b['product']->position, $b['product']->price_cents]);
        return array_values($lines);
    }

    /** The PRIVATE order payload: reference, state, downloads once paid. Must never converge with the feed payload. */
    private function orderPayload(ShopOrder $order): array
    {
        return [
            'reference' => $order->id,
            'state' => $order->state,
            'currency' => $order->currency,
            'total_cents' => $order->total_cents,
            'total_amount' => $order->totalAmount(),
            'description' => $order->checkoutDescription(),
            'paid_at' => $order->paid_at?->getTimestamp(),
            'items' => $order->items->map(static fn (ShopOrderItem $item): array => [
                'sku' => $item->sku,
                'name' => $item->name !== '' ? $item->name : $item->sku,
                'quantity' => $item->quantity,
                'unit_price_cents' => $item->unit_price_cents,
                'download_path' => $order->isPaid() ? '/shop/orders/'.rawurlencode($order->id).'/downloads/'.rawurlencode($item->sku) : null,
            ])->values()->all(),
        ];
    }

    /** The PUBLIC feed payload: no order id, not even truncated — shop_orders.id IS the OpenReceive reference. */
    private function feedPayload(ShopOrder $order): array
    {
        return [
            'buyer' => $order->shopUser?->public_ref,
            'total_cents' => $order->total_cents,
            'total_amount' => $order->totalAmount(),
            'currency' => $order->currency,
            'paid_at' => $order->paid_at?->getTimestamp(),
            'items' => $order->items->map(static fn (ShopOrderItem $item): array => [
                'sku' => $item->sku,
                'name' => $item->name !== '' ? $item->name : $item->sku,
                'quantity' => $item->quantity,
                'image_url' => $item->product === null ? null : self::imageUrl($item->product->image_name),
            ])->values()->all(),
        ];
    }
}
