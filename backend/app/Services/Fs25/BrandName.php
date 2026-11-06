<?php

namespace App\Services\Fs25;

/**
 * Official store brand when the connector sends one, otherwise a name
 * recovered from the mod folder or vehicle path.
 */
final class BrandName
{
    /** @var array<string, string> */
    private const LABELS = [
        'MASSEYFERGUSON' => 'Massey Ferguson',
        'SCHUITEMAKER' => 'Schuitemaker',
        'ROSTSELMASH' => 'Rostselmash',
        'KVERNELAND' => 'Kverneland',
        'ANNABURGER' => 'Annaburger',
        'STRAUTMANN' => 'Strautmann',
        'KOECKERLING' => 'Köckerling',
        'KOCKERLING' => 'Köckerling',
        'NEWHOLLAND' => 'New Holland',
        'ZUNHAMMER' => 'Zunhammer',
        'WEIDEMANN' => 'Weidemann',
        'DEUTZFAHR' => 'Deutz-Fahr',
        'POETTINGER' => 'Pöttinger',
        'POTTINGER' => 'Pöttinger',
        'VAEDERSTAD' => 'Väderstad',
        'VADERSTAD' => 'Väderstad',
        'CHALLENGER' => 'Challenger',
        'JOHNDEERE' => 'John Deere',
        'VERSATILE' => 'Versatile',
        'LIEBHERR' => 'Liebherr',
        'MANITOU' => 'Manitou',
        'BERGMANN' => 'Bergmann',
        'EINBOECK' => 'Einböck',
        'TREFFLER' => 'Treffler',
        'BRANTNER' => 'Brantner',
        'FARMTECH' => 'Farmtech',
        'VEENHUIS' => 'Veenhuis',
        'ANDERSON' => 'Anderson',
        'GOEWEIL' => 'Göweil',
        'AMAZONE' => 'Amazone',
        'KRAMER' => 'Kramer',
        'HORSCH' => 'Horsch',
        'LEMKEN' => 'Lemken',
        'GRIMME' => 'Grimme',
        'FLIEGL' => 'Fliegl',
        'KUBOTA' => 'Kubota',
        'MEILLER' => 'Meiller',
        'KAWECO' => 'Kaweco',
        'JOSKIN' => 'Joskin',
        'LINDNER' => 'Lindner',
        'SCANIA' => 'Scania',
        'SAMSON' => 'Samson',
        'FENDT' => 'Fendt',
        'CLAAS' => 'CLAAS',
        'VALTRA' => 'Valtra',
        'STEYR' => 'Steyr',
        'MERLO' => 'Merlo',
        'KRONE' => 'Krone',
        'KUHN' => 'Kuhn',
        'KOTTE' => 'Kotte',
        'VOLVO' => 'Volvo',
        'CASEIH' => 'Case IH',
        'AGCO' => 'AGCO',
        'SAME' => 'SAME',
        'JCB' => 'JCB',
        'MAN' => 'MAN',
    ];

    public static function resolve(?string $explicit, ?string $filename, ?string $modKey, ?string $name): ?string
    {
        $explicit = trim((string) $explicit);
        if ($explicit !== '') {
            return self::match($explicit) ?? $explicit;
        }

        foreach ([$modKey, $filename, $name] as $source) {
            if (! is_string($source) || trim($source) === '') {
                continue;
            }
            $found = self::match($source);
            if ($found !== null) {
                return $found;
            }
        }

        return null;
    }

    /** Stable lowercase key for icons/brands/<key>.dds (connector brand.name). */
    public static function iconKey(?string $brandKey, ?string $brand): ?string
    {
        foreach ([$brandKey, $brand] as $raw) {
            if (! is_string($raw)) {
                continue;
            }
            $key = strtolower((string) preg_replace('/[^a-zA-Z0-9._-]+/', '', $raw));
            if ($key !== '') {
                return $key;
            }
        }

        return null;
    }

    private static function match(string $source): ?string
    {
        $folded = strtoupper((string) preg_replace('/[^A-Za-z0-9]/', '', $source));
        $parts = self::tokens($source);
        foreach (self::LABELS as $key => $label) {
            if (strlen($key) <= 3) {
                if (in_array($key, $parts, true)) {
                    return $label;
                }

                continue;
            }
            if (str_contains($folded, $key) || in_array($key, $parts, true)) {
                return $label;
            }
        }

        return null;
    }

    /**
     * @return list<string>
     */
    private static function tokens(string $source): array
    {
        $spaced = (string) preg_replace('/([a-z])([A-Z])/', '$1 $2', $source);
        $raw = preg_split('/[^A-Za-z0-9]+/', strtoupper($spaced)) ?: [];

        return array_values(array_filter($raw, static fn (string $token): bool => $token !== ''));
    }
}
