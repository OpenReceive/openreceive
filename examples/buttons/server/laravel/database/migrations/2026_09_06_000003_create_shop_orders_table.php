<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('shop_orders', function (Blueprint $table): void {
            // The id IS the OpenReceive reference.
            $table->uuid('id')->primary();
            $table->foreignUuid('shop_user_id')->constrained('shop_users');
            $table->string('state')->default('awaiting_payment');
            $table->integer('total_cents');
            $table->string('currency')->default('USD');
            $table->timestamp('paid_at')->nullable();
            $table->string('payment_hash', 64)->nullable();
            $table->timestamps();
            $table->index(['state', 'created_at']);
            $table->index(['state', 'paid_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('shop_orders');
    }
};
