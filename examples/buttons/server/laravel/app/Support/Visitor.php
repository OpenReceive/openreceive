<?php

declare(strict_types=1);

namespace App\Support;

use App\Models\ShopUser;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cookie;

/**
 * Who this browser is, as far as the shop is concerned: a ShopUser id in an
 * ENCRYPTED cookie (Laravel's EncryptCookies signs and encrypts every cookie
 * it sets, and a tampered value reads back as null). The same two readers the
 * Rails demo has: the shop routes mint a visitor, `authorize` only reads one.
 */
final class Visitor
{
    public const COOKIE = 'shop_user_id';

    private const LIFETIME_MINUTES = 60 * 24 * 365;

    /**
     * The visitor's private id WITHOUT minting one. This is what the Host's
     * `authorize` reads: an engine request with no valid cookie is a 403, not
     * a new customer.
     */
    public static function idFrom(Request $request): ?string
    {
        $id = $request->cookie(self::COOKIE);
        return Uuid::valid($id) ? $id : null;
    }

    /**
     * The visitor, minting a row the first time this browser is seen. Called
     * from the SHOP routes only — never from the public feed, an asset or a
     * health check; a demo that mints a user row per crawler hit is a junk-row
     * generator. A cookie that outlives its row degrades to a NEW visitor.
     */
    public static function resolve(Request $request): ShopUser
    {
        $id = self::idFrom($request);
        $user = $id === null ? null : ShopUser::query()->find($id);
        $user ??= ShopUser::query()->create(['first_seen_at' => now(), 'last_seen_at' => now()]);
        Cookie::queue(cookie(self::COOKIE, $user->id, self::LIFETIME_MINUTES, '/', null, $request->isSecure(), true, false, 'lax'));
        $user->touchSeen();
        return $user;
    }
}
