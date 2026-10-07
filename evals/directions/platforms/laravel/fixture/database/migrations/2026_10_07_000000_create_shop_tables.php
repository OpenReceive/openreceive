<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('products', function (Blueprint $table) {
            $table->id();
            $table->string('name');
            $table->string('price');
            $table->string('sku')->unique();
            $table->timestamps();
        });

        Schema::create('orders', function (Blueprint $table) {
            $table->id();
            $table->string('customer_token');
            $table->string('product_name');
            $table->string('amount');
            $table->string('currency')->default('USD');
            $table->string('status')->default('awaiting_payment');
            $table->timestamps();
        });

        $now = now();
        foreach ([
            ['Facet', '7.00', 'facet'],
            ['Bezel', '12.00', 'bezel'],
            ['Hinge', '4.00', 'hinge'],
            ['Latch', '9.00', 'latch'],
            ['Knob', '3.00', 'knob'],
        ] as [$name, $price, $sku]) {
            DB::table('products')->insert([
                'name' => $name,
                'price' => $price,
                'sku' => $sku,
                'created_at' => $now,
                'updated_at' => $now,
            ]);
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('orders');
        Schema::dropIfExists('products');
    }
};
