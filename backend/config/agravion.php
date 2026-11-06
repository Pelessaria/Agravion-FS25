<?php

return [
    /*
    |--------------------------------------------------------------------------
    | Product version (installed build)
    |--------------------------------------------------------------------------
    */
    'version' => env('AGRAVION_VERSION', env('AGRIVISION_VERSION', '0.3.0')),

    /*
    |--------------------------------------------------------------------------
    | Public GitHub source of truth (no Docker, shared-hosting first)
    |--------------------------------------------------------------------------
    |
    | The installer and in-app updater pull from this repository.
    | Optional token raises API rate limits; public repos work without it.
    | AGRIVISION_* env names remain as fallbacks during the rebrand.
    |
    */
    'github' => [
        'owner' => env('AGRAVION_GITHUB_OWNER', env('AGRIVISION_GITHUB_OWNER', 'Pelessaria')),
        'repo' => env('AGRAVION_GITHUB_REPO', env('AGRIVISION_GITHUB_REPO', 'Agravion-FS25')),
        'branch' => env('AGRAVION_GITHUB_BRANCH', env('AGRIVISION_GITHUB_BRANCH', 'main')),
        'token' => env('AGRAVION_GITHUB_TOKEN', env('AGRIVISION_GITHUB_TOKEN')),
    ],

    'updates' => [
        'enabled' => filter_var(
            env('AGRAVION_UPDATES_ENABLED', env('AGRIVISION_UPDATES_ENABLED', true)),
            FILTER_VALIDATE_BOOL
        ),
        /** Relative to storage/app */
        'work_dir' => 'updates',
        /** Paths under the Laravel root that must never be overwritten */
        'preserve' => [
            '.env',
            'storage',
            'bootstrap/cache',
            // Never clobber the running Laravel front controller via a bad overlay.
            'public/index.php',
        ],
        /** Path segments inside the zip that are never copied onto the host */
        'skip_zip_segments' => [
            'vendor',
            'node_modules',
            '.git',
            '.env',
            'storage',
            'composer.phar',
        ],
    ],
];
