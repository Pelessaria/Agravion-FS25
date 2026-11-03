<?php

namespace App\Services\Fs25;

use RuntimeException;

/** Uncompressed-filter PNG, 8-bit RGB, no extra libraries. */
final class PngRgbWriter
{
    public function write(string $path, int $width, int $height, string $rgb): void
    {
        $stride = $width * 3;
        if ($width < 1 || $height < 1 || strlen($rgb) !== $stride * $height) {
            throw new RuntimeException('PNG-Puffer passt nicht zur Bildgröße.');
        }
        $raw = '';
        for ($y = 0; $y < $height; $y++) {
            $raw .= "\x00".substr($rgb, $y * $stride, $stride);
        }
        $png = "\x89PNG\r\n\x1a\n";
        $png .= $this->chunk('IHDR', pack('NNC5', $width, $height, 8, 2, 0, 0, 0));
        $png .= $this->chunk('IDAT', gzcompress($raw, 6));
        $png .= $this->chunk('IEND', '');
        $temporary = $path.'.tmp';
        if (file_put_contents($temporary, $png) === false) {
            throw new RuntimeException('PNG konnte nicht geschrieben werden.');
        }
        if (! rename($temporary, $path)) {
            @unlink($temporary);
            throw new RuntimeException('PNG konnte nicht übernommen werden.');
        }
    }

    private function chunk(string $type, string $data): string
    {
        return pack('N', strlen($data)).$type.$data.hash('crc32b', $type.$data, true);
    }
}
