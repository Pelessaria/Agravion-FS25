<?php

namespace App\Services\Fs25;

/**
 * Reads the mod list stored in a career savegame file.
 * A mod is identified by its modName, which matches the zip name without ".zip".
 */
final class SavegameModList
{
    /**
     * @return list<array{modName: string, title: string, version: string}>
     */
    public static function parse(string $xml): array
    {
        if (preg_match_all('/<mod\b([^>]*)>/i', $xml, $matches) < 1) {
            return [];
        }

        $mods = [];
        foreach ($matches[1] as $attrs) {
            $modName = self::attr($attrs, 'modName');
            if ($modName === '') {
                continue;
            }
            $mods[] = [
                'modName' => $modName,
                'title' => self::attr($attrs, 'title'),
                'version' => self::attr($attrs, 'version'),
            ];
        }

        return $mods;
    }

    private static function attr(string $attrs, string $name): string
    {
        if (preg_match('/\b'.preg_quote($name, '/').'="([^"]*)"/i', $attrs, $match) !== 1) {
            return '';
        }

        return trim(html_entity_decode($match[1], ENT_QUOTES | ENT_HTML5, 'UTF-8'));
    }
}
