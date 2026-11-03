<?php

namespace App\Services\Fs25;

use App\Models\HostAccess;
use RuntimeException;

/**
 * FTP / explicit FTPS / implicit FTPS via cURL (game hosts usually need AUTH TLS on :21).
 */
final class CurlFtpClient
{
    private string $host;

    private int $port;

    private string $username;

    private string $password;

    private string $root;

    /** @var 'ftp'|'ftps_explicit'|'ftps_implicit' */
    private string $mode;

    public function __construct(HostAccess $access)
    {
        if (! function_exists('curl_init')) {
            throw new RuntimeException('PHP-cURL fehlt — FTP/FTPS nicht nutzbar.');
        }

        $password = $access->password();
        if ($password === null || $password === '') {
            throw new RuntimeException('Host-Passwort ist nicht konfiguriert.');
        }

        $protocol = strtolower($access->protocol);
        $this->host = trim($access->host);
        $this->port = $access->port > 0 ? $access->port : ($protocol === 'ftps' ? 21 : 21);
        $this->username = $access->username;
        $this->password = $password;
        $this->root = $this->normalizePath((string) ($access->remote_root ?? ''));

        if ($protocol === 'ftp') {
            $this->mode = 'ftp';
        } elseif ($protocol === 'ftps') {
            // Port 990 → implicit; otherwise explicit AUTH TLS (typical FileZilla / hoster FTPS).
            $this->mode = $this->port === 990 ? 'ftps_implicit' : 'ftps_explicit';
        } else {
            throw new RuntimeException('CurlFtpClient unterstützt nur ftp/ftps.');
        }
    }

    /**
     * @return list<string>
     */
    public function listDirectories(string $path = ''): array
    {
        $listing = $this->listNames($path);
        $dirs = [];
        $base = $this->normalizePath($path);
        foreach ($listing as $name) {
            if ($name === '.' || $name === '..') {
                continue;
            }
            // DIRLISTONLY has no type — treat every name as candidate path; callers probe.
            $dirs[] = $base === '' ? $name : $base.'/'.$name;
        }
        sort($dirs);

        return $dirs;
    }

    /**
     * @return list<string>
     */
    public function listNames(string $path = ''): array
    {
        $url = $this->urlForPath($path, true);

        // Prefer NLST/DIRLISTONLY; many FTPS hosts return empty or a full LIST instead.
        try {
            $body = $this->exec($url, [
                CURLOPT_DIRLISTONLY => true,
            ], 'NLST '.$path);
            $names = $this->parseNlstBody($body);
            if ($names !== []) {
                return $names;
            }
        } catch (RuntimeException) {
            // Fall through to full LIST.
        }

        $body = $this->exec($url, [], 'LIST '.$path);

        return $this->parseListBody($body);
    }

    public function delete(string $path): void
    {
        $normalized = $this->normalizePath($path);
        $parent = dirname(str_replace('\\', '/', $normalized));
        if ($parent === '.' || $parent === '/') {
            $parent = '';
        }
        $base = basename(str_replace('\\', '/', $normalized));
        $url = $this->urlForPath($parent, true);
        $this->exec($url, [
            CURLOPT_DIRLISTONLY => true,
            CURLOPT_POSTQUOTE => ['DELE '.$base],
        ], 'DELETE '.$path);
    }

    public function fileExists(string $path): bool
    {
        // Avoid downloading the whole file: LIST parent and match basename.
        $normalized = $this->normalizePath($path);
        if ($normalized === '') {
            return false;
        }
        $parent = dirname(str_replace('\\', '/', $normalized));
        if ($parent === '.' || $parent === '/') {
            $parent = '';
        }
        $base = basename(str_replace('\\', '/', $normalized));
        try {
            foreach ($this->listNames($parent) as $name) {
                if (strcasecmp($name, $base) === 0) {
                    return true;
                }
            }
        } catch (RuntimeException) {
            return false;
        }

        return false;
    }

    /**
     * @return list<string>
     */
    private function parseNlstBody(string $body): array
    {
        $lines = preg_split('/\r\n|\n|\r/', trim($body)) ?: [];
        $out = [];
        foreach ($lines as $line) {
            $line = trim($line);
            if ($line === '') {
                continue;
            }
            // Server ignored DIRLISTONLY and returned Unix/Windows LIST — use parseListBody.
            if ($this->looksLikeListLine($line)) {
                return $this->parseListBody($body);
            }
            $name = basename(str_replace('\\', '/', $line));
            if ($name !== '' && $name !== '.' && $name !== '..') {
                $out[] = $name;
            }
        }

        return array_values(array_unique($out));
    }

    /**
     * @return list<string>
     */
    private function parseListBody(string $body): array
    {
        $lines = preg_split('/\r\n|\n|\r/', trim($body)) ?: [];
        $out = [];
        foreach ($lines as $line) {
            $line = rtrim($line);
            if ($line === '') {
                continue;
            }
            $name = $this->nameFromListLine($line);
            if ($name !== null) {
                $out[] = $name;
            }
        }

        return array_values(array_unique($out));
    }

    private function looksLikeListLine(string $line): bool
    {
        return (bool) preg_match('/^(?:[bcdlps-][rwxstSTlL-]{9}|[A-Za-z]{3}\s+\d{1,2}\s|[\d-]{8}\s+[\d:]{5}|\d{2}-\d{2}-\d{2}\s)/', $line)
            || str_contains($line, '<DIR>');
    }

    private function nameFromListLine(string $line): ?string
    {
        // Windows IIS: "01-15-25  12:00PM       1234 filename.dds" / "<DIR> folder"
        if (preg_match('/^\d{2}-\d{2}-\d{2}\s+\d{1,2}:\d{2}(?:AM|PM)\s+(?:<DIR>|\d+)\s+(.+)$/i', $line, $m)) {
            $name = trim($m[1]);

            return ($name !== '' && $name !== '.' && $name !== '..') ? $name : null;
        }

        // Unix/FileZilla: permissions … name (last field; names rarely have spaces for store icons)
        if (preg_match('/^[bcdlps-][rwxstSTlL-]{9}\s+\d+\s+\S+\s+\S+\s+\d+\s+\S+\s+\d+\s+\S+\s+(.+)$/', $line, $m)
            || preg_match('/^[bcdlps-][rwxstSTlL-]{9}\s+\d+\s+\S+\s+\S+\s+\d+\s+\S+\s+\d{1,2}\s+\d{2}:\d{2}\s+(.+)$/', $line, $m)) {
            $name = trim($m[1]);

            return ($name !== '' && $name !== '.' && $name !== '..') ? $name : null;
        }

        // Fallback: last whitespace-separated token if line looks structured
        if ($this->looksLikeListLine($line)) {
            $parts = preg_split('/\s+/', trim($line)) ?: [];
            $name = (string) end($parts);
            $name = basename(str_replace('\\', '/', $name));

            return ($name !== '' && $name !== '.' && $name !== '..') ? $name : null;
        }

        $name = basename(str_replace('\\', '/', trim($line)));

        return ($name !== '' && $name !== '.' && $name !== '..') ? $name : null;
    }

    public function read(string $path, ?int $timeoutSec = null): string
    {
        $url = $this->urlForPath($path, false);
        $extra = [];
        if ($timeoutSec !== null && $timeoutSec > 0) {
            $extra[CURLOPT_TIMEOUT] = $timeoutSec;
        }

        return $this->exec($url, $extra, 'READ '.$path);
    }

    public function write(string $path, string $contents): void
    {
        $tmp = tmpfile();
        if ($tmp === false) {
            throw new RuntimeException('TEMP-Datei für Upload nicht erstellbar.');
        }
        fwrite($tmp, $contents);
        rewind($tmp);
        $meta = stream_get_meta_data($tmp);
        $local = $meta['uri'] ?? null;
        if (! is_string($local) || $local === '') {
            fclose($tmp);
            throw new RuntimeException('TEMP-Pfad für Upload fehlt.');
        }

        try {
            $url = $this->urlForPath($path, false);
            $this->exec($url, [
                CURLOPT_UPLOAD => true,
                CURLOPT_INFILE => $tmp,
                CURLOPT_INFILESIZE => strlen($contents),
                // Create parent folders on the host when missing (mods/, etc.).
                CURLOPT_FTP_CREATE_MISSING_DIRS => defined('CURLFTP_CREATE_DIR_RETRY')
                    ? CURLFTP_CREATE_DIR_RETRY
                    : 2,
            ], 'WRITE '.$path);
        } finally {
            fclose($tmp);
        }
    }

    public function writeFile(string $path, string $localPath): void
    {
        $handle = fopen($localPath, 'rb');
        if ($handle === false) {
            throw new RuntimeException('Lokale Datei nicht lesbar.');
        }
        $size = filesize($localPath);
        if ($size === false) {
            fclose($handle);
            throw new RuntimeException('Lokale Datei nicht lesbar.');
        }

        try {
            $url = $this->urlForPath($path, false);
            $this->exec($url, [
                CURLOPT_UPLOAD => true,
                CURLOPT_INFILE => $handle,
                CURLOPT_INFILESIZE => $size,
                CURLOPT_TIMEOUT => 0,
                CURLOPT_FTP_CREATE_MISSING_DIRS => defined('CURLFTP_CREATE_DIR_RETRY')
                    ? CURLFTP_CREATE_DIR_RETRY
                    : 2,
            ], 'WRITE '.$path);
        } finally {
            fclose($handle);
        }
    }

    public function ensureDirectory(string $path): void
    {
        $path = $this->normalizePath($path);
        if ($path === '' || $this->directoryExists($path)) {
            return;
        }

        // Upload a tiny marker then delete is heavy; prefer CREATE_MISSING_DIRS on write.
        // Soft-create by listing parent and relying on write() for the zip path.
        $parent = dirname(str_replace('\\', '/', $path));
        if ($parent !== '.' && $parent !== '' && $parent !== '/') {
            $this->ensureDirectory($parent);
        }
    }

    public function directoryExists(string $path): bool
    {
        try {
            $this->listNames($path);

            return true;
        } catch (RuntimeException) {
            return false;
        }
    }

    public function modeLabel(): string
    {
        return match ($this->mode) {
            'ftp' => 'FTP (klartext)',
            'ftps_explicit' => 'FTPS explicit (AUTH TLS)',
            'ftps_implicit' => 'FTPS implicit',
        };
    }

    public function fileSize(string $path): int
    {
        $ch = $this->open($this->urlForPath($path, false));
        curl_setopt($ch, CURLOPT_NOBODY, true);
        curl_exec($ch);
        $errno = curl_errno($ch);
        $error = curl_error($ch);
        $size = (int) curl_getinfo($ch, CURLINFO_CONTENT_LENGTH_DOWNLOAD);
        curl_close($ch);
        if ($errno !== 0 || $size < 0) {
            $detail = $error !== '' ? $error : "cURL errno {$errno}";
            throw new RuntimeException('SIZE '.$path.' fehlgeschlagen: '.$detail);
        }

        return $size;
    }

    public function readRange(string $path, int $offset, int $length): string
    {
        $buf = '';
        $ch = $this->open($this->urlForPath($path, false));
        $resume = defined('CURLOPT_RESUME_FROM_LARGE') ? CURLOPT_RESUME_FROM_LARGE : CURLOPT_RESUME_FROM;
        curl_setopt($ch, $resume, $offset);
        curl_setopt($ch, CURLOPT_TIMEOUT, 180);
        curl_setopt($ch, CURLOPT_WRITEFUNCTION, function ($ch, string $data) use (&$buf, $length): int {
            $need = $length - strlen($buf);
            if ($need <= 0) {
                return 0;
            }
            if (strlen($data) > $need) {
                $buf .= substr($data, 0, $need);

                return 0;
            }
            $buf .= $data;

            return strlen($data);
        });
        curl_exec($ch);
        $errno = curl_errno($ch);
        $error = curl_error($ch);
        curl_close($ch);
        // Returning 0 from the write callback aborts with CURLE_WRITE_ERROR once the slice is full.
        if ($errno !== 0 && $errno !== 23) {
            $detail = $error !== '' ? $error : "cURL errno {$errno}";
            throw new RuntimeException('Bereich '.$path.' fehlgeschlagen: '.$detail);
        }
        if ($buf === '') {
            throw new RuntimeException('Bereich '.$path.' ist leer.');
        }

        return $buf;
    }

    /**
     * @param  array<int, mixed>  $extra
     */
    private function exec(string $url, array $extra, string $op): string
    {
        $ch = $this->open($url);
        if ($extra !== []) {
            curl_setopt_array($ch, $extra);
        }
        $body = curl_exec($ch);
        $errno = curl_errno($ch);
        $error = curl_error($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $primary = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($body === false || $errno !== 0) {
            $detail = $error !== '' ? $error : "cURL errno {$errno}";
            throw new RuntimeException(
                "{$op} fehlgeschlagen ({$this->modeLabel()} → {$this->host}:{$this->port}): {$detail}"
            );
        }

        // FTP response codes via curl are often 0 for successful transfers; treat clear failures.
        if ($status >= 400 || $primary >= 400) {
            throw new RuntimeException(
                "{$op} abgelehnt ({$this->modeLabel()} → {$this->host}:{$this->port}, Code ".max($status, $primary).').'
            );
        }

        return (string) $body;
    }

    private function open(string $url): \CurlHandle
    {
        $ch = curl_init($url);
        if ($ch === false) {
            throw new RuntimeException('cURL init fehlgeschlagen.');
        }

        $opts = [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_USERPWD => $this->username.':'.$this->password,
            CURLOPT_TIMEOUT => 45,
            CURLOPT_CONNECTTIMEOUT => 12,
            CURLOPT_FTP_USE_EPSV => true,
            // Many hosters sit behind NAT and advertise a private PASV IP.
            CURLOPT_FTP_SKIP_PASV_IP => true,
            CURLOPT_FOLLOWLOCATION => false,
        ];

        if ($this->mode === 'ftps_explicit') {
            $opts[CURLOPT_USE_SSL] = CURLFTPSSL_ALL;
            $opts[CURLOPT_FTPSSLAUTH] = CURLFTPAUTH_TLS;
            // Self-signed certs are common on dedicated-server hosts.
            $opts[CURLOPT_SSL_VERIFYPEER] = false;
            $opts[CURLOPT_SSL_VERIFYHOST] = 0;
        } elseif ($this->mode === 'ftps_implicit') {
            $opts[CURLOPT_SSL_VERIFYPEER] = false;
            $opts[CURLOPT_SSL_VERIFYHOST] = 0;
        }

        curl_setopt_array($ch, $opts);

        return $ch;
    }

    private function urlForPath(string $path, bool $asDirectory): string
    {
        $path = $this->normalizePath($path);
        $full = $this->root === '' ? $path : ($path === '' ? $this->root : $this->root.'/'.$path);
        $full = $this->normalizePath($full);

        $scheme = $this->mode === 'ftps_implicit' ? 'ftps' : 'ftp';
        $url = $scheme.'://'.$this->host.':'.$this->port.'/';
        if ($full !== '') {
            $url .= implode('/', array_map('rawurlencode', explode('/', $full)));
        }
        if ($asDirectory && ! str_ends_with($url, '/')) {
            $url .= '/';
        }

        return $url;
    }

    private function normalizePath(string $path): string
    {
        $path = str_replace('\\', '/', trim($path));
        $path = trim($path, '/');

        return $path;
    }
}
