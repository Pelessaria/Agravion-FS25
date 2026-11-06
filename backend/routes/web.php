<?php

use Illuminate\Support\Facades\Route;

/*
| Agravion UI (Vite build) lives in public/ as agravion.html + /assets/*.
| agrivision.html remains a one-release fallback while hosts catch up.
| Laravel API stays under /api; health under /up.
*/

Route::get('/{any?}', function () {
    $spa = null;
    foreach (['agravion.html', 'agrivision.html'] as $name) {
        $candidate = public_path($name);
        if (is_file($candidate)) {
            $spa = $candidate;
            break;
        }
    }
    if ($spa !== null) {
        // Never let browsers keep a stale shell that points at old /assets/*.js hashes.
        return response()->file($spa, [
            'Content-Type' => 'text/html; charset=UTF-8',
            'Cache-Control' => 'no-store, no-cache, must-revalidate, max-age=0',
            'Pragma' => 'no-cache',
        ]);
    }

    return view('welcome');
})->where('any', '^(?!api(?:/|$)|up(?:/|$)).*');
