<?php

// Fills the stock Paymenter with a small hosting shop: its owner (an admin),
// a client the live checks sign in as, a second client, and five VPS products
// at the trial's five prices. The harness runs it once, before the agent sees
// the shop; the agent does not. SHOP_URL is the shop's published address.

declare(strict_types=1);

require '/app/vendor/autoload.php';
$app = require '/app/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

use App\Models\Category;
use App\Models\Product;
use App\Models\Role;
use App\Models\Setting;
use App\Models\User;

$url = getenv('SHOP_URL');
if (!is_string($url) || $url === '') {
    throw new RuntimeException('SHOP_URL is not set.');
}
// Paymenter builds its links from this setting, not from APP_URL.
Setting::updateOrCreate(['key' => 'app_url'], ['value' => $url]);
Setting::updateOrCreate(['key' => 'company_name'], ['value' => 'Widget Hosting']);

$admin = Role::where('name', 'admin')->firstOrFail();
foreach ([
    ['shop@example.test', 'Shop', 'Owner', $admin->id],
    ['buyer@example.test', 'Demo', 'Buyer', null],
    ['stranger@example.test', 'Other', 'Client', null],
] as [$email, $first, $last, $role]) {
    $user = User::firstOrNew(['email' => $email]);
    $user->fill(['first_name' => $first, 'last_name' => $last, 'password' => 'widget-shop-local']);
    $user->role_id = $role;
    $user->email_verified_at = now();
    $user->save();
}

$category = Category::firstOrCreate(['slug' => 'vps'], ['name' => 'VPS', 'description' => 'Virtual private servers, billed monthly.']);
foreach ([
    ['Widget VPS Nano', '7.00'],
    ['Widget VPS Micro', '12.50'],
    ['Widget VPS Small', '20.00'],
    ['Widget VPS Medium', '35.00'],
    ['Widget VPS Large', '50.00'],
] as [$name, $price]) {
    $slug = strtolower(str_replace(' ', '-', $name));
    if (Product::where('slug', $slug)->exists()) {
        continue;
    }
    $product = Product::create(['category_id' => $category->id, 'name' => $name, 'slug' => $slug, 'description' => "{$name}, one month."]);
    $plan = $product->plans()->create(['name' => 'Monthly', 'type' => 'recurring', 'billing_period' => 1, 'billing_unit' => 'month']);
    $plan->prices()->create(['price' => $price, 'currency_code' => 'USD']);
}

echo 'Seeded ' . Product::count() . " products.\n";
