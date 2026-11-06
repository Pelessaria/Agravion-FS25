<?php

namespace App\Services\Fs25;

/**
 * Parse connector state/vehicles_full.xml (uniqueId + farmId + storeKey/modKey).
 */
final class ConnectorVehiclesParser
{
    /**
     * @return list<array{
     *   uniqueId: string|null,
     *   farmId: int|null,
     *   filename: string|null,
     *   nameHint: string|null,
     *   name: string|null,
     *   category: string|null,
     *   operatingTime: float|null,
     *   storeKey: string|null,
     *   modKey: string|null,
     *   brand: string|null,
     *   brandKey: string|null,
     *   fuel: float|null,
     *   fuelCapacity: float|null,
     *   defLevel: float|null,
     *   defCapacity: float|null,
     *   wear: int|null,
     *   plate: string|null,
     *   x: float|null,
     *   y: float|null,
     *   z: float|null
     * }>
     */
    public static function parse(string $xml): array
    {
        $xml = trim($xml);
        if ($xml === '' || ! preg_match_all('/<vehicle\b([^>]*)\/?>/i', $xml, $matches)) {
            return [];
        }

        $vehicles = [];
        foreach ($matches[1] as $attrBlob) {
            $uniqueId = self::attr($attrBlob, 'uniqueId');
            $farmId = self::intAttr($attrBlob, 'farmId');
            if ($farmId !== null && $farmId <= 0) {
                $farmId = null;
            }
            $filename = self::attr($attrBlob, 'filename');
            $name = self::attr($attrBlob, 'name');
            $category = self::attr($attrBlob, 'category');
            $storeKey = self::attr($attrBlob, 'storeKey') ?? StoreKey::fromFilename($filename);
            $modKey = self::attr($attrBlob, 'modKey');
            $brand = self::attr($attrBlob, 'brand');
            $brandKey = self::attr($attrBlob, 'brandKey');
            if ($brandKey === null && is_string($brand) && $brand !== '') {
                $brandKey = strtolower((string) preg_replace('/[^a-zA-Z0-9._-]+/', '', $brand));
            }
            $fuel = self::floatAttr($attrBlob, 'fuel');
            $fuelCapacity = self::floatAttr($attrBlob, 'fuelCapacity');
            $defLevel = self::floatAttr($attrBlob, 'defLevel');
            $defCapacity = self::floatAttr($attrBlob, 'defCapacity');
            $wear = self::intAttr($attrBlob, 'wear');
            $plate = self::attr($attrBlob, 'plate');
            $operatingTime = self::floatAttr($attrBlob, 'operatingTime');
            $x = self::floatAttr($attrBlob, 'x');
            $y = self::floatAttr($attrBlob, 'y');
            $z = self::floatAttr($attrBlob, 'z');

            $vehicles[] = [
                'uniqueId' => $uniqueId,
                'farmId' => $farmId,
                'filename' => $filename,
                'nameHint' => VehiclesXmlParser::nameHintFromFilename($filename),
                'name' => $name,
                'category' => $category,
                'operatingTime' => $operatingTime,
                'storeKey' => $storeKey,
                'modKey' => $modKey,
                'brand' => $brand,
                'brandKey' => $brandKey,
                'fuel' => $fuel,
                'fuelCapacity' => $fuelCapacity,
                'defLevel' => $defLevel,
                'defCapacity' => $defCapacity,
                'wear' => $wear,
                'plate' => $plate,
                'x' => $x,
                'y' => $y,
                'z' => $z,
            ];
        }

        return $vehicles;
    }

    private static function attr(string $blob, string $key): ?string
    {
        if (! preg_match('/\b'.preg_quote($key, '/').'="([^"]*)"/i', $blob, $m)) {
            return null;
        }
        $value = trim(html_entity_decode($m[1], ENT_QUOTES | ENT_HTML5, 'UTF-8'));

        return $value === '' ? null : $value;
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
}
