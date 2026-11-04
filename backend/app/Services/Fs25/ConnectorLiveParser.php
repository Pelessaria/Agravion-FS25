<?php

namespace App\Services\Fs25;

/**
 * Reads state/live_map.xml. Missing numbers stay null; nothing is filled in.
 */
final class ConnectorLiveParser
{
    /**
     * @return array{
     *   writtenAt: string|null,
     *   day: int|null,
     *   period: int|null,
     *   dayTime: int|null,
     *   timeScale: float|null,
     *   paused: bool,
     *   weather: string|null,
     *   temperature: float|null,
     *   windSpeed: float|null,
     *   windDirection: float|null,
     *   vehicles: list<array<string, mixed>>,
     *   players: list<array<string, mixed>>,
     *   places: list<array<string, mixed>>
     * }
     */
    public static function parse(string $xml): array
    {
        $empty = self::blank();
        $root = simplexml_load_string($xml);
        if ($root === false) {
            return $empty;
        }

        $empty['writtenAt'] = self::text($root['timestamp'] ?? null);
        $empty['day'] = self::intAttr($root['day'] ?? null);
        $empty['period'] = self::intAttr($root['period'] ?? null);
        $empty['dayTime'] = self::intAttr($root['dayTime'] ?? null);
        $empty['timeScale'] = self::floatAttr($root['timeScale'] ?? null);
        $empty['paused'] = ((string) ($root['paused'] ?? '')) === '1';
        $empty['weather'] = self::text($root['weather'] ?? null);
        $empty['temperature'] = self::floatAttr($root['temperature'] ?? null);
        $empty['windSpeed'] = self::floatAttr($root['windSpeed'] ?? null);
        $empty['windDirection'] = self::floatAttr($root['windDirection'] ?? null);

        foreach ($root->vehicle as $node) {
            $x = self::floatAttr($node['x'] ?? null);
            $z = self::floatAttr($node['z'] ?? null);
            if ($x === null || $z === null) {
                continue;
            }
            $empty['vehicles'][] = [
                'id' => self::text($node['id'] ?? null) ?? '',
                'name' => self::text($node['name'] ?? null),
                'farmId' => self::positiveInt($node['farmId'] ?? null),
                'x' => $x,
                'z' => $z,
                'heading' => self::floatAttr($node['heading'] ?? null),
                'ai' => ((string) ($node['ai'] ?? '')) === '1',
                'driver' => self::text($node['driver'] ?? null),
            ];
        }
        foreach ($root->player as $node) {
            $x = self::floatAttr($node['x'] ?? null);
            $z = self::floatAttr($node['z'] ?? null);
            if ($x === null || $z === null) {
                continue;
            }
            $empty['players'][] = [
                'id' => self::text($node['id'] ?? null) ?? '',
                'name' => self::text($node['name'] ?? null),
                'x' => $x,
                'z' => $z,
                'heading' => self::floatAttr($node['heading'] ?? null),
            ];
        }
        foreach ($root->place as $node) {
            $x = self::floatAttr($node['x'] ?? null);
            $z = self::floatAttr($node['z'] ?? null);
            if ($x === null || $z === null) {
                continue;
            }
            $empty['places'][] = [
                'id' => self::text($node['id'] ?? null) ?? '',
                'name' => self::text($node['name'] ?? null),
                'type' => self::text($node['type'] ?? null),
                'farmId' => self::positiveInt($node['farmId'] ?? null),
                'x' => $x,
                'z' => $z,
            ];
        }

        return $empty;
    }

    /**
     * @return array<string, mixed>
     */
    public static function blank(): array
    {
        return [
            'writtenAt' => null,
            'day' => null,
            'period' => null,
            'dayTime' => null,
            'timeScale' => null,
            'paused' => false,
            'weather' => null,
            'temperature' => null,
            'windSpeed' => null,
            'windDirection' => null,
            'vehicles' => [],
            'players' => [],
            'places' => [],
        ];
    }

    private static function text(mixed $value): ?string
    {
        if ($value === null) {
            return null;
        }
        $text = trim((string) $value);

        return $text === '' ? null : $text;
    }

    private static function floatAttr(mixed $value): ?float
    {
        $text = self::text($value);
        if ($text === null || ! is_numeric($text)) {
            return null;
        }
        $number = (float) $text;

        return is_finite($number) ? $number : null;
    }

    private static function intAttr(mixed $value): ?int
    {
        $text = self::text($value);
        if ($text === null || ! is_numeric($text)) {
            return null;
        }

        return (int) $text;
    }

    private static function positiveInt(mixed $value): ?int
    {
        $number = self::intAttr($value);

        return $number !== null && $number > 0 ? $number : null;
    }
}
