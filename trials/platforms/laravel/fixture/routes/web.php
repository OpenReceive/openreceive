<?php

use App\Models\Order;
use App\Models\Product;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Str;

Route::get('/health', function () {
    return response("ok\n", 200, ['Content-Type' => 'text/plain']);
});

Route::get('/', function () {
    return view('shop', ['products' => Product::query()->orderBy('id')->get()]);
});

Route::post('/orders', function () {
    $product = Product::query()->findOrFail(request('product_id'));
    $token = session('customer_token');
    if (! is_string($token) || $token === '') {
        $token = Str::random(32);
        session(['customer_token' => $token]);
    }
    $order = Order::query()->create([
        'customer_token' => $token,
        'product_name' => $product->name,
        'amount' => $product->price,
        'currency' => 'USD',
        'status' => 'awaiting_payment',
    ]);

    return redirect('/orders/'.$order->id);
});

Route::get('/orders/{order}', function (Order $order) {
    $token = session('customer_token');
    abort_unless(is_string($token) && hash_equals($order->customer_token, $token), 404, 'That order is not yours.');

    return view('order', ['order' => $order]);
});
