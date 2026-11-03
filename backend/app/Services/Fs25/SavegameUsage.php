<?php

namespace App\Services\Fs25;

/**
 * Decides which installed mods are actually bought or placed on a player farm,
 * and which mods a map declares as dependencies.
 */
final class SavegameUsage
{
    /**
     * Farms that have at least one player. Dealer and placeable farms without
     * a player do not count as "bought".
     *
     * @return list<int>
     */
    public static function playerFarmIds(string $xml): array
    {
        if (preg_match_all('/<farm\b([^>]*)>(.*?)<\/farm>/is', $xml, $matches, PREG_SET_ORDER) < 1) {
            return [];
        }

        $ids = [];
        foreach ($matches as $match) {
            if (preg_match('/<player\b/i', $match[2]) !== 1) {
                continue;
            }
            if (preg_match('/\bfarmId="(\d+)"/i', $match[1], $id) !== 1) {
                continue;
            }
            $ids[] = (int) $id[1];
        }

        return array_values(array_unique($ids));
    }

    /**
     * Mod stems referenced by a vehicle, placeable or item that belongs to a player farm.
     * Traffic and dealer stock (propertyState NONE, or a farm without players) is ignored.
     *
     * @param  list<int>  $playerFarms
     * @return array<string, true>
     */
    public static function ownedModStems(string $xml, array $playerFarms): array
    {
        $allowed = [];
        foreach ($playerFarms as $id) {
            $allowed[(int) $id] = true;
        }
        if ($allowed === [] || preg_match_all('/<(vehicle|placeable|item)\b([^>]*)>/i', $xml, $matches, PREG_SET_ORDER) < 1) {
            return [];
        }

        $found = [];
        foreach ($matches as $match) {
            $tag = strtolower($match[1]);
            $attrs = $match[2];
            if (preg_match('/\bfarmId="(\d+)"/i', $attrs, $farm) !== 1 || ! isset($allowed[(int) $farm[1]])) {
                continue;
            }
            if ($tag === 'vehicle' && preg_match('/\bpropertyState="([^"]*)"/i', $attrs, $state) === 1 && strcasecmp($state[1], 'NONE') === 0) {
                continue;
            }
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
