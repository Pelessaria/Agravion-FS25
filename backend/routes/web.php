<?php

use Illuminate\Support\Facades\Route;

/*
| Agravion UI (Vite build) lives in public/ as agravion.html + /assets/*.
| Laravel API stays under /api; health under /up.
*/

Route::get('/{any?}', function () {
    $spa = public_path('agravion.html');
    if (is_file($spa)) {
        // Never let browsers keep a stale shell that points at old /assets/*.js hashes.
        return response()->file($spa, [
            'Content-Type' => 'text/html; charset=UTF-8',
            'Cache-Control' => 'no-store, no-cache, must-revalidate, max-age=0',
            'Pragma' => 'no-cache',
        ]);
    }

    return view('welcome');
})->where('any', '^(?!api(?:/|$)|up(?:/|$)).*');
