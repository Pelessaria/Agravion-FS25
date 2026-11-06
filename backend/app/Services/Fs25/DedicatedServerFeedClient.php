<?php

namespace App\Services\Fs25;

use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\RequestException;
use Illuminate\Support\Facades\Http;
use InvalidArgumentException;
use RuntimeException;

/**
 * Read-only Giants dedicated-server web API client.
 *
 * @see docs/FS25-INTEGRATION.md
 */
class DedicatedServerFeedClient
{
    private string $baseUrl;

    private string $code;

    public function __construct(
        string $baseUrl,
        string $code,
        private readonly int $timeoutSeconds = 20,
    ) {
        $base = rtrim(trim($baseUrl), '/');
        if ($base === '' || ! preg_match('#^https?://#i', $base)) {
            throw new InvalidArgumentException('Feed base URL must be http or https.');
        }
        if (trim($code) === '') {
            throw new InvalidArgumentException('Feed code is required.');
        }
        $this->baseUrl = $base;
        $this->code = trim($code);
    }

    public static function fromParts(string $baseUrl, string $code, int $timeoutSeconds = 20): self
    {
        return new self($baseUrl, $code, $timeoutSeconds);
    }

    /**
     * Accepts either an origin/base URL or a full feed URL that already contains ?code=.
     */
    public static function fromFeedUrl(string $feedUrl): self
    {
        $trimmed = trim($feedUrl);
        if ($trimmed === '') {
            throw new InvalidArgumentException('Feed URL is empty.');
        }

        $parts = parse_url($trimmed);
        if ($parts === false || empty($parts['scheme']) || empty($parts['host'])) {
            throw new InvalidArgumentException('Feed URL is invalid.');
        }

        $origin = $parts['scheme'].'://'.$parts['host'];
        if (! empty($parts['port'])) {
            $origin .= ':'.$parts['port'];
        }

        $code = '';
        if (! empty($parts['query'])) {
            parse_str($parts['query'], $query);
            $code = (string) ($query['code'] ?? '');
        }

        if ($code === '') {
            throw new InvalidArgumentException('Feed URL must include a code query parameter.');
        }

        return new self($origin, $code);
    }

    public function baseUrl(): string
    {
        return $this->baseUrl;
    }

    public function code(): string
    {
        return $this->code;
    }

    /**
     * @return array<string, mixed>
     */
    public function fetchStatsJson(): array
    {
        $body = $this->get('/feed/dedicated-server-stats.json');
        $decoded = json_decode($body, true);
        if (! is_array($decoded)) {
            throw new RuntimeException('Stats JSON could not be decoded.');
        }

        return $decoded;
    }

    public function fetchStatsXml(): string
    {
        return $this->get('/feed/dedicated-server-stats.xml');
    }

    public function fetchMapJpeg(int $quality = 60, int $size = 512): string
    {
        return $this->get('/feed/dedicated-server-stats-map.jpg', [
            'quality' => (string) $quality,
            'size' => (string) $size,
        ]);
    }

    public function fetchSavegame(string $file): string
    {
        $allowed = [
            'careerSavegame',
            'vehicles',
            'economy',
        ];
        if (! in_array($file, $allowed, true)) {
            throw new InvalidArgumentException('Unsupported savegame file: '.$file);
        }

        return $this->get('/feed/dedicated-server-savegame.html', [
            'file' => $file,
        ]);
    }

    /**
     * Pull the Phase-4 core set and normalize a summary (no secrets in output).
     */
    public function fetchSnapshot(): FeedSnapshot
    {
        $json = $this->fetchStatsJson();
        $career = $this->fetchSavegame('careerSavegame');
        $vehiclesXml = $this->fetchSavegame('vehicles');
        $economyXml = $this->fetchSavegame('economy');

        return FeedSnapshot::fromRaw(
            baseUrl: $this->baseUrl,
            fetchedAtUtc: gmdate('c'),
            statsJson: $json,
            careerXml: $career,
            vehiclesXml: $vehiclesXml,
            economyXml: $economyXml,
        );
    }

    /**
     * Overview / polling: stats JSON only (one HTTP call, short timeout friendly).
     */
    public function fetchLightSnapshot(): FeedSnapshot
    {
        $json = $this->fetchStatsJson();

        return FeedSnapshot::fromRaw(
            baseUrl: $this->baseUrl,
            fetchedAtUtc: gmdate('c'),
            statsJson: $json,
            careerXml: '',
            vehiclesXml: '',
            economyXml: '',
        );
    }

    /**
     * @param  array<string, string>  $extraQuery
     */
    private function get(string $path, array $extraQuery = []): string
    {
        $query = array_merge(['code' => $this->code], $extraQuery);
        $url = $this->baseUrl.$path;

        try {
            $response = Http::timeout($this->timeoutSeconds)
                ->accept('*/*')
                ->withHeaders([
                    'User-Agent' => 'AgravionFeedClient/0.1',
                ])
                ->get($url, $query);
        } catch (ConnectionException $e) {
            throw new RuntimeException('Feed connection failed: '.$e->getMessage(), 0, $e);
        }

        if ($response->status() === 204) {
            return '';
        }

        try {
            $response->throw();
        } catch (RequestException $e) {
            throw new RuntimeException(
                'Feed HTTP '.$response->status().' for '.$path,
                0,
                $e
            );
        }

        return (string) $response->body();
    }
}
