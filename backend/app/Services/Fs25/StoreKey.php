<?php

namespace App\Services\Fs25;

/**
 * Stable vehicle store-icon key from config filename (type-level, not uniqueId).
 * Mirrors connector AgravionConnector:storeKeyFromFilename.
 */
final class StoreKey
{
    public static function fromFilename(?string $filename): ?string
    {
        if ($filename === null || trim($filename) === '') {
            return null;
        }

        $path = strtolower(str_replace('\\', '/', $filename));
        $path = str_replace('$moddir$', 'mod/', $path);
        $path = preg_replace('/\.xml$/i', '', $path) ?? $path;
        $path = preg_replace('/[^a-z0-9]+/', '_', $path) ?? $path;
        $path = trim($path, '_');
        if ($path === '') {
            return null;
        }
        if (strlen($path) > 96) {
            $path = substr($path, -96);
        }

        return $path;
    }
}
