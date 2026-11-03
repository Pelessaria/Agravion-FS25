<?php

namespace App\Services\Fs25;

/**
 * Reads modDesc.xml from a zip by fetching only the central directory and that entry.
 * The whole archive is not downloaded, so a several-hundred-megabyte map stays cheap.
 */
final class ZipModDescReader
{
    /**
     * @param  callable(int, int): string  $read  offset, length
     */
    public static function xml(int $size, callable $read): ?string
    {
        if ($size < 22) {
            return null;
        }
        $tailLen = min($size, 65557);
        $tail = $read($size - $tailLen, $tailLen);
        if (! is_string($tail) || $tail === '') {
            return null;
        }
        $pos = strrpos($tail, "PK\x05\x06");
        if ($pos === false || strlen($tail) - $pos < 22) {
            return null;
        }
        $eocd = unpack('Vsig/vdisk/vstartdisk/vdiskentries/vcount/Vcdsize/Vcdoff/vcomment', substr($tail, $pos, 22));
        if (! is_array($eocd) || ($eocd['cdsize'] ?? 0) < 1 || ($eocd['cdoff'] ?? 0) < 0) {
            return null;
        }
        if ($eocd['cdoff'] === 0xFFFFFFFF || $eocd['cdsize'] === 0xFFFFFFFF || $eocd['cdsize'] > 8_000_000) {
            return null;
        }

        $cd = $read((int) $eocd['cdoff'], (int) $eocd['cdsize']);
        if (! is_string($cd) || $cd === '') {
            return null;
        }
        $entry = self::modDescEntry($cd);
        if ($entry === null || $entry['comp'] < 1 || $entry['comp'] > 1_500_000) {
            return null;
        }
        if (! in_array($entry['method'], [0, 8], true)) {
            return null;
        }

        $local = $read($entry['local'], 30);
        if (! is_string($local) || strlen($local) < 30) {
            return null;
        }
        $header = unpack('Vsig/vneed/vflags/vmethod/vtime/vdate/Vcrc/Vcomp/Vuncomp/vnamelen/vextralen', $local);
        if (! is_array($header)) {
            return null;
        }
        $start = $entry['local'] + 30 + (int) $header['namelen'] + (int) $header['extralen'];
        $data = $read($start, $entry['comp']);
        if (! is_string($data) || strlen($data) < $entry['comp']) {
            return null;
        }
        if ($entry['method'] === 0) {
            return str_contains($data, '<modDesc') ? $data : null;
        }
        $xml = @gzinflate($data);
        if (! is_string($xml) || ! str_contains($xml, '<modDesc')) {
            return null;
        }

        return $xml;
    }

    /**
     * @return array{method: int, comp: int, local: int}|null
     */
    private static function modDescEntry(string $cd): ?array
    {
        $offset = 0;
        $length = strlen($cd);
        $best = null;
        $bestSlashes = PHP_INT_MAX;
        while ($offset + 46 <= $length) {
            $header = unpack(
                'Vsig/vmade/vneed/vflags/vmethod/vtime/vdate/Vcrc/Vcomp/Vuncomp/vnamelen/vextralen/vcommentlen/vdisk/vinternal/Vexternal/Vlocal',
                substr($cd, $offset, 46)
            );
            if (! is_array($header) || $header['sig'] !== 0x02014b50) {
                break;
            }
            $name = substr($cd, $offset + 46, (int) $header['namelen']);
            $offset += 46 + (int) $header['namelen'] + (int) $header['extralen'] + (int) $header['commentlen'];
            if (strcasecmp(basename(str_replace('\\', '/', $name)), 'modDesc.xml') !== 0) {
                continue;
            }
            $slashes = substr_count(str_replace('\\', '/', $name), '/');
            if ($slashes < $bestSlashes) {
                $bestSlashes = $slashes;
                $best = [
                    'method' => (int) $header['method'],
                    'comp' => (int) $header['comp'],
                    'local' => (int) $header['local'],
                ];
            }
        }

        return $best;
    }
}
