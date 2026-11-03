<?php

namespace App\Services\Fs25;

use App\Models\HostAccess;
use RuntimeException;
use Throwable;

/**
 * Reads the PDA overview out of the map mod zip.
 * Only the zip tail and that one entry are transferred — never the whole mod.
 */
final class MapOverviewExtractor
{
    private const MAX_ENTRY = 80 * 1024 * 1024;

    public function pngFromMapZip(HostFileClient $client, HostAccess $access, string $mapName): ?string
    {
        $mapName = trim($mapName);
        if ($mapName === '') {
            return null;
        }
        if (function_exists('set_time_limit')) {
            @set_time_limit(180);
        }

        $modsDir = ConnectorDeployService::resolveModsDirectory($client, $access);
        $zipName = $this->chooseZip($client->listNames($modsDir), $mapName);
        if ($zipName === null) {
        $zips = array_values(array_filter(
            $names,
            static fn (string $name): bool => str_ends_with(strtolower($name), '.zip'),
        ));
        throw new RuntimeException(
            'Keine Map-Zip zu „'.$mapName.'“ in '.$modsDir
            .' ('.implode(', ', array_slice($zips, 0, 12)).')'
        );
        }

        $path = trim($modsDir, '/').'/'.$zipName;
        $entries = $this->overviewEntries($client, $path);
        if ($entries === []) {
            throw new RuntimeException($zipName.' enthält kein overview.dds/png');
        }

        $last = 'overview ließ sich nicht lesen';
        foreach ($entries as $entry) {
            try {
                $bytes = $this->entryBytes($client, $path, $entry);
                if (str_starts_with($bytes, "\x89PNG")) {
                    return $bytes;
                }
                if (! str_starts_with($bytes, 'DDS ')) {
                    $last = $entry['name'].' ist weder PNG noch DDS';
                    continue;
                }
                $previous = ini_get('memory_limit');
                ini_set('memory_limit', '512M');
                try {
                    $png = DdsToPng::convert($bytes, 8192);
                } finally {
                    if (is_string($previous) && $previous !== '') {
                        ini_set('memory_limit', $previous);
                    }
                }
                if (is_string($png) && str_starts_with($png, "\x89PNG")) {
                    return $png;
                }
                $last = 'overview.dds ließ sich nicht in ein PNG wandeln';
            } catch (Throwable $e) {
                $last = $e->getMessage();
            }
        }

        throw new RuntimeException($last);
    }

    /**
     * @param  list<string>  $names
     */
    private function chooseZip(array $names, string $mapName): ?string
    {
        $tokens = array_values(array_filter(
            preg_split('/[^a-z0-9]+/i', strtolower($mapName)) ?: [],
            static fn (string $token): bool => strlen($token) >= 4,
        ));
        $best = null;
        $bestScore = 0;
        foreach ($names as $name) {
            if (! str_ends_with(strtolower($name), '.zip')) {
                continue;
            }
            $hay = strtolower($name);
            $score = 0;
            foreach ($tokens as $token) {
                if (str_contains($hay, $token)) {
                    $score += 10;
                }
            }
            if ($score > $bestScore) {
                $bestScore = $score;
                $best = $name;
            }
        }

        return $bestScore >= 10 ? $best : null;
    }

    /**
     * @return list<array{name: string, method: int, compressed: int, uncompressed: int, offset: int}>
     */
    private function overviewEntries(HostFileClient $client, string $path): array
    {
        $size = $client->fileSize($path);
        if ($size < 22) {
            return [];
        }

        $tailLen = (int) min($size, 1024 * 1024);
        $tail = $client->readRange($path, $size - $tailLen, $tailLen);
        $eocd = $this->findEocd($tail);
        if ($eocd === null && $tailLen < $size) {
            $tailLen = (int) min($size, 8 * 1024 * 1024);
            $tail = $client->readRange($path, $size - $tailLen, $tailLen);
            $eocd = $this->findEocd($tail);
        }
        if ($eocd === null) {
            throw new RuntimeException('ZIP-Inhaltsverzeichnis nicht lesbar: '.$path);
        }

        if ($eocd['cdOffset'] === 0xFFFFFFFF || $eocd['cdSize'] === 0xFFFFFFFF) {
            $eocd = $this->zip64($client, $path, $size - strlen($tail) + $eocd['at']);
        }
        if ($eocd['cdSize'] < 1 || $eocd['cdSize'] > 16 * 1024 * 1024) {
            throw new RuntimeException('ZIP-Inhaltsverzeichnis zu groß: '.$path);
        }

        $cd = $client->readRange($path, $eocd['cdOffset'], $eocd['cdSize']);
        $found = [];
        foreach ($this->centralDirectory($cd) as $entry) {
            $name = strtolower(str_replace('\\', '/', $entry['name']));
            $base = basename($name);
            if ($base !== 'overview.dds' && $base !== 'overview.png') {
                continue;
            }
            $score = $base === 'overview.dds' ? 10 : 4;
            if (! str_contains($name, '/')) {
                $score += 3;
            }
            $entry['score'] = $score;
            $found[] = $entry;
        }
        usort($found, static fn (array $a, array $b): int => $b['score'] <=> $a['score']);

        return $found;
    }

    /**
     * @param  array{name: string, method: int, compressed: int, uncompressed: int, offset: int}  $entry
     */
    private function entryBytes(HostFileClient $client, string $path, array $entry): string
    {
        if ($entry['compressed'] < 1 || $entry['compressed'] > self::MAX_ENTRY || $entry['uncompressed'] > self::MAX_ENTRY) {
            throw new RuntimeException($entry['name'].' ist zu groß für die PDA-Karte');
        }

        $header = $client->readRange($path, $entry['offset'], 64 * 1024);
        if (strlen($header) < 30 || substr($header, 0, 4) !== "PK\x03\x04") {
            throw new RuntimeException('Lokaler ZIP-Header fehlt: '.$entry['name']);
        }
        $nameLen = unpack('v', substr($header, 26, 2))[1] ?? 0;
        $extraLen = unpack('v', substr($header, 28, 2))[1] ?? 0;
        $dataAt = 30 + $nameLen + $extraLen;
        if ($dataAt > strlen($header)) {
            throw new RuntimeException('Lokaler ZIP-Header unvollständig: '.$entry['name']);
        }

        $stored = substr($header, $dataAt);
        if (strlen($stored) < $entry['compressed']) {
            $stored .= $client->readRange($path, $entry['offset'] + $dataAt + strlen($stored), $entry['compressed'] - strlen($stored));
        }
        $stored = substr($stored, 0, $entry['compressed']);

        if ($entry['method'] === 0) {
            return $stored;
        }
        if ($entry['method'] !== 8) {
            throw new RuntimeException($entry['name'].' nutzt ZIP-Methode '.$entry['method']);
        }
        $raw = gzinflate($stored);
        if (! is_string($raw)) {
            throw new RuntimeException($entry['name'].' ließ sich nicht entpacken');
        }

        return $raw;
    }

    /**
     * @return array{at: int, cdSize: int, cdOffset: int}|null
     */
    private function findEocd(string $tail): ?array
    {
        for ($i = strlen($tail) - 22; $i >= 0; $i--) {
            if (substr($tail, $i, 4) !== "PK\x05\x06") {
                continue;
            }
            $commentLen = unpack('v', substr($tail, $i + 20, 2))[1] ?? 0;
            if ($i + 22 + $commentLen !== strlen($tail)) {
                continue;
            }

            return [
                'at' => $i,
                'cdSize' => unpack('V', substr($tail, $i + 12, 4))[1] ?? 0,
                'cdOffset' => unpack('V', substr($tail, $i + 16, 4))[1] ?? 0,
            ];
        }

        return null;
    }

    /**
     * @return array{at: int, cdSize: int, cdOffset: int}
     */
    private function zip64(HostFileClient $client, string $path, int $eocdAt): array
    {
        if ($eocdAt < 20) {
            throw new RuntimeException('ZIP64-Locator fehlt');
        }
        $locator = $client->readRange($path, $eocdAt - 20, 20);
        if (substr($locator, 0, 4) !== "PK\x06\x07") {
            throw new RuntimeException('ZIP64-Locator fehlt');
        }
        $offset = unpack('P', substr($locator, 8, 8))[1] ?? 0;
        $record = $client->readRange($path, (int) $offset, 80);
        if (substr($record, 0, 4) !== "PK\x06\x06") {
            throw new RuntimeException('ZIP64-Verzeichnis fehlt');
        }

        return [
            'at' => 0,
            'cdSize' => (int) (unpack('P', substr($record, 40, 8))[1] ?? 0),
            'cdOffset' => (int) (unpack('P', substr($record, 48, 8))[1] ?? 0),
        ];
    }

    /**
     * @return list<array{name: string, method: int, compressed: int, uncompressed: int, offset: int}>
     */
    private function centralDirectory(string $cd): array
    {
        $entries = [];
        $p = 0;
        $len = strlen($cd);
        while ($p + 46 <= $len) {
            if (substr($cd, $p, 4) !== "PK\x01\x02") {
                break;
            }
            $method = unpack('v', substr($cd, $p + 10, 2))[1] ?? 0;
            $compressed = unpack('V', substr($cd, $p + 20, 4))[1] ?? 0;
            $uncompressed = unpack('V', substr($cd, $p + 24, 4))[1] ?? 0;
            $nameLen = unpack('v', substr($cd, $p + 28, 2))[1] ?? 0;
            $extraLen = unpack('v', substr($cd, $p + 30, 2))[1] ?? 0;
            $commentLen = unpack('v', substr($cd, $p + 32, 2))[1] ?? 0;
            $offset = unpack('V', substr($cd, $p + 42, 4))[1] ?? 0;
            $name = substr($cd, $p + 46, $nameLen);
            $extra = substr($cd, $p + 46 + $nameLen, $extraLen);
            if ($compressed === 0xFFFFFFFF || $uncompressed === 0xFFFFFFFF || $offset === 0xFFFFFFFF) {
                [$uncompressed, $compressed, $offset] = $this->zip64Extra($extra, $uncompressed, $compressed, $offset);
            }
            $entries[] = [
                'name' => $name,
                'method' => $method,
                'compressed' => (int) $compressed,
                'uncompressed' => (int) $uncompressed,
                'offset' => (int) $offset,
            ];
            $p += 46 + $nameLen + $extraLen + $commentLen;
        }

        return $entries;
    }

    /**
     * @return array{0: int, 1: int, 2: int}
     */
    private function zip64Extra(string $extra, int $uncompressed, int $compressed, int $offset): array
    {
        $q = 0;
        $len = strlen($extra);
        while ($q + 4 <= $len) {
            $id = unpack('v', substr($extra, $q, 2))[1] ?? 0;
            $size = unpack('v', substr($extra, $q + 2, 2))[1] ?? 0;
            $q += 4;
            if ($id === 1) {
                $z = $q;
                if ($uncompressed === 0xFFFFFFFF && $z + 8 <= $q + $size) {
                    $uncompressed = (int) (unpack('P', substr($extra, $z, 8))[1] ?? 0);
                    $z += 8;
                }
                if ($compressed === 0xFFFFFFFF && $z + 8 <= $q + $size) {
                    $compressed = (int) (unpack('P', substr($extra, $z, 8))[1] ?? 0);
                    $z += 8;
                }
                if ($offset === 0xFFFFFFFF && $z + 8 <= $q + $size) {
                    $offset = (int) (unpack('P', substr($extra, $z, 8))[1] ?? 0);
                }
                break;
            }
            $q += $size;
        }

        return [$uncompressed, $compressed, $offset];
    }
}
