<?php

namespace App\Services\Fs25;

use App\Models\HostAccess;
use App\Models\Workspace;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * Paints Precision Farming application maps from the savegame GRLE files.
 *
 * Pixel values match the in-game density indexes:
 * nitrogen 1..45 → 0..220 kg/ha in steps of 5, 0 is missing data;
 * pH 1..31 → 4.50 upward in steps of 0.125;
 * soil 1..4 are the four types, 5..7 are the same types after a soil sample;
 * yield 1..20 spans the in-game 50–115% scale, 0 is no reading;
 * seed rate 1 low, 2 standard, 3 high.
 */
final class PrecisionLayerService
{
    private const FILES = [
        'nitrogen' => 'precisionFarming_nitrogenMap.grle',
        'ph' => 'precisionFarming_phMap.grle',
        'soil' => 'precisionFarming_soilMap.grle',
        'yield' => 'precisionFarming_yieldMap.grle',
        'seed' => 'precisionFarming_seedRateMap.grle',
    ];

    /** @var array<int, array{0: float, 1: array{0: int, 1: int, 2: int}}> */
    private const NITROGEN_STOPS = [
        [0, [210, 58, 50]],
        [40, [224, 120, 40]],
        [80, [230, 194, 58]],
        [120, [158, 194, 58]],
        [160, [61, 154, 72]],
        [200, [31, 106, 52]],
        [220, [26, 36, 32]],
    ];

    /** @var array<int, array{0: float, 1: array{0: int, 1: int, 2: int}}> */
    private const PH_STOPS = [
        [4.5, [226, 59, 50]],
        [5.0, [239, 122, 40]],
        [5.5, [240, 200, 58]],
        [6.0, [198, 212, 60]],
        [6.5, [111, 190, 69]],
        [7.0, [47, 154, 120]],
        [7.5, [47, 134, 200]],
        [8.0, [36, 79, 154]],
    ];

    /** @var array<int, array{0: float, 1: array{0: int, 1: int, 2: int}}> */
    private const YIELD_STOPS = [
        [50, [210, 58, 50]],
        [70, [230, 194, 58]],
        [90, [111, 190, 69]],
        [115, [31, 106, 52]],
    ];

    /** @var array<int, array{0: int, 1: int, 2: int}> */
    private const SOIL = [
        1 => [210, 180, 140],
        2 => [196, 163, 106],
        3 => [140, 107, 69],
        4 => [92, 70, 54],
    ];

    /** @var array<int, array{0: int, 1: int, 2: int}> */
    private const SEED = [
        1 => [47, 134, 200],
        2 => [111, 190, 69],
        3 => [230, 194, 58],
    ];

    private const NONE = [20, 20, 20];

    public function __construct(
        private readonly GrleDecoder $decoder = new GrleDecoder,
        private readonly PngRgbWriter $png = new PngRgbWriter,
    ) {}

    public function pngPath(Workspace $workspace, string $layer): ?string
    {
        if (! isset(self::FILES[$layer])) {
            return null;
        }
        $workspace->loadMissing('hostAccess');
        $access = $workspace->hostAccess;
        if ($access === null) {
            return null;
        }
        $save = trim(str_replace('\\', '/', (string) $access->remote_savegame_path), '/');
        if ($save === '') {
            return null;
        }
        $directory = storage_path('app/connector/'.$workspace->public_id.'/precision');
        if (! is_dir($directory) && ! mkdir($directory, 0775, true) && ! is_dir($directory)) {
            return null;
        }
        $png = $directory.'/'.$layer.'.png';
        $stamp = $directory.'/'.$layer.'.sha';
        if (is_file($png) && is_file($stamp) && (time() - (int) filemtime($stamp)) < 180) {
            return $png;
        }

        $bytes = $this->download($access, $save.'/'.self::FILES[$layer]);
        if ($bytes === null) {
            return is_file($png) ? $png : null;
        }
        $hash = hash('sha256', $bytes);
        if (is_file($png) && is_file($stamp) && trim((string) file_get_contents($stamp)) === $hash) {
            touch($stamp);

            return $png;
        }
        $image = $this->decoder->decode($bytes);
        if ($image === null) {
            return is_file($png) ? $png : null;
        }
        $rgb = $this->colorize($layer, $image['pixels']);
        try {
            $this->png->write($png, $image['width'], $image['height'], $rgb);
            file_put_contents($stamp, $hash);
        } catch (Throwable) {
            return is_file($png) ? $png : null;
        }

        return $png;
    }

    private function download(HostAccess $access, string $path): ?string
    {
        $last = null;
        for ($attempt = 0; $attempt < 2; $attempt++) {
            try {
                $client = new HostFileClient($access);
                $bytes = $client->read($path, 60);
                if ($bytes !== '' && strlen($bytes) <= 12 * 1024 * 1024) {
                    return $bytes;
                }
            } catch (Throwable $e) {
                $last = $e;
            }
            usleep(1_500_000);
        }
        if ($last !== null) {
            Log::warning(HostConnectionError::format($last, 'Applikationskarte'));
        }

        return null;
    }

    private function colorize(string $layer, string $pixels): string
    {
        $table = $this->table($layer);
        $count = strlen($pixels);
        $parts = [];
        for ($index = 0; $index < $count; $index++) {
            $parts[] = $table[ord($pixels[$index])];
        }

        return implode('', $parts);
    }

    /**
     * @return array<int, string>
     */
    private function table(string $layer): array
    {
        $none = $this->pack(self::NONE);
        $table = array_fill(0, 256, $none);
        if ($layer === 'nitrogen') {
            for ($level = 1; $level <= 45; $level++) {
                $table[$level] = $this->pack($this->ramp(($level - 1) * 5, self::NITROGEN_STOPS));
            }
        } elseif ($layer === 'ph') {
            for ($level = 1; $level <= 40; $level++) {
                $ph = 4.5 + ($level - 1) * 0.125;
                $table[$level] = $this->pack($this->ramp(min($ph, 8.0), self::PH_STOPS));
            }
        } elseif ($layer === 'soil') {
            for ($value = 1; $value <= 7; $value++) {
                $type = $value <= 4 ? $value : $value - 4;
                $table[$value] = $this->pack(self::SOIL[$type] ?? self::NONE);
            }
        } elseif ($layer === 'yield') {
            for ($level = 1; $level <= 20; $level++) {
                $percent = 50 + $level * 3.25;
                $table[$level] = $this->pack($this->ramp($percent, self::YIELD_STOPS));
            }
        } elseif ($layer === 'seed') {
            foreach (self::SEED as $level => $color) {
                $table[$level] = $this->pack($color);
            }
        }

        return $table;
    }

    /**
     * @param  array<int, array{0: float, 1: array{0: int, 1: int, 2: int}}>  $stops
     * @return array{0: int, 1: int, 2: int}
     */
    private function ramp(float $value, array $stops): array
    {
        if ($value <= $stops[0][0]) {
            return $stops[0][1];
        }
        $last = $stops[array_key_last($stops)];
        if ($value >= $last[0]) {
            return $last[1];
        }
        $count = count($stops);
        for ($index = 1; $index < $count; $index++) {
            [$high, $color] = $stops[$index];
            [$low, $previous] = $stops[$index - 1];
            if ($value <= $high) {
                $span = $high - $low;
                $ratio = $span <= 0 ? 1.0 : ($value - $low) / $span;

                return $this->mix($previous, $color, $ratio);
            }
        }

        return $last[1];
    }

    /**
     * @param  array{0: int, 1: int, 2: int}  $from
     * @param  array{0: int, 1: int, 2: int}  $to
     * @return array{0: int, 1: int, 2: int}
     */
    private function mix(array $from, array $to, float $amount): array
    {
        $amount = min(1.0, max(0.0, $amount));

        return [
            (int) round($from[0] + ($to[0] - $from[0]) * $amount),
            (int) round($from[1] + ($to[1] - $from[1]) * $amount),
            (int) round($from[2] + ($to[2] - $from[2]) * $amount),
        ];
    }

    /**
     * @param  array{0: int, 1: int, 2: int}  $color
     */
    private function pack(array $color): string
    {
        return chr($color[0]).chr($color[1]).chr($color[2]);
    }
}
