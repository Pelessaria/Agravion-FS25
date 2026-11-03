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
        $expected = $width * $height;
        $pixels = $this->expand(substr($bytes, 20), $expected);
        if ($pixels === null) {
            return null;
        }

        return [
            'width' => $width,
            'height' => $height,
            'pixels' => $pixels,
        ];
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
}
