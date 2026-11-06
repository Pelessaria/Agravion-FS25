<?php

namespace App\Services\Fs25;

/**
 * Parse connector field geometry, field state, and fruit-icon manifest.
 * Missing attributes stay null — the UI shows them as unavailable.
 */
final class ConnectorFieldsParser
{
    /**
     * @return array{
     *   mapSize: int|null,
     *   mapFrame: array{worldX: float, worldZ: float, originX: float, originZ: float, scaleX: float, scaleZ: float, padX: float, padZ: float}|null,
     *   precisionFarming: bool|null,
     *   geometryAt: string|null,
     *   stateAt: string|null,
     *   fields: list<array<string, mixed>>
     * }
     */
    public static function merge(string $geometryXml, string $stateXml): array
    {
        $geometry = self::fields($geometryXml);
        $state = self::fields($stateXml);
        $ids = array_values(array_unique(array_merge(array_keys($geometry), array_keys($state))));
        usort($ids, static fn (int $a, int $b): int => $a <=> $b);

        $fields = [];
        foreach ($ids as $id) {
            $geo = $geometry[$id] ?? [];
            $row = $state[$id] ?? [];
            $points = $geo['points'] ?? [];
            $centerX = $geo['centerX'] ?? null;
            $centerZ = $geo['centerZ'] ?? null;
            if (($centerX === null || $centerZ === null) && is_array($points) && count($points) >= 3) {
                $sx = 0.0;
                $sz = 0.0;
                foreach ($points as $point) {
                    $sx += $point[0];
                    $sz += $point[1];
                }
                $centerX ??= $sx / count($points);
                $centerZ ??= $sz / count($points);
            }

            $fields[] = [
                'id' => $id,
                'centerX' => $centerX,
                'centerZ' => $centerZ,
                'labelX' => $geo['labelX'] ?? null,
                'labelZ' => $geo['labelZ'] ?? null,
                'areaHa' => $row['areaHa'] ?? $geo['areaHa'] ?? null,
                'points' => is_array($points) ? $points : [],
                'holes' => is_array($geo['holes'] ?? null) ? $geo['holes'] : [],
                'group' => $geo['group'] ?? null,
                'farmId' => $row['farmId'] ?? null,
                'farmlandId' => $row['farmlandId'] ?? null,
                'owned' => $row['owned'] ?? null,
                'fruitName' => $row['fruitName'] ?? null,
                'fruitTitle' => $row['fruitTitle'] ?? null,
                'fruitIcon' => $row['fruitIcon'] ?? null,
                'growth' => $row['growth'] ?? null,
                'growthMax' => $row['growthMax'] ?? null,
                'harvestMin' => $row['harvestMin'] ?? null,
                'harvestMax' => $row['harvestMax'] ?? null,
                'harvestMonths' => $row['harvestMonths'] ?? null,
                'crop' => $row['crop'] ?? null,
                'ground' => $row['ground'] ?? null,
                'weed' => $row['weed'] ?? null,
                'weedFactor' => $row['weedFactor'] ?? null,
                'stones' => $row['stones'] ?? null,
                'spray' => $row['spray'] ?? null,
                'sprayType' => $row['sprayType'] ?? null,
                'lime' => $row['lime'] ?? null,
                'roller' => $row['roller'] ?? null,
                'plow' => $row['plow'] ?? null,
                'stubble' => $row['stubble'] ?? null,
                'water' => $row['water'] ?? null,
                'scanned' => $row['scanned'] ?? null,
                'nitrogen' => $row['nitrogen'] ?? null,
                'nitrogenTarget' => $row['nitrogenTarget'] ?? null,
                'ph' => $row['ph'] ?? null,
                'phTarget' => $row['phTarget'] ?? null,
                'soil' => $row['soil'] ?? null,
                'soilName' => $row['soilName'] ?? null,
                'precisionGrid' => $row['precisionGrid'] ?? null,
                'tramline' => $row['tramline'] ?? null,
            ];
        }

        return [
            'mapSize' => self::intRoot($geometryXml, 'mapSize'),
            'mapFrame' => self::mapFrame($geometryXml),
            'precisionFarming' => self::boolRoot($stateXml, 'precisionFarming'),
            'geometryAt' => self::root($geometryXml, 'writtenAtUtc'),
            'stateAt' => self::root($stateXml, 'writtenAtUtc'),
            'fields' => $fields,
        ];
    }

    /**
     * @return list<array{key: string, iconFile: string}>
     */
    public static function fruitIcons(string $xml): array
    {
        if (! preg_match_all('/<fruit\b([^>]*)\/?>/i', $xml, $matches)) {
            return [];
        }

        $icons = [];
        foreach ($matches[1] as $blob) {
            $key = self::safeKey(self::attr($blob, 'key') ?? '');
            $iconFile = self::attr($blob, 'iconFile');
            if ($key === null || $iconFile === null || str_contains($iconFile, '..')) {
                continue;
            }
            $iconFile = ltrim(str_replace('\\', '/', $iconFile), '/');
            if (! str_starts_with($iconFile, 'icons/fruits/')) {
                continue;
            }
            $icons[] = ['key' => $key, 'iconFile' => $iconFile];
        }

        return $icons;
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    private static function fields(string $xml): array
    {
        $xml = trim($xml);
        if ($xml === '' || ! preg_match_all('/<field\b([^>]*)\/?>/i', $xml, $matches)) {
            return [];
        }

        $rows = [];
        foreach ($matches[1] as $blob) {
            $id = self::intAttr($blob, 'id');
            if ($id === null || $id <= 0) {
                continue;
            }
            $rows[$id] = [
                'centerX' => self::floatAttr($blob, 'cx'),
                'centerZ' => self::floatAttr($blob, 'cz'),
                'labelX' => self::floatAttr($blob, 'lx'),
                'labelZ' => self::floatAttr($blob, 'lz'),
                'areaHa' => self::floatAttr($blob, 'areaHa'),
                'points' => self::points(self::attr($blob, 'points')),
                'holes' => self::rings(self::attr($blob, 'holes')),
                'group' => self::idList(self::attr($blob, 'group')),
                'farmId' => self::positiveInt(self::intAttr($blob, 'farmId')),
                'farmlandId' => self::positiveInt(self::intAttr($blob, 'farmlandId')),
                'owned' => self::boolAttr($blob, 'owned'),
                'fruitName' => self::attr($blob, 'fruit'),
                'fruitTitle' => self::attr($blob, 'fruitTitle'),
                'fruitIcon' => self::safeKey(self::attr($blob, 'fruitIcon') ?? ''),
                'growth' => self::intAttr($blob, 'growth'),
                'growthMax' => self::intAttr($blob, 'growthMax'),
                'harvestMin' => self::intAttr($blob, 'harvestMin'),
                'harvestMax' => self::intAttr($blob, 'harvestMax'),
                'harvestMonths' => self::monthList(self::attr($blob, 'harvestMonths')),
                'crop' => self::attr($blob, 'crop'),
                'ground' => self::intAttr($blob, 'ground'),
                'weed' => self::intAttr($blob, 'weed'),
                'weedFactor' => self::floatAttr($blob, 'weedFactor'),
                'stones' => self::intAttr($blob, 'stones'),
                'spray' => self::intAttr($blob, 'spray'),
                'sprayType' => self::intAttr($blob, 'sprayType'),
                'lime' => self::intAttr($blob, 'lime'),
                'roller' => self::intAttr($blob, 'roller'),
                'plow' => self::intAttr($blob, 'plow'),
                'stubble' => self::intAttr($blob, 'stubble'),
                'water' => self::intAttr($blob, 'water'),
                'scanned' => self::boolAttr($blob, 'scanned'),
                'nitrogen' => self::floatAttr($blob, 'n'),
                'nitrogenTarget' => self::floatAttr($blob, 'nTarget'),
                'ph' => self::floatAttr($blob, 'ph'),
                'phTarget' => self::floatAttr($blob, 'phTarget'),
                'soil' => self::intAttr($blob, 'soil'),
                'soilName' => self::attr($blob, 'soilName'),
                'precisionGrid' => self::precisionGrid(self::attr($blob, 'pf')),
                'tramline' => self::tramline(self::attr($blob, 'tram')),
            ];
        }

        return $rows;
    }

    /**
     * @return list<array{0: float, 1: float}>
     */
    private static function points(?string $raw): array
    {
        if ($raw === null || $raw === '') {
            return [];
        }

        $points = [];
        foreach (preg_split('/\s+/', trim($raw)) ?: [] as $pair) {
            $bits = explode(',', $pair, 2);
            if (count($bits) < 2 || ! is_numeric($bits[0]) || ! is_numeric($bits[1])) {
                continue;
            }
            $points[] = [(float) $bits[0], (float) $bits[1]];
            if (count($points) >= 160) {
                break;
            }
        }

        return $points;
    }

    /**
     * @return list<list<array{0: float, 1: float}>>
     */
    private static function rings(?string $raw): array
    {
        if ($raw === null || $raw === '') {
            return [];
        }

        $rings = [];
        foreach (explode(';', $raw) as $ring) {
            $points = self::points($ring);
            if (count($points) >= 3) {
                $rings[] = $points;
            }
        }

        return $rings;
    }

    private static function root(string $xml, string $name): ?string
    {
        if (! preg_match('/<(?:fieldsGeometry|fieldsState|fruitsManifest)\b([^>]*)>/i', $xml, $m)) {
            return null;
        }

        return self::attr($m[1], $name);
    }

    /**
     * @return array{step: float, cells: list<array{x: float, z: float, ph: float|null, n: float|null}>}|null
     */
    /**
     * @return array{width: float, direction: float, spacing: float}|null
     */
    private static function tramline(?string $raw): ?array
    {
        if ($raw === null || $raw === '') {
            return null;
        }
        $parts = explode(',', $raw);
        if (count($parts) < 2 || ! is_numeric($parts[0]) || ! is_numeric($parts[1])) {
            return null;
        }
        $width = (float) $parts[0];
        $direction = (float) $parts[1];
        $spacing = isset($parts[2]) && is_numeric($parts[2]) ? (float) $parts[2] : $width;
        if ($spacing < 8 || $spacing > 80) {
            $spacing = $width;
        }
        if ($width < 8 || $width > 80 || ! is_finite($direction)) {
            return null;
        }

        return [
            'width' => $width,
            'direction' => $direction,
            'spacing' => $spacing,
        ];
    }

    private static function precisionGrid(?string $raw): ?array
    {
        if ($raw === null || ! str_contains($raw, '|')) {
            return null;
        }
        [$stepText, $body] = explode('|', $raw, 2);
        $step = (float) $stepText;
        if ($step < 1 || $body === '') {
            return null;
        }
        $cells = [];
        foreach (explode(';', $body) as $piece) {
            $bits = explode(',', $piece);
            if (count($bits) < 4 || ! is_numeric($bits[0]) || ! is_numeric($bits[1])) {
                continue;
            }
            $cells[] = [
                'x' => (float) $bits[0],
                'z' => (float) $bits[1],
                'ph' => $bits[2] === '' || ! is_numeric($bits[2]) ? null : (float) $bits[2],
                'n' => $bits[3] === '' || ! is_numeric($bits[3]) ? null : (float) $bits[3],
            ];
            if (count($cells) >= 64) {
                break;
            }
        }
        if ($cells === []) {
            return null;
        }

        return ['step' => $step, 'cells' => $cells];
    }

    /**
     * @return array{worldX: float, worldZ: float, originX: float, originZ: float, scaleX: float, scaleZ: float, padX: float, padZ: float}|null
     */
    private static function mapFrame(string $xml): ?array
    {
        $worldX = self::floatRoot($xml, 'mapWorldX');
        $worldZ = self::floatRoot($xml, 'mapWorldZ');
        $scaleX = self::floatRoot($xml, 'mapScaleX');
        $scaleZ = self::floatRoot($xml, 'mapScaleZ');
        $padX = self::floatRoot($xml, 'mapPadX');
        $padZ = self::floatRoot($xml, 'mapPadZ');
        if ($worldX === null || $worldZ === null || $worldX <= 1 || $worldZ <= 1) {
            return null;
        }
        if ($scaleX === null || $scaleZ === null || $padX === null || $padZ === null) {
            return null;
        }
        if ($scaleX <= 0 || $scaleZ <= 0 || $scaleX > 1.5 || $scaleZ > 1.5) {
            return null;
        }

        return [
            'worldX' => $worldX,
            'worldZ' => $worldZ,
            'originX' => self::floatRoot($xml, 'mapOriginX') ?? ($worldX / 2),
            'originZ' => self::floatRoot($xml, 'mapOriginZ') ?? ($worldZ / 2),
            'scaleX' => $scaleX,
            'scaleZ' => $scaleZ,
            'padX' => $padX,
            'padZ' => $padZ,
        ];
    }

    private static function floatRoot(string $xml, string $name): ?float
    {
        $raw = self::root($xml, $name);
        if ($raw === null || ! is_numeric($raw)) {
            return null;
        }

        return (float) $raw;
    }

    private static function intRoot(string $xml, string $name): ?int
    {
        $raw = self::root($xml, $name);
        if ($raw === null || ! is_numeric($raw)) {
            return null;
        }
        $value = (int) $raw;

        return $value > 0 ? $value : null;
    }

    private static function boolRoot(string $xml, string $name): ?bool
    {
        $raw = self::root($xml, $name);
        if ($raw === null) {
            return null;
        }

        return $raw === '1' || strcasecmp($raw, 'true') === 0;
    }

    private static function attr(string $blob, string $key): ?string
    {
        if (! preg_match('/\b'.preg_quote($key, '/').'="([^"]*)"/i', $blob, $m)) {
            return null;
        }
        $value = trim(html_entity_decode($m[1], ENT_QUOTES | ENT_HTML5, 'UTF-8'));

        return $value === '' ? null : $value;
    }

    /**
     * @return list<int>|null
     */
    private static function idList(?string $value): ?array
    {
        if ($value === null || trim($value) === '') {
            return null;
        }
        $ids = [];
        foreach (preg_split('/\s+/', trim($value)) ?: [] as $part) {
            if (preg_match('/^\d+$/', $part) === 1) {
                $id = (int) $part;
                if ($id > 0) {
                    $ids[] = $id;
                }
            }
        }

        return count($ids) >= 2 ? $ids : null;
    }

    /**
     * @return list<int>|null
     */
    private static function monthList(?string $raw): ?array
    {
        if ($raw === null || trim($raw) === '') {
            return null;
        }
        $months = [];
        foreach (preg_split('/\s*,\s*/', trim($raw)) ?: [] as $part) {
            if (! is_numeric($part)) {
                continue;
            }
            $month = (int) $part;
            if ($month >= 1 && $month <= 12) {
                $months[$month] = $month;
            }
        }
        if ($months === []) {
            return null;
        }
        $values = array_values($months);
        sort($values);

        return $values;
    }

    private static function intAttr(string $blob, string $key): ?int
    {
        $raw = self::attr($blob, $key);
        if ($raw === null || ! is_numeric($raw)) {
            return null;
        }

        return (int) $raw;
    }

    private static function floatAttr(string $blob, string $key): ?float
    {
        $raw = self::attr($blob, $key);
        if ($raw === null || ! is_numeric($raw)) {
            return null;
        }

        return (float) $raw;
    }

    private static function boolAttr(string $blob, string $key): ?bool
    {
        $raw = self::attr($blob, $key);
        if ($raw === null) {
            return null;
        }

        return $raw === '1' || strcasecmp($raw, 'true') === 0;
    }

    private static function positiveInt(?int $value): ?int
    {
        if ($value === null || $value <= 0) {
            return null;
        }

        return $value;
    }

    private static function safeKey(string $key): ?string
    {
        $key = strtolower($key);
        if (! preg_match('/^[a-z0-9_-]{1,64}$/', $key)) {
            return null;
        }

        return $key;
    }
}
