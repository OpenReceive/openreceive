<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Testkit\Testkit;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * The test-only control surface, mounted at /__testkit in testkit wallet mode
 * and a hard JSON 404 in every other mode. It never touches a visitor:
 * settling an invoice is a wallet event, and minting a visitor row for a
 * control call would put junk in the feed the demo is about. CSRF is skipped
 * for it in bootstrap/app.php for the same reason curl has to be able to drive it.
 */
final class TestkitController
{
    public function control(Request $request, string $control): JsonResponse
    {
        $params = $request->isJson() ? (array) $request->json()->all() : $request->all();
        [$status, $body] = Testkit::control($control, $params);
        return response()->json($body, $status)->header('Cache-Control', 'no-store');
    }
}
