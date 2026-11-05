<?php

namespace App\Services\Fs25;

use SimpleXMLElement;

/**
 * Parse connector state/storage_state.xml. Missing numbers stay null.
 */
final class ConnectorStorageParser
{
    /**
     * @return array{writtenAt: string|null, places: list<array<string, mixed>>}
     */
    public static function parse(string $xml): array
    {
        $empty = ['writtenAt' => null, 'places' => []];
        if (trim($xml) === '') {
            return $empty;
        }

        $previous = libxml_use_internal_errors(true);
        $root = simplexml_load_string($xml);
        libxml_clear_errors();
        libxml_use_internal_errors($previous);
        if (! $root instanceof SimpleXMLElement) {
            return $empty;
        }

        $places = [];
        foreach ($root->bin as $node) {
            $id = self::text($node['id'] ?? null);
            if ($id === null) {
                continue;
            }
            $places[$id] = [
                'id' => $id,
                'kind' => self::text($node['kind'] ?? null),
                'farmId' => self::positiveInt($node['farmId'] ?? null),
                'name' => self::text($node['name'] ?? null),
                'foreign' => self::text($node['foreign'] ?? null) === '1',
                'level' => self::float($node['level'] ?? null),
                'capacity' => self::float($node['capacity'] ?? null),
                'used' => self::float($node['used'] ?? null),
                'slots' => self::float($node['slots'] ?? null),
                'x' => self::float($node['x'] ?? null),
                'z' => self::float($node['z'] ?? null),
                'storeKey' => self::text($node['storeKey'] ?? null),
                'fills' => [],
            ];
        }

        foreach ($root->fill as $node) {
            $bin = self::text($node['bin'] ?? null);
            if ($bin === null || ! isset($places[$bin])) {
                continue;
            }
            $places[$bin]['fills'][] = [
                'fillType' => self::text($node['fillType'] ?? null),
                'title' => self::text($node['title'] ?? null),
                'level' => self::float($node['level'] ?? null),
                'capacity' => self::float($node['capacity'] ?? null),
                'count' => self::float($node['count'] ?? null),
            ];
        }

        return [
            'writtenAt' => self::text($root['writtenAtUtc'] ?? null),
            'places' => array_values($places),
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

    private static function float(mixed $value): ?float
    {
        $text = self::text($value);
        if ($text === null || ! is_numeric($text)) {
            return null;
        }

        return (float) $text;
    }

    private static function positiveInt(mixed $value): ?int
    {
        $number = self::float($value);
        if ($number === null || $number <= 0) {
            return null;
        }

        return (int) $number;
    }
}
