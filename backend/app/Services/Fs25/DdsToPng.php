<?php

namespace App\Services\Fs25;

use Illuminate\Support\Facades\Log;

/**
 * Minimal DDS → PNG for FS25 store icons (DXT1 / DXT5 / BC7 / uncompressed BGRA).
 * BC7 (DXGI 98/99) needs backend/bin/dds2rgba (compiled from tools/dds2rgba).
 */
final class DdsToPng
{
    private static bool $loggedMissingBc7Tool = false;

    public static function externalToolAvailable(): bool
    {
        return self::dds2rgbaBinary() !== null;
    }

    public static function convert(string $ddsBytes, int $maxEdge = 2048): ?string
    {
        if (strlen($ddsBytes) < 128 || substr($ddsBytes, 0, 4) !== 'DDS ') {
            return null;
        }

        $height = unpack('V', substr($ddsBytes, 12, 4))[1] ?? 0;
        $width = unpack('V', substr($ddsBytes, 16, 4))[1] ?? 0;
        if ($width < 1 || $height < 1 || $width > $maxEdge || $height > $maxEdge) {
            return null;
        }

        // A 4096² PDA overview is too slow to decode in PHP. The helper scales it down.
        if ($width > 2048 || $height > 2048) {
            $rgba = self::decodeViaExternalTool($ddsBytes);
            if ($rgba === null) {
                return null;
            }
            [$outW, $outH] = self::fittedSize($width, $height);

            return self::encodePngRgba($rgba, $outW, $outH);
        }

        $pfFlags = unpack('V', substr($ddsBytes, 80, 4))[1] ?? 0;
        $fourCc = substr($ddsBytes, 84, 4);
        $rgbBitCount = unpack('V', substr($ddsBytes, 88, 4))[1] ?? 0;

        $rgba = null;
        if ($fourCc === 'DX10') {
            // FS25 store icons: 128-byte DDS header + 20-byte DX10 header.
            // Newer packs use BC7 (dxgi 98/99); older ones BC3 (77/78).
            if (strlen($ddsBytes) < 148) {
                return null;
            }
            $dxgi = unpack('V', substr($ddsBytes, 128, 4))[1] ?? 0;
            $data = substr($ddsBytes, 148);
            $rgba = match ($dxgi) {
                71, 72 => self::decodeDxt1($data, $width, $height),
                74, 75 => self::decodeDxt3($data, $width, $height),
                77, 78 => self::decodeDxt5($data, $width, $height),
                87, 91 => self::decodeBgra($data, $width, $height),
                98, 99 => self::decodeBc7($ddsBytes),
                default => null,
            };
        } else {
            $data = substr($ddsBytes, 128);
            if (($pfFlags & 0x4) !== 0) {
                $rgba = match ($fourCc) {
                    'DXT1', 'BC1 ' => self::decodeDxt1($data, $width, $height),
                    'DXT3', 'BC2 ' => self::decodeDxt3($data, $width, $height),
                    'DXT5', 'BC3 ' => self::decodeDxt5($data, $width, $height),
                    default => null,
                };
            } elseif ($rgbBitCount === 32) {
                $rgba = self::decodeBgra($data, $width, $height);
            }
        }

        if ($rgba === null) {
            return null;
        }

        // Always zlib. php-gd's per-pixel write on a 512² store icon takes long
        // enough to kill the PHP worker, so the rest of the queue never runs.
        return self::encodePngRgba($rgba, $width, $height);
    }

    /** Matches dds2rgba: edges above 4096 are divided down to at most 4096. */
    private static function fittedSize(int $width, int $height): array
    {
        if ($width <= 4096 && $height <= 4096) {
            return [$width, $height];
        }
        $factor = 2;
        $max = max($width, $height);
        while (intdiv($max, $factor) > 4096) {
            $factor++;
        }

        return [intdiv($width, $factor), intdiv($height, $factor)];
    }

    /** Header plus enough bytes for one full image. Short files are truncated downloads. */
    public static function hasPayload(string $ddsBytes): bool
    {
        if (strlen($ddsBytes) < 128 || substr($ddsBytes, 0, 4) !== 'DDS ') {
            return false;
        }
        $height = unpack('V', substr($ddsBytes, 12, 4))[1] ?? 0;
        $width = unpack('V', substr($ddsBytes, 16, 4))[1] ?? 0;
        if ($width < 1 || $height < 1 || $width > 2048 || $height > 2048) {
            return false;
        }

        $pfFlags = unpack('V', substr($ddsBytes, 80, 4))[1] ?? 0;
        $fourCc = substr($ddsBytes, 84, 4);
        $rgbBitCount = unpack('V', substr($ddsBytes, 88, 4))[1] ?? 0;
        $offset = $fourCc === 'DX10' ? 148 : 128;
        if (strlen($ddsBytes) < $offset) {
            return false;
        }

        if ($fourCc === 'DX10') {
            $dxgi = unpack('V', substr($ddsBytes, 128, 4))[1] ?? 0;
            if (in_array($dxgi, [87, 91], true)) {
                return strlen($ddsBytes) >= $offset + ($width * $height * 4);
            }
            // BC7 (98/99) and BC2/BC3 use 16-byte blocks; BC1 uses 8.
            $block = in_array($dxgi, [71, 72], true) ? 8 : 16;
            if (! in_array($dxgi, [71, 72, 74, 75, 77, 78, 98, 99], true)) {
                return false;
            }
        } elseif (($pfFlags & 0x4) !== 0 && in_array($fourCc, ['DXT1', 'BC1 '], true)) {
            $block = 8;
        } elseif (($pfFlags & 0x4) === 0 && $rgbBitCount === 32) {
            return strlen($ddsBytes) >= $offset + ($width * $height * 4);
        } else {
            $block = 16;
        }

        $blocks = (int) ceil($width / 4) * (int) ceil($height / 4);

        return strlen($ddsBytes) >= $offset + ($blocks * $block);
    }

    public static function describe(string $ddsBytes): string
    {
        if (strlen($ddsBytes) < 128 || substr($ddsBytes, 0, 4) !== 'DDS ') {
            return 'kein DDS, '.strlen($ddsBytes).' B';
        }
        $height = unpack('V', substr($ddsBytes, 12, 4))[1] ?? 0;
        $width = unpack('V', substr($ddsBytes, 16, 4))[1] ?? 0;
        $fourCc = trim(substr($ddsBytes, 84, 4));
        $extra = '';
        if ($fourCc === 'DX10' && strlen($ddsBytes) >= 132) {
            $extra = ' dxgi='.(unpack('V', substr($ddsBytes, 128, 4))[1] ?? 0);
        }

        return $fourCc.' '.$width.'x'.$height.$extra.' '.strlen($ddsBytes).' B';
    }

    private static function encodePngWithGd(string $rgba, int $width, int $height): ?string
    {
        $img = imagecreatetruecolor($width, $height);
        if ($img === false) {
            return null;
        }
        imagesavealpha($img, true);
        $transparent = imagecolorallocatealpha($img, 0, 0, 0, 127);
        imagefill($img, 0, 0, $transparent);

        $i = 0;
        for ($y = 0; $y < $height; $y++) {
            for ($x = 0; $x < $width; $x++) {
                $r = ord($rgba[$i++]);
                $g = ord($rgba[$i++]);
                $b = ord($rgba[$i++]);
                $a = ord($rgba[$i++]);
                $alpha = 127 - (int) round(($a / 255) * 127);
                $color = imagecolorallocatealpha($img, $r, $g, $b, $alpha);
                imagesetpixel($img, $x, $y, $color);
            }
        }

        ob_start();
        imagepng($img);
        imagedestroy($img);
        $png = ob_get_clean();

        return is_string($png) && $png !== '' ? $png : null;
    }

    private static function decodeBc7(string $ddsBytes): ?string
    {
        if (! self::externalToolAvailable()) {
            if (! self::$loggedMissingBc7Tool) {
                self::$loggedMissingBc7Tool = true;
                Log::warning('Agravion DDS BC7 needs bin/dds2rgba (apt install build-essential, then gcc -O2 -o bin/dds2rgba tools/dds2rgba/main.c)');
            }

            return null;
        }

        return self::decodeViaExternalTool($ddsBytes);
    }

    /**
     * BC7 needs the bundled dds2rgba helper. VPS installer compiles tools/dds2rgba.
     */
    private static function decodeViaExternalTool(string $ddsBytes): ?string
    {
        $bin = self::dds2rgbaBinary();
        if ($bin === null) {
            return null;
        }

        $tmp = tempnam(sys_get_temp_dir(), 'avdds');
        if ($tmp === false) {
            return null;
        }
        $ddsPath = $tmp.'.dds';
        @unlink($tmp);
        if (file_put_contents($ddsPath, $ddsBytes) === false) {
            return null;
        }

        try {
            $cmd = escapeshellarg($bin).' '.escapeshellarg($ddsPath);
            $raw = shell_exec($cmd.' 2>/dev/null');
            if (! is_string($raw) || strlen($raw) < 8) {
                return null;
            }
            $width = unpack('V', substr($raw, 0, 4))[1] ?? 0;
            $height = unpack('V', substr($raw, 4, 4))[1] ?? 0;
            $need = 8 + ($width * $height * 4);
            if ($width < 1 || $height < 1 || strlen($raw) < $need) {
                return null;
            }

            return substr($raw, 8, $width * $height * 4);
        } finally {
            @unlink($ddsPath);
        }
    }

    private static function dds2rgbaBinary(): ?string
    {
        $candidates = [
            base_path('bin/dds2rgba'),
            base_path('tools/dds2rgba/dds2rgba'),
            dirname(base_path()).'/backend/bin/dds2rgba',
        ];
        foreach ($candidates as $path) {
            if (is_file($path) && is_executable($path)) {
                return $path;
            }
        }

        return null;
    }

    /** Uncompressed-filter PNG (RGBA) — no GD required. */
    private static function encodePngRgba(string $rgba, int $width, int $height): ?string
    {
        if (! function_exists('gzcompress')) {
            return null;
        }
        $need = $width * $height * 4;
        if (strlen($rgba) < $need) {
            return null;
        }

        $raw = '';
        for ($y = 0; $y < $height; $y++) {
            $raw .= "\x00";
            $raw .= substr($rgba, $y * $width * 4, $width * 4);
        }
        $compressed = gzcompress($raw, 6);
        if ($compressed === false) {
            return null;
        }

        $ihdr = pack('NNCCCCC', $width, $height, 8, 6, 0, 0, 0); // 8-bit RGBA

        return "\x89PNG\r\n\x1a\n"
            .self::pngChunk('IHDR', $ihdr)
            .self::pngChunk('IDAT', $compressed)
            .self::pngChunk('IEND', '');
    }

    private static function pngChunk(string $type, string $data): string
    {
        return pack('N', strlen($data)).$type.$data.hash('crc32b', $type.$data, true);
    }

    private static function decodeBgra(string $data, int $width, int $height): ?string
    {
        $need = $width * $height * 4;
        if (strlen($data) < $need) {
            return null;
        }
        $out = '';
        for ($i = 0; $i < $need; $i += 4) {
            $b = $data[$i];
            $g = $data[$i + 1];
            $r = $data[$i + 2];
            $a = $data[$i + 3];
            $out .= $r.$g.$b.$a;
        }

        return $out;
    }

    private static function decodeDxt1(string $data, int $width, int $height): ?string
    {
        return self::decodeDxt($data, $width, $height, false);
    }

    private static function decodeDxt3(string $data, int $width, int $height): ?string
    {
        return self::decodeDxt($data, $width, $height, true, true);
    }

    private static function decodeDxt5(string $data, int $width, int $height): ?string
    {
        return self::decodeDxt($data, $width, $height, true, false);
    }

    private static function decodeDxt(string $data, int $width, int $height, bool $hasAlpha, bool $explicitAlpha = false): ?string
    {
        $blockSize = $hasAlpha ? 16 : 8;
        $blocksX = (int) ceil($width / 4);
        $blocksY = (int) ceil($height / 4);
        $need = $blocksX * $blocksY * $blockSize;
        if (strlen($data) < $need) {
            return null;
        }

        // One binary buffer. array_fill() of per-byte strings OOMs on 512²+ icons and kills the request before any further FTP.
        $pixels = str_repeat("\0", $width * $height * 4);
        $offset = 0;

        for ($by = 0; $by < $blocksY; $by++) {
            for ($bx = 0; $bx < $blocksX; $bx++) {
                $block = substr($data, $offset, $blockSize);
                $offset += $blockSize;

                $alpha = array_fill(0, 16, 255);
                $colorOffset = 0;
                if ($hasAlpha) {
                    if ($explicitAlpha) {
                        for ($i = 0; $i < 16; $i++) {
                            $nibble = ord($block[(int) floor($i / 2)]);
                            $alpha[$i] = (($i % 2) === 0 ? ($nibble & 0x0F) : (($nibble >> 4) & 0x0F)) * 17;
                        }
                    } else {
                        $a0 = ord($block[0]);
                        $a1 = ord($block[1]);
                        $bits = 0;
                        for ($i = 0; $i < 6; $i++) {
                            $bits |= ord($block[2 + $i]) << (8 * $i);
                        }
                        $table = [$a0, $a1];
                        if ($a0 > $a1) {
                            for ($i = 1; $i <= 6; $i++) {
                                $table[$i + 1] = (int) round(((7 - $i) * $a0 + $i * $a1) / 7);
                            }
                        } else {
                            for ($i = 1; $i <= 4; $i++) {
                                $table[$i + 1] = (int) round(((5 - $i) * $a0 + $i * $a1) / 5);
                            }
                            $table[6] = 0;
                            $table[7] = 255;
                        }
                        for ($i = 0; $i < 16; $i++) {
                            $code = ($bits >> (3 * $i)) & 0x7;
                            $alpha[$i] = $table[$code];
                        }
                    }
                    $colorOffset = 8;
                }

                $c0 = unpack('v', substr($block, $colorOffset, 2))[1];
                $c1 = unpack('v', substr($block, $colorOffset + 2, 2))[1];
                $colors = [
                    self::rgb565($c0),
                    self::rgb565($c1),
                ];
                if ($c0 > $c1 || $hasAlpha) {
                    $colors[2] = self::lerpRgb($colors[0], $colors[1], 1 / 3);
                    $colors[3] = self::lerpRgb($colors[0], $colors[1], 2 / 3);
                } else {
                    $colors[2] = self::lerpRgb($colors[0], $colors[1], 0.5);
                    $colors[3] = [0, 0, 0];
                }

                $indices = unpack('V', substr($block, $colorOffset + 4, 4))[1];
                for ($i = 0; $i < 16; $i++) {
                    $px = $bx * 4 + ($i % 4);
                    $py = $by * 4 + intdiv($i, 4);
                    if ($px >= $width || $py >= $height) {
                        continue;
                    }
                    $code = ($indices >> (2 * $i)) & 0x3;
                    $rgb = $colors[$code];
                    $a = (! $hasAlpha && $c0 <= $c1 && $code === 3) ? 0 : $alpha[$i];
                    $idx = ($py * $width + $px) * 4;
                    $pixels[$idx] = chr($rgb[0]);
                    $pixels[$idx + 1] = chr($rgb[1]);
                    $pixels[$idx + 2] = chr($rgb[2]);
                    $pixels[$idx + 3] = chr($a);
                }
            }
        }

        return $pixels;
    }

    /** @return array{0:int,1:int,2:int} */
    private static function rgb565(int $c): array
    {
        $r = (($c >> 11) & 0x1F) * 255 / 31;
        $g = (($c >> 5) & 0x3F) * 255 / 63;
        $b = ($c & 0x1F) * 255 / 31;

        return [(int) round($r), (int) round($g), (int) round($b)];
    }

    /**
     * @param  array{0:int,1:int,2:int}  $a
     * @param  array{0:int,1:int,2:int}  $b
     * @return array{0:int,1:int,2:int}
     */
    private static function lerpRgb(array $a, array $b, float $t): array
    {
        return [
            (int) round($a[0] + ($b[0] - $a[0]) * $t),
            (int) round($a[1] + ($b[1] - $a[1]) * $t),
            (int) round($a[2] + ($b[2] - $a[2]) * $t),
        ];
    }
}
