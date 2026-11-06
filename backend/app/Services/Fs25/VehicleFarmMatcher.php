<?php

namespace App\Services\Fs25;

/**
 * Merge live stats vehicles with savegame / connector meta (farmId, uniqueId, hours).
 *
 * Inventory source of truth = savegame (or connector) rows that carry farmId.
 * Stats supply fresher name/category/position when a match is found.
 */
final class VehicleFarmMatcher
{
    /** Max horizontal metres between stats position and savegame component. */
    private const MAX_DISTANCE = 250.0;

    /**
     * @param  list<array{name: string|null, category: string|null, type: string|null, x: float|null, y: float|null, z: float|null}>  $statsVehicles
     * @param  list<array{uniqueId: string|null, farmId: int|null, filename: string|null, nameHint: string|null, operatingTime: float|null, x: float|null, y: float|null, z: float|null, storeKey?: string|null, modKey?: string|null, name?: string|null, category?: string|null}>  $metaVehicles
     * @return list<array{name: string|null, category: string|null, type: string|null, x: float|null, y: float|null, z: float|null, farmId: int|null, uniqueId: string|null, hours: float|null, filename: string|null, storeKey: string|null, modKey: string|null}>
     */
    public static function mergeInventory(array $statsVehicles, array $metaVehicles): array
    {
        if ($metaVehicles === []) {
            return self::statsOnly($statsVehicles);
        }

        $pairs = [];
        foreach ($metaVehicles as $mi => $meta) {
            foreach ($statsVehicles as $si => $stats) {
                $score = self::score($stats, $meta);
                if ($score === null) {
                    continue;
                }
                $pairs[] = ['mi' => $mi, 'si' => $si, 'score' => $score];
            }
        }

        usort($pairs, static fn (array $a, array $b): int => $b['score'] <=> $a['score']);

        $usedMeta = [];
        $usedStats = [];
        $match = [];
        foreach ($pairs as $pair) {
            $mi = $pair['mi'];
            $si = $pair['si'];
            if (isset($usedMeta[$mi]) || isset($usedStats[$si])) {
                continue;
            }
            $usedMeta[$mi] = true;
            $usedStats[$si] = true;
            $match[$mi] = $statsVehicles[$si];
        }

        $out = [];
        foreach ($metaVehicles as $mi => $meta) {
            $stats = $match[$mi] ?? null;
            $hint = $meta['nameHint'] ?? VehiclesXmlParser::nameHintFromFilename($meta['filename'] ?? null);
            $name = $stats['name'] ?? $meta['name'] ?? $hint;
            $filename = $meta['filename'] ?? null;
            $out[] = [
                'name' => $name,
                'category' => $stats['category'] ?? ($meta['category'] ?? null),
                'type' => $stats['type'] ?? null,
                'x' => $stats['x'] ?? ($meta['x'] ?? null),
                'y' => $stats['y'] ?? ($meta['y'] ?? null),
                'z' => $stats['z'] ?? ($meta['z'] ?? null),
                'farmId' => $meta['farmId'] ?? null,
                'uniqueId' => $meta['uniqueId'] ?? null,
                'hours' => isset($meta['operatingTime']) && is_numeric($meta['operatingTime'])
                    ? round((float) $meta['operatingTime'], 1)
                    : null,
                'filename' => $filename,
                'storeKey' => $meta['storeKey'] ?? StoreKey::fromFilename(is_string($filename) ? $filename : null),
                'modKey' => $meta['modKey'] ?? null,
                'brand' => isset($meta['brand']) && is_string($meta['brand']) && $meta['brand'] !== '' ? $meta['brand'] : null,
                'brandKey' => isset($meta['brandKey']) && is_string($meta['brandKey']) && $meta['brandKey'] !== '' ? $meta['brandKey'] : null,
                'fuel' => self::nullableNumber($meta['fuel'] ?? null),
                'fuelCapacity' => self::nullableNumber($meta['fuelCapacity'] ?? null),
                'defLevel' => self::nullableNumber($meta['defLevel'] ?? null),
                'defCapacity' => self::nullableNumber($meta['defCapacity'] ?? null),
                'wear' => self::nullableNumber($meta['wear'] ?? null),
                'plate' => isset($meta['plate']) && is_string($meta['plate']) && $meta['plate'] !== '' ? $meta['plate'] : null,
            ];
        }

        return $out;
    }

    /**
     * @deprecated Prefer mergeInventory (savegame-first). Kept for tests / fallback.
     *
     * @param  list<array{name: string|null, category: string|null, type: string|null, x: float|null, y: float|null, z: float|null}>  $statsVehicles
     * @param  list<array{uniqueId: string|null, farmId: int|null, filename: string|null, nameHint: string|null, operatingTime: float|null, x: float|null, y: float|null, z: float|null}>  $saveVehicles
     * @return list<array{name: string|null, category: string|null, type: string|null, x: float|null, y: float|null, z: float|null, farmId: int|null, uniqueId: string|null, hours: float|null, filename: string|null, storeKey: string|null, modKey: string|null}>
     */
    public static function enrich(array $statsVehicles, array $saveVehicles): array
    {
        if ($saveVehicles !== []) {
            return self::mergeInventory($statsVehicles, $saveVehicles);
        }

        return self::statsOnly($statsVehicles);
    }

    /**
     * @param  list<array{name: string|null, category: string|null, type: string|null, x: float|null, y: float|null, z: float|null}>  $statsVehicles
     * @return list<array{name: string|null, category: string|null, type: string|null, x: float|null, y: float|null, z: float|null, farmId: int|null, uniqueId: string|null, hours: float|null, filename: string|null, storeKey: string|null, modKey: string|null}>
     */
    private static function statsOnly(array $statsVehicles): array
    {
        $out = [];
        foreach ($statsVehicles as $stats) {
            $out[] = [
                'name' => $stats['name'] ?? null,
                'category' => $stats['category'] ?? null,
                'type' => $stats['type'] ?? null,
                'x' => $stats['x'] ?? null,
                'y' => $stats['y'] ?? null,
                'z' => $stats['z'] ?? null,
                'farmId' => null,
                'uniqueId' => null,
                'hours' => null,
                'filename' => null,
                'storeKey' => null,
                'modKey' => null,
                'brand' => null,
                'fuel' => null,
                'fuelCapacity' => null,
                'defLevel' => null,
                'defCapacity' => null,
                'wear' => null,
                'plate' => null,
            ];
        }

        return $out;
    }

    /**
     * @param  array{name: string|null, category: string|null, type: string|null, x: float|null, y: float|null, z: float|null}  $stats
     * @param  array{uniqueId: string|null, farmId: int|null, filename: string|null, nameHint: string|null, operatingTime: float|null, x: float|null, y: float|null, z: float|null, name?: string|null}  $meta
     */
    private static function score(array $stats, array $meta): ?float
    {
        $hasStatsPos = isset($stats['x'], $stats['z']) && $stats['x'] !== null && $stats['z'] !== null;
        $hasMetaPos = isset($meta['x'], $meta['z']) && $meta['x'] !== null && $meta['z'] !== null;

        $distanceScore = 0.0;
        if ($hasStatsPos && $hasMetaPos) {
            $dx = (float) $stats['x'] - (float) $meta['x'];
            $dz = (float) $stats['z'] - (float) $meta['z'];
            $dist = sqrt(($dx * $dx) + ($dz * $dz));
            if ($dist > self::MAX_DISTANCE) {
                // Still allow strong name matches for vehicles that moved far since last save.
                $nameOnly = self::nameScore(
                    $stats['name'] ?? null,
                    $meta['name'] ?? ($meta['nameHint'] ?? null),
                    $meta['filename'] ?? null
                );
                if ($nameOnly < 30.0) {
                    return null;
                }

                return $nameOnly;
            }
            $distanceScore = (self::MAX_DISTANCE - $dist) * 4.0;
        }

        $nameScore = self::nameScore(
            $stats['name'] ?? null,
            $meta['name'] ?? ($meta['nameHint'] ?? null),
            $meta['filename'] ?? null
        );

        if ($distanceScore <= 0.0 && $nameScore < 18.0) {
            return null;
        }

        return $distanceScore + $nameScore;
    }

    private static function nameScore(?string $statsName, ?string $hint, ?string $filename): float
    {
        $statsName = self::normalizeName($statsName);
        if ($statsName === '') {
            return 0.0;
        }

        $hint = self::normalizeName($hint);
        $file = self::normalizeName($filename);
        if ($hint !== '' && ($hint === $statsName || str_contains($hint, $statsName) || str_contains($statsName, $hint))) {
            return 45.0;
        }
        if ($file !== '' && str_contains($file, $statsName)) {
            return 35.0;
        }

        $tokens = preg_split('/[^a-z0-9]+/', $statsName) ?: [];
        $tokens = array_values(array_filter($tokens, static fn (string $t): bool => strlen($t) >= 3));
        if ($tokens === []) {
            return 0.0;
        }
        $hay = $hint.' '.$file;
        $hits = 0;
        foreach ($tokens as $token) {
            if (str_contains($hay, $token)) {
                $hits++;
            }
        }
        if ($hits === 0) {
            return 0.0;
        }

        return 14.0 * $hits;
    }

    private static function nullableNumber(mixed $value): ?float
    {
        if (! is_numeric($value)) {
            return null;
        }

        return (float) $value;
    }

    private static function normalizeName(?string $value): string
    {
        if ($value === null) {
            return '';
        }

        return strtolower(preg_replace('/[^a-z0-9]+/i', '', $value) ?? '');
    }
}
