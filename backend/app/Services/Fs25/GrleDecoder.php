<?php

namespace App\Services\Fs25;

/**
 * Giants GRLE info-layer reader (Farming Simulator 22/25).
 *
 * Header is 20 bytes: magic "GRLE", version, width/256, height/256.
 * Pixels are one grayscale channel, left to right, top to bottom.
 * A matching pair starts a run; the following bytes are the length minus 2,
 * and each 0xFF continues the length by 255. A differing pair emits one
 * pixel and keeps the second byte for the next pair.
 */
final class GrleDecoder
{
    /**
     * @return array{width: int, height: int, pixels: string}|null
     */
    public function decode(string $bytes): ?array
    {
        $header = $this->header($bytes);
        if ($header === null) {
            return null;
        }
        [$width, $height] = $header;
        $pixels = $this->expand(substr($bytes, 20), $width * $height);
        if ($pixels === null) {
            return null;
        }

        return [
            'width' => $width,
            'height' => $height,
            'pixels' => $pixels,
        ];
    }

    /**
     * Same as decode(), but keeps at most $maxEdge pixels on the long side.
     * Large base-game layers are 8192²; the map only needs the coarser grid.
     *
     * @return array{width: int, height: int, pixels: string}|null
     */
    public function decodeFitted(string $bytes, int $maxEdge): ?array
    {
        if ($maxEdge < 256) {
            return null;
        }
        $header = $this->header($bytes);
        if ($header === null) {
            return null;
        }
        [$width, $height] = $header;
        $factor = (int) ceil(max($width, $height) / $maxEdge);
        if ($factor <= 1) {
            return $this->decode($bytes);
        }
        $outW = intdiv($width - 1, $factor) + 1;
        $outH = intdiv($height - 1, $factor) + 1;
        $pixels = $this->expandFitted(substr($bytes, 20), $width, $height, $factor, $outW, $outH);
        if ($pixels === null) {
            return null;
        }

        return [
            'width' => $outW,
            'height' => $outH,
            'pixels' => $pixels,
        ];
    }

    /**
     * @return array{0: int, 1: int}|null
     */
    private function header(string $bytes): ?array
    {
        if (strlen($bytes) < 21 || substr($bytes, 0, 4) !== 'GRLE') {
            return null;
        }
        $version = unpack('v', substr($bytes, 4, 2))[1];
        if ($version !== 1) {
            return null;
        }
        $width = unpack('v', substr($bytes, 6, 2))[1] * 256;
        $height = unpack('v', substr($bytes, 10, 2))[1] * 256;
        if ($width < 256 || $height < 256 || $width > 8192 || $height > 8192) {
            return null;
        }

        return [$width, $height];
    }

    private function expand(string $data, int $expected): ?string
    {
        $length = strlen($data);
        $index = 1;
        $filled = 0;
        $chunks = [];
        while ($index + 1 < $length && $filled < $expected) {
            $previous = ord($data[$index]);
            $next = ord($data[$index + 1]);
            $index += 2;
            if ($previous === $next) {
                $count = 0;
                while ($index < $length && ord($data[$index]) === 255) {
                    $count += 255;
                    $index++;
                }
                if ($index < $length) {
                    $count += ord($data[$index]);
                    $index++;
                }
                $count += 2;
                $take = min($count, $expected - $filled);
                $chunks[] = str_repeat(chr($previous), $take);
                $filled += $take;
            } else {
                $chunks[] = chr($previous);
                $filled++;
                $index--;
            }
        }
        if ($filled !== $expected) {
            return null;
        }

        return implode('', $chunks);
    }

    private function expandFitted(string $data, int $width, int $height, int $factor, int $outW, int $outH): ?string
    {
        $expected = $width * $height;
        $length = strlen($data);
        $index = 1;
        $filled = 0;
        $out = str_repeat("\0", $outW * $outH);
        while ($index + 1 < $length && $filled < $expected) {
            $previous = ord($data[$index]);
            $next = ord($data[$index + 1]);
            $index += 2;
            if ($previous === $next) {
                $count = 0;
                while ($index < $length && ord($data[$index]) === 255) {
                    $count += 255;
                    $index++;
                }
                if ($index < $length) {
                    $count += ord($data[$index]);
                    $index++;
                }
                $count += 2;
                $take = min($count, $expected - $filled);
                $this->stamp($out, $filled, $take, chr($previous), $width, $factor, $outW);
                $filled += $take;
            } else {
                $this->stamp($out, $filled, 1, chr($previous), $width, $factor, $outW);
                $filled++;
                $index--;
            }
        }
        if ($filled !== $expected) {
            return null;
        }

        return $out;
    }

    private function stamp(string &$out, int $start, int $count, string $value, int $width, int $factor, int $outW): void
    {
        if ($count <= 0) {
            return;
        }
        $end = $start + $count;
        $y0 = intdiv($start, $width);
        $y1 = intdiv($end - 1, $width);
        for ($y = $y0; $y <= $y1; $y++) {
            if ($y % $factor !== 0) {
                continue;
            }
            $rowStart = $y * $width;
            $from = max($start, $rowStart) - $rowStart;
            $to = min($end, $rowStart + $width) - $rowStart;
            $x = $from;
            $mod = $x % $factor;
            if ($mod !== 0) {
                $x += $factor - $mod;
            }
            $row = intdiv($y, $factor) * $outW;
            while ($x < $to) {
                $out[$row + intdiv($x, $factor)] = $value;
                $x += $factor;
            }
        }
    }
}
