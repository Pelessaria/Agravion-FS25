<?php

namespace App\Services\Fs25;

use Illuminate\Support\Facades\Http;
use RuntimeException;

/**
 * Read-only lookup of the public mod catalog.
 * The catalog does not host the zip files. A direct file is taken only from the
 * ModHub page itself, and only from the Giants download host.
 */
final class ModHubCatalog
{
    /**
     * @param  list<string>  $techNames
     * @return array<string, array{version: ?string, pageUrl: ?string, title: ?string, downloadUrl: ?string}>
     */
    public function lookup(array $techNames): array
    {
        $names = [];
        foreach ($techNames as $name) {
            $name = trim($name);
            if ($name !== '') {
                $names[$name] = true;
            }
        }
        if ($names === []) {
            return [];
        }

        $found = [];
        foreach (array_chunk(array_keys($names), 60) as $chunk) {
            $response = Http::acceptJson()
                ->timeout(15)
                ->connectTimeout(5)
                ->post('https://silo-api.hllmr.com/mods/lookup', ['techNames' => array_values($chunk)]);
            if ($response->status() >= 400) {
                throw new RuntimeException('Die ModHub-Abfrage ist fehlgeschlagen.');
            }
            $rows = $response->json('results');
            if (! is_array($rows)) {
                continue;
            }
            foreach ($rows as $row) {
                if (! is_array($row)) {
                    continue;
                }
                $tech = trim((string) ($row['techName'] ?? ''));
                if ($tech === '') {
                    continue;
                }
                $version = $row['latestVersion'] ?? null;
                $page = $row['pageUrl'] ?? null;
                $title = $row['title'] ?? null;
                $found[$tech] = [
                    'version' => is_string($version) && $version !== '' ? $version : null,
                    'pageUrl' => is_string($page) && self::isModHubPage($page) ? $page : null,
                    'title' => is_string($title) && $title !== '' ? $title : null,
                    'downloadUrl' => self::directDownload(is_array($row['download'] ?? null) ? $row['download'] : null, $tech),
                ];
            }
        }

        $out = [];
        foreach (array_keys($names) as $name) {
            $match = null;
            foreach ($found as $tech => $info) {
                if (strcasecmp($tech, $name) === 0) {
                    $match = $info;
                    break;
                }
            }
            $out[$name] = $match ?? ['version' => null, 'pageUrl' => null, 'title' => null, 'downloadUrl' => null];
        }

        return $out;
    }

    public static function newer(string $installed, ?string $latest): bool
    {
        if ($installed === '' || $latest === null || $latest === '') {
            return false;
        }

        return self::compare($latest, $installed) > 0;
    }

    /**
     * The zip link printed on the ModHub page. Nothing is guessed from the id.
     */
    public static function zipUrl(string $html, string $fileName): ?string
    {
        if (preg_match_all('#https://cdn\d+\.giants-software\.com/modHub/storage/\d+/[^"\s<>]+\.zip#i', $html, $matches) < 1) {
            return null;
        }
        foreach ($matches[0] as $url) {
            $path = parse_url($url, PHP_URL_PATH);
            if (! is_string($path)) {
                continue;
            }
            if (strcasecmp(basename($path), $fileName) === 0 && self::isGiantsZip($url)) {
                return $url;
            }
        }

        return null;
    }

    /**
     * The catalog sometimes points at a newer release than the zip linked on the ModHub page.
     * Only a Giants download or a GitHub release of this exact zip is accepted.
     *
     * @param  array<string, mixed>|null  $download
     */
    public static function directDownload(?array $download, string $techName): ?string
    {
        if ($download === null) {
            return null;
        }
        $url = trim((string) ($download['url'] ?? ''));
        $file = $techName.'.zip';
        $path = parse_url($url, PHP_URL_PATH);
        if ($url === '' || ! is_string($path) || strcasecmp(basename($path), $file) !== 0) {
            return null;
        }
        if (! self::isGiantsZip($url) && ! self::isReleaseZip($url)) {
            return null;
        }

        return $url;
    }

    public static function isReleaseZip(string $url): bool
    {
        $parts = parse_url($url);
        $host = strtolower((string) ($parts['host'] ?? ''));
        $path = (string) ($parts['path'] ?? '');

        return ($parts['scheme'] ?? '') === 'https'
            && $host === 'github.com'
            && preg_match('#^/[^/]+/[^/]+/releases/download/[^/]+/[^/]+\.zip$#i', $path) === 1;
    }

    public static function isAllowedUpdateUrl(string $url): bool
    {
        if (self::isGiantsZip($url) || self::isReleaseZip($url)) {
            return true;
        }
        $parts = parse_url($url);
        $host = strtolower((string) ($parts['host'] ?? ''));

        return ($parts['scheme'] ?? '') === 'https'
            && in_array($host, [
                'objects.githubusercontent.com',
                'release-assets.githubusercontent.com',
                'github-releases.githubusercontent.com',
            ], true);
    }

    public static function isModHubPage(string $url): bool
    {
        $parts = parse_url($url);
        $host = strtolower((string) ($parts['host'] ?? ''));

        return ($parts['scheme'] ?? '') === 'https'
            && in_array($host, ['www.farming-simulator.com', 'farming-simulator.com'], true);
    }

    public static function isGiantsZip(string $url): bool
    {
        $parts = parse_url($url);
        $host = strtolower((string) ($parts['host'] ?? ''));
        $path = (string) ($parts['path'] ?? '');

        return ($parts['scheme'] ?? '') === 'https'
            && preg_match('/^cdn\d+\.giants-software\.com$/', $host) === 1
            && str_ends_with(strtolower($path), '.zip');
    }

    private static function compare(string $left, string $right): int
    {
        $a = self::parts($left);
        $b = self::parts($right);
        $count = max(count($a), count($b));
        for ($i = 0; $i < $count; $i++) {
            $diff = ($a[$i] ?? 0) <=> ($b[$i] ?? 0);
            if ($diff !== 0) {
                return $diff;
            }
        }

        return 0;
    }

    /**
     * @return list<int>
     */
    private static function parts(string $version): array
    {
        if (preg_match('/(\d+(?:\.\d+)*)/', $version, $match) !== 1) {
            return [];
        }

        return array_map(static fn (string $part): int => (int) $part, explode('.', $match[1]));
    }
}
