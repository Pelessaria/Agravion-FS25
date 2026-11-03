<?php

namespace App\Services\Fs25;

/**
 * Decides which installed mods appear anywhere in the savegame,
 * and which mods a map declares as dependencies.
 */
final class SavegameUsage
{
    /**
     * Mod stems referenced by any vehicle, placeable or item.
     * The owning farm does not matter: a dealer yard without players still counts as use.
     *
     * @return array<string, true>
     */
    public static function ownedModStems(string $xml): array
    {
        if (preg_match_all('/<(vehicle|placeable|item)\b([^>]*)>/i', $xml, $matches, PREG_SET_ORDER) < 1) {
            return [];
        }

        $found = [];
        foreach ($matches as $match) {
            $attrs = $match[2];
            $stem = null;
            if (preg_match('/\bmodName="([^"]+)"/i', $attrs, $name) === 1) {
                $stem = ModKey::clean(html_entity_decode($name[1], ENT_QUOTES | ENT_HTML5, 'UTF-8'));
            }
            if ($stem === null && preg_match('/\bfilename="([^"]*)"/i', $attrs, $file) === 1) {
                $stem = ModKey::fromFilename(html_entity_decode($file[1], ENT_QUOTES | ENT_HTML5, 'UTF-8'));
            }
            if ($stem !== null) {
                $found[strtolower($stem)] = true;
            }
        }

        return $found;
    }

    /**
     * @param  array<string, string>  $installed  lowercase stem => original stem
     */
    public static function mapStem(string $career, array $installed): ?string
    {
        $mapId = '';
        if (preg_match('/\bmapId="([^"]+)"/i', $career, $match) === 1) {
            $mapId = trim(html_entity_decode($match[1], ENT_QUOTES | ENT_HTML5, 'UTF-8'));
        } elseif (preg_match('/<mapId>([^<]+)<\/mapId>/i', $career, $match) === 1) {
            $mapId = trim(html_entity_decode($match[1], ENT_QUOTES | ENT_HTML5, 'UTF-8'));
        }
        if ($mapId === '') {
            return null;
        }
        $lower = strtolower($mapId);
        if (isset($installed[$lower])) {
            return $installed[$lower];
        }
        $head = strtolower((string) strtok($mapId, '.'));
        if ($head !== '' && isset($installed[$head])) {
            return $installed[$head];
        }

        return null;
    }

    /**
     * @return list<string>
     */
    public static function dependencies(string $modDesc): array
    {
        if (preg_match('/<dependencies\b[^>]*>(.*?)<\/dependencies>/is', $modDesc, $block) !== 1) {
            return [];
        }
        if (preg_match_all('/<dependency\b[^>]*>([^<]*)<\/dependency>/i', $block[1], $matches) < 1) {
            return [];
        }

        $names = [];
        foreach ($matches[1] as $name) {
            $clean = ModKey::clean(html_entity_decode(trim($name), ENT_QUOTES | ENT_HTML5, 'UTF-8'));
            if ($clean !== null) {
                $names[] = $clean;
            }
        }

        return $names;
    }

    public static function hasStoreItems(string $modDesc): bool
    {
        return stripos($modDesc, '<storeItem') !== false;
    }
}
