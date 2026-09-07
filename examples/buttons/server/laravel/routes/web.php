<?php

use App\Http\Controllers\ShopController;
use App\Http\Controllers\TestkitController;
use App\Support\Uuid;
use Illuminate\Support\Facades\Route;

// The OpenReceive routes (/openreceive/*) are registered by the package's
// service provider under the `web` group — nothing to mount here.

Route::get('/', [ShopController::class, 'index']);
// The way back to a payment: /checkout/:reference serves the same shell, and
// the SPA restores the order behind it — see shared/checkout-resume.ts.
Route::get('/checkout/{reference}', [ShopController::class, 'index'])->where('reference', Uuid::ROUTE_PATTERN);

Route::get('/shop/bootstrap', [ShopController::class, 'bootstrap']);
Route::post('/shop/orders', [ShopController::class, 'createOrder']);
Route::get('/shop/orders/{reference}', [ShopController::class, 'showOrder'])->where('reference', Uuid::ROUTE_PATTERN);
Route::get('/shop/orders/{reference}/downloads/{sku}', [ShopController::class, 'download'])
    ->where(['reference' => Uuid::ROUTE_PATTERN, 'sku' => '[a-z]+(?:-[a-z]+)*']);
Route::get('/shop/recent_orders', [ShopController::class, 'recentOrders']);

// One copy of the product artwork, served from examples/buttons/images.
Route::get('/images/{name}', [ShopController::class, 'image'])->where('name', '[a-z0-9-]+\.webp');

// Declared unconditionally, refuses unconditionally: App\Testkit\Testkit::enabled()
// is the only thing between a production boot and a surface that can settle invoices.
Route::match(['get', 'post'], '/__testkit/{control}', [TestkitController::class, 'control'])->where('control', '[a-z-]+');
