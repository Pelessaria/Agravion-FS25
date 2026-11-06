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
     *   year: int|null,
     *   dayInPeriod: int|null,
     *   daysPerPeriod: int|null,
     *   rain: float|null,
     *   clouds: float|null,
     *   humidity: float|null,
     *   fog: float|null,
     *   snow: float|null,
     *   vehicles: list<array<string, mixed>>,
     *   players: list<array<string, mixed>>,
     *   places: list<array<string, mixed>>,
     *   farms: list<array<string, mixed>>,
     *   hours: list<array<string, mixed>>,
     *   days: list<array<string, mixed>>
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
        $empty['year'] = self::intAttr($root['year'] ?? null);
        $empty['dayInPeriod'] = self::intAttr($root['dayInPeriod'] ?? null);
        $empty['daysPerPeriod'] = self::intAttr($root['daysPerPeriod'] ?? null);
        $empty['rain'] = self::floatAttr($root['rain'] ?? null);
        $empty['clouds'] = self::floatAttr($root['clouds'] ?? null);
        $empty['humidity'] = self::floatAttr($root['humidity'] ?? null);
        $empty['fog'] = self::floatAttr($root['fog'] ?? null);
        $empty['snow'] = self::floatAttr($root['snow'] ?? null);

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
                'controlled' => ((string) ($node['controlled'] ?? '')) === '1',
                'attachments' => self::text($node['attachments'] ?? null),
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
        foreach ($root->farm as $node) {
            $id = self::positiveInt($node['id'] ?? null);
            if ($id === null) {
                continue;
            }
            $color = self::text($node['color'] ?? null);
            if ($color !== null && ! preg_match('/^#[0-9A-Fa-f]{6}$/', $color)) {
                $color = null;
            }
            $empty['farms'][] = [
                'id' => $id,
                'name' => self::text($node['name'] ?? null),
                'color' => $color,
            ];
        }
        foreach ($root->hour as $node) {
            $empty['hours'][] = [
                'time' => self::intAttr($node['time'] ?? null),
                'type' => self::text($node['type'] ?? null),
                'temperature' => self::floatAttr($node['temperature'] ?? null),
                'windSpeed' => self::floatAttr($node['windSpeed'] ?? null),
            ];
        }
        foreach ($root->day as $node) {
            $empty['days'][] = [
                'day' => self::intAttr($node['day'] ?? null),
                'type' => self::text($node['type'] ?? null),
                'high' => self::floatAttr($node['high'] ?? null),
                'low' => self::floatAttr($node['low'] ?? null),
                'windSpeed' => self::floatAttr($node['windSpeed'] ?? null),
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
            'year' => null,
            'dayInPeriod' => null,
            'daysPerPeriod' => null,
            'rain' => null,
            'clouds' => null,
            'humidity' => null,
            'fog' => null,
            'snow' => null,
            'vehicles' => [],
            'players' => [],
            'places' => [],
            'farms' => [],
            'hours' => [],
            'days' => [],
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
