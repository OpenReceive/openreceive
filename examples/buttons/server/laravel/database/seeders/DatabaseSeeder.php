<?php

declare(strict_types=1);

namespace Database\Seeders;

use App\Support\CatalogSeed;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\Log;

class DatabaseSeeder extends Seeder
{
    public function run(): void
    {
        $count = CatalogSeed::apply();
        Log::info("[buttons-laravel] seeded {$count} products from ".CatalogSeed::path());
    }
}
