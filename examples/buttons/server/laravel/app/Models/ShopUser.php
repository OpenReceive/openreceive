<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * A visitor. Two uuids, two timestamps, no credentials.
 *
 * TWO UUIDS, ON PURPOSE: `id` is the ownership token that travels in the
 * encrypted cookie and is never rendered; `public_ref` is the handle the
 * recent-orders feed shows. A published `id` stops being safe the moment
 * anything else accepts a bare uuid.
 */
class ShopUser extends Model
{
    use HasUuids;

    /** How long a row may go untouched before the next page load writes again. */
    public const SEEN_THROTTLE_SECONDS = 5 * 60;

    protected $guarded = [];

    protected $casts = [
        'first_seen_at' => 'datetime',
        'last_seen_at' => 'datetime',
    ];

    public function uniqueIds(): array
    {
        return ['id', 'public_ref'];
    }

    public function orders(): HasMany
    {
        return $this->hasMany(ShopOrder::class, 'shop_user_id');
    }

    public function touchSeen(): void
    {
        if ($this->last_seen_at !== null && $this->last_seen_at->getTimestamp() > time() - self::SEEN_THROTTLE_SECONDS) {
            return;
        }
        $this->newQuery()->whereKey($this->getKey())->update(['last_seen_at' => now()]);
    }
}
