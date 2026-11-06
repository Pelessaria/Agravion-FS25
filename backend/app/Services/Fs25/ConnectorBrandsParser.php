<?php

namespace App\Services\Fs25;

/**
 * Parse connector state/brands_manifest.xml.
 */
final class ConnectorBrandsParser
{
    /**
     * @return list<array{key: string, name: string|null, isMod: bool, iconFile: string}>
     */
    public static function parse(string $xml): array
    {
        $xml = trim($xml);
        if ($xml === '' || ! preg_match_all('/<brand\b([^>]*)\/?>/i', $xml, $matches, PREG_SET_ORDER)) {
            return [];
        }

        $entries = [];
        foreach ($matches as $match) {
            $attrBlob = $match[1];
            $key = self::attr($attrBlob, 'key');
            $iconFile = self::attr($attrBlob, 'iconFile');
            if ($key === null || $iconFile === null) {
                continue;
            }
            $isMod = strtolower((string) (self::attr($attrBlob, 'isMod') ?? '')) === 'true';
            $entries[] = [
                'key' => $key,
                'name' => self::attr($attrBlob, 'name'),
                'isMod' => $isMod,
                'iconFile' => $iconFile,
            ];
        }

        return $entries;
    }

    private static function attr(string $blob, string $key): ?string
    {
        if (! preg_match('/\b'.preg_quote($key, '/').'="([^"]*)"/i', $blob, $m)) {
            return null;
        }
        $value = trim(html_entity_decode($m[1], ENT_QUOTES | ENT_HTML5, 'UTF-8'));

        return $value === '' ? null : $value;
    }
}
