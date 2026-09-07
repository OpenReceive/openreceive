<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * THE PRICE AUTHORITY. Read fresh on every order creation — never memoized:
 * reading it live is the whole point of moving prices out of code and into a
 * table an operator can edit. Seeded from examples/buttons/shared/shop-catalog.json.
 */
class ShopProduct extends Model
{
    use HasUuids;

    public const MAX_PER_SKU = 10;

    public const SKU_PATTERN = '/\A[a-z]+(?:-[a-z]+)*\z/';

    protected $guarded = [];

    protected $casts = [
        'price_cents' => 'integer',
        'position' => 'integer',
        'active' => 'boolean',
    ];

    public function orderItems(): HasMany
    {
        return $this->hasMany(ShopOrderItem::class, 'product_id');
    }

    public function scopeActive(Builder $query): void
    {
        $query->where('active', true);
    }

    public function scopeOrdered(Builder $query): void
    {
        $query->orderBy('position')->orderBy('price_cents');
    }

    /** `active = false` hides a product from the catalog and from order creation; it must never break an existing receipt. */
    public static function activeBySku(mixed $sku): ?self
    {
        if (!is_string($sku) || preg_match(self::SKU_PATTERN, $sku) !== 1) {
            return null;
        }
        return self::query()->active()->where('sku', $sku)->first();
    }
}
