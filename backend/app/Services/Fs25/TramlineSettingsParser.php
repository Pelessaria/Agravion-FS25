<?php

namespace App\Services\Fs25;

/**
 * Reads per-farmland tramline settings out of a savegame precisionFarming.xml.
 *
 * Only rows that name a farmland and a working width are kept. A missing
 * direction is left empty so the map does not invent a heading.
 */
final class TramlineSettingsParser
{
    /**
     * @return array<string, array{width: float, direction: float|null, spacing: float}>
     */
    public static function fromXml(string $xml): array
    {
        $block = $xml;
        if (preg_match('/<tramlineMap\b[^>]*>(.*?)<\/tramlineMap>/is', $xml, $match) === 1) {
            $block = $match[1];
        }
        if (preg_match_all('/<(?:farmland|tramline|field)\b([^>]*?)\/?>/i', $block, $tags) < 1) {
            return [];
        }

        $out = [];
        foreach ($tags[1] as $attrs) {
            $width = self::floatAttr($attrs, 'workingWidth') ?? self::floatAttr($attrs, 'width');
            if ($width === null || $width < 8 || $width > 80) {
                continue;
            }
            $id = self::intAttr($attrs, 'farmlandId') ?? self::intAttr($attrs, 'id');
            if ($id === null || $id <= 0) {
                continue;
            }
            $enabled = self::attr($attrs, 'enabled');
            if ($enabled !== null && ($enabled === 'false' || $enabled === '0')) {
                continue;
            }
            $direction = self::floatAttr($attrs, 'workDirection') ?? self::floatAttr($attrs, 'direction');
            $spacing = self::floatAttr($attrs, 'spacing') ?? $width;
            if ($spacing < 8 || $spacing > 80) {
                continue;
            }
            $out[(string) $id] = [
                'width' => $width,
                'direction' => $direction,
                'spacing' => $spacing,
            ];
        }

        return $out;
    }

    private static function attr(string $blob, string $name): ?string
    {
        if (preg_match('/\b'.preg_quote($name, '/').'="([^"]*)"/', $blob, $match) !== 1) {
            return null;
        }

        return $match[1];
    }

    private static function floatAttr(string $blob, string $name): ?float
    {
        $raw = self::attr($blob, $name);
        if ($raw === null || ! is_numeric($raw)) {
            return null;
        }
        $value = (float) $raw;

        return is_finite($value) ? $value : null;
    }

    private static function intAttr(string $blob, string $name): ?int
    {
        $raw = self::attr($blob, $name);
        if ($raw === null || ! is_numeric($raw)) {
            return null;
        }

        return (int) $raw;
    }
}
