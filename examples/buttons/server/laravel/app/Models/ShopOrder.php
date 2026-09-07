<?php

declare(strict_types=1);

namespace App\Models;

use App\Support\Uuid;
use Carbon\CarbonImmutable;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Facades\DB;

/**
 * One cart checkout. The id IS the OpenReceive `reference`: created before
 * checkout, kept across every retry, never reused, and unguessable because it
 * is a uuid rather than a sequential integer.
 *
 * OpenReceive never sees this model. The three hooks in app/OpenReceive/Host.php
 * are the only bridge:
 *   authorize  -> shop_user_id vs. the encrypted visitor cookie
 *   amountFor  -> totalAmount() / checkoutDescription(), below
 *   onPaid     -> claimPaid(), below
 */
class ShopOrder extends Model
{
    use HasUuids;

    public const AWAITING_PAYMENT = 'awaiting_payment';
    public const PAID = 'paid';

    /** How many rows the public feed shows, and the only limit it honours. */
    public const FEED_LIMIT = 25;

    protected $guarded = [];

    protected $casts = [
        'total_cents' => 'integer',
        'paid_at' => 'datetime',
    ];

    public function shopUser(): BelongsTo
    {
        return $this->belongsTo(ShopUser::class, 'shop_user_id');
    }

    public function items(): HasMany
    {
        // Catalog order: items are created in the order the cart was normalized
        // (position, price), and HasUuids mints time-ordered ids.
        return $this->hasMany(ShopOrderItem::class, 'shop_order_id')->orderBy('created_at')->orderBy('id');
    }

    /** The reference arrives as a string the payer's browser sent: Postgres RAISES on a malformed uuid literal, so it is checked first. */
    public static function findByReference(mixed $reference): ?self
    {
        return Uuid::valid($reference) ? self::query()->find($reference) : null;
    }

    /**
     * One transaction: the order and every item, with the total summed from
     * the PRODUCT rows the controller looked up. Nothing here reads a number
     * the browser sent. Name and unit price are snapshotted onto the item so a
     * receipt survives a renamed or deleted product.
     *
     * @param list<array{product: ShopProduct, quantity: int}> $lines
     */
    public static function createFromLines(array $lines, ShopUser $user): self
    {
        return DB::transaction(static function () use ($lines, $user): self {
            $order = self::query()->create([
                'shop_user_id' => $user->id,
                'state' => self::AWAITING_PAYMENT,
                'currency' => 'USD',
                'total_cents' => array_sum(array_map(static fn (array $line): int => $line['product']->price_cents * $line['quantity'], $lines)),
            ]);
            foreach ($lines as $line) {
                $order->items()->create([
                    'product_id' => $line['product']->id,
                    'sku' => $line['product']->sku,
                    'name' => $line['product']->name,
                    'unit_price_cents' => $line['product']->price_cents,
                    'quantity' => $line['quantity'],
                ]);
            }
            return $order;
        });
    }

    public function isPaid(): bool
    {
        return $this->state === self::PAID;
    }

    /** A decimal STRING from integer cents. Never a float: the division happens once, here, at the edge. */
    public function totalAmount(): string
    {
        return sprintf('%d.%02d', intdiv($this->total_cents, 100), $this->total_cents % 100);
    }

    /** "OpenReceive buttons: Safety Orange ×2, Classic Black" — what `amountFor` shows the payer above the amount. */
    public function checkoutDescription(): string
    {
        $items = $this->items;
        $count = (int) $items->sum('quantity');
        $parts = $items->map(static fn (ShopOrderItem $item): string => $item->quantity > 1 ? "{$item->name} ×{$item->quantity}" : $item->name);
        return 'OpenReceive '.($count === 1 ? 'button' : 'buttons').': '.$parts->implode(', ');
    }

    /**
     * THE GUARDED TRANSITION THE MONEY RESTS ON. One conditional UPDATE: the
     * WHERE clause is the lock, so whoever flips awaiting_payment -> paid first
     * is the only one who fulfills, and every later caller updates 0 rows.
     * Runs on the connection OpenReceive's settlement transaction holds.
     */
    public static function claimPaid(string $reference, int $paidAt, string $paymentHash): bool
    {
        if (!Uuid::valid($reference)) {
            return false;
        }
        $claimed = self::query()
            ->where('id', $reference)
            ->where('state', self::AWAITING_PAYMENT)
            ->update([
                'state' => self::PAID,
                'paid_at' => CarbonImmutable::createFromTimestampUTC($paidAt),
                'payment_hash' => $paymentHash,
                'updated_at' => now(),
            ]);
        return $claimed > 0;
    }
}
