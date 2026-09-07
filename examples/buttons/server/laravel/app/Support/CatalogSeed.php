<?php

declare(strict_types=1);

namespace App\Support;

use App\Models\ShopProduct;

/**
 * examples/buttons/shared/shop-catalog.json is THE seed source of truth for
 * every stack; this app reads it rather than carrying a copy. Idempotent:
 * re-seeding updates the six rows in place.
 */
final class CatalogSeed
{
    public static function path(): string
    {
        return realpath(base_path('../../shared/shop-catalog.json')) ?: base_path('../../shared/shop-catalog.json');
    }

    /** @return list<array{sku: string, name: string, price_cents: int, position: int, image_name: string}> */
    public static function entries(): array
    {
        /** @var list<array{sku: string, name: string, price_cents: int, position: int, image_name: string}> $entries */
        $entries = json_decode((string) file_get_contents(self::path()), true, 512, JSON_THROW_ON_ERROR);
        return $entries;
    }

    public static function apply(): int
    {
        $entries = self::entries();
        foreach ($entries as $entry) {
            ShopProduct::query()->updateOrCreate(['sku' => $entry['sku']], [
                'name' => $entry['name'],
                'price_cents' => $entry['price_cents'],
                'position' => $entry['position'],
                'image_name' => $entry['image_name'],
                'active' => true,
            ]);
        }
        return count($entries);
    }
}
