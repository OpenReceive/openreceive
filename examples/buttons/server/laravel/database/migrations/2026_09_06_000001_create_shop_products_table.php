<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('shop_products', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->string('sku')->unique();
            $table->string('name');
            $table->integer('price_cents');
            $table->integer('position')->default(0);
            $table->string('image_name');
            $table->boolean('active')->default(true);
            $table->timestamps();
            $table->index(['active', 'position']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('shop_products');
    }
};
