<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('shop_order_items', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('shop_order_id')->constrained('shop_orders')->cascadeOnDelete();
            // Nullable on purpose: a deleted product must not break a receipt somebody paid for.
            $table->foreignUuid('product_id')->nullable()->constrained('shop_products')->nullOnDelete();
            $table->string('sku');
            $table->string('name');
            $table->integer('unit_price_cents');
            $table->integer('quantity');
            $table->timestamps();
            $table->unique(['shop_order_id', 'sku']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('shop_order_items');
    }
};
