<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/** One sku on one order, with name and price SNAPSHOTTED beside a nullable product FK. */
class ShopOrderItem extends Model
{
    use HasUuids;

    protected $guarded = [];

    protected $casts = [
        'unit_price_cents' => 'integer',
        'quantity' => 'integer',
    ];

    public function order(): BelongsTo
    {
        return $this->belongsTo(ShopOrder::class, 'shop_order_id');
    }

    public function product(): BelongsTo
    {
        return $this->belongsTo(ShopProduct::class, 'product_id');
    }

    public function lineTotalCents(): int
    {
        return $this->unit_price_cents * $this->quantity;
    }
}
