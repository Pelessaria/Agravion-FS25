<?php

namespace App\Services\Fs25;

use App\Models\HostAccess;
use League\Flysystem\Filesystem;
use League\Flysystem\FilesystemException;
use League\Flysystem\PhpseclibV3\SftpAdapter;
use League\Flysystem\PhpseclibV3\SftpConnectionProvider;
use League\Flysystem\StorageAttributes;
use RuntimeException;
use Throwable;

/**
 * Read-only remote filesystem for dedicated-server savegames / modSettings.
 * SFTP → Flysystem/phpseclib; FTP/FTPS → cURL (explicit AUTH TLS on :21).
 */
final class HostFileClient
{
    private ?Filesystem $sftp = null;

    private ?CurlFtpClient $ftp = null;

    private string $protocol;

    private string $host;

    private int $port;

    private string $username = '';

    private string $password = '';

    private string $root = '';

    public function __construct(HostAccess $access)
    {
        $password = $access->password();
        if ($password === null || $password === '') {
            throw new RuntimeException('Host-Passwort ist nicht konfiguriert.');
        }

        $this->protocol = strtolower($access->protocol);
        $this->host = trim($access->host);
        $this->port = $access->port > 0
            ? $access->port
            : ($this->protocol === 'sftp' ? 22 : 21);
        $this->username = $access->username;
        $this->password = $password;
        $this->root = $this->normalizePath((string) ($access->remote_root ?? ''));

        $tcp = HostConnectionError::tcpProbe($this->host, $this->port, 8.0);
        if (! $tcp['ok']) {
            throw new RuntimeException(
                "Kein TCP-Connect ({$this->protocol} {$this->host}:{$this->port}). {$tcp['detail']} "
                .'AgriVision-VM → Ziel prüfen (DNS, Routing, ausgehende Firewall).'
            );
        }

        try {
            if ($this->protocol === 'sftp') {
                $provider = new SftpConnectionProvider(
                    host: $this->host,
                    username: $access->username,
                    password: $password,
                    port: $this->port,
                    timeout: 12,
                );
                $this->sftp = new Filesystem(new SftpAdapter($provider, $this->root === '' ? '/' : $this->root));
            } elseif ($this->protocol === 'ftps' || $this->protocol === 'ftp') {
                $this->ftp = new CurlFtpClient($access);
            } else {
                throw new RuntimeException("Unbekanntes Protokoll: {$this->protocol}");
            }
        } catch (Throwable $e) {
            throw new RuntimeException(
                HostConnectionError::format($e, "Verbindung {$this->protocol} {$this->host}:{$this->port}"),
                0,
                $e
            );
        }
    }

    public function endpointLabel(): string
    {
        if ($this->ftp) {
            return $this->ftp->modeLabel()." {$this->host}:{$this->port}";
        }

        return strtoupper($this->protocol)." {$this->host}:{$this->port}";
    }

    /**
     * @return list<string>
     */
    public function listDirectories(string $path = ''): array
    {
        try {
            if ($this->ftp) {
                return $this->ftp->listDirectories($path);
            }

            $path = $this->normalizePath($path);
            $listing = $this->sftp()->listContents($path === '' ? '' : $path, false);
            $dirs = [];
            /** @var StorageAttributes $item */
            foreach ($listing as $item) {
                if ($item->isDir()) {
                    $dirs[] = $item->path();
                }
            }
            sort($dirs);

            return $dirs;
        } catch (Throwable $e) {
            throw new RuntimeException(
                HostConnectionError::format($e, 'Verzeichnislisting '.$this->endpointLabel()),
                0,
                $e
            );
        }
    }

    public function fileExists(string $path): bool
    {
        try {
            if ($this->ftp) {
                return $this->ftp->fileExists($path);
            }

            return $this->sftp()->fileExists($this->normalizePath($path));
        } catch (FilesystemException|RuntimeException) {
            return false;
        }
    }

    /**
     * @return list<string> basenames in a directory
     */
    public function listNames(string $path = ''): array
    {
        try {
            if ($this->ftp) {
                return $this->ftp->listNames($path);
            }

            $path = $this->normalizePath($path);
            $listing = $this->sftp()->listContents($path === '' ? '' : $path, false);
            $names = [];
            /** @var StorageAttributes $item */
            foreach ($listing as $item) {
                $names[] = basename(str_replace('\\', '/', $item->path()));
            }
            sort($names);

            return array_values(array_unique($names));
        } catch (Throwable $e) {
            throw new RuntimeException(
                HostConnectionError::format($e, 'Listing '.$path.' @ '.$this->endpointLabel()),
                0,
                $e
            );
        }
    }

    public function read(string $path, ?int $timeoutSec = null): string
    {
        try {
            if ($this->ftp) {
                return $this->ftp->read($path, $timeoutSec);
            }

            return $this->sftp()->read($this->normalizePath($path));
        } catch (Throwable $e) {
            throw new RuntimeException(
                HostConnectionError::format($e, 'Lesen '.$path.' @ '.$this->endpointLabel()),
                0,
                $e
            );
        }
    }

    public function fileSize(string $path): int
    {
        try {
            if ($this->ftp) {
                return $this->ftp->fileSize($path);
            }
            $size = $this->sftp()->fileSize($this->normalizePath($path));
            if (! is_int($size) || $size < 0) {
                throw new RuntimeException('Dateigröße unbekannt: '.$path);
            }

            return $size;
        } catch (Throwable $e) {
            throw new RuntimeException(
                HostConnectionError::format($e, 'Größe '.$path.' @ '.$this->endpointLabel()),
                0,
                $e
            );
        }
    }

    public function readRange(string $path, int $offset, int $length): string
    {
        if ($length < 1) {
            return '';
        }
        try {
            if ($this->ftp) {
                return $this->ftp->readRange($path, $offset, $length);
            }

            $remote = $this->normalizePath($path);
            if ($this->root !== '') {
                $remote = $this->root.'/'.$remote;
            }
            $sftp = new \phpseclib3\Net\SFTP($this->host, $this->port, 20);
            if (! $sftp->login($this->username, $this->password)) {
                throw new RuntimeException('SFTP-Login für Bereichslesung fehlgeschlagen.');
            }
            $sftp->setTimeout(180);
            $data = $sftp->get($remote, false, $offset, $length);
            if (! is_string($data)) {
                throw new RuntimeException('Bereichslesung leer: '.$path);
            }

            return $data;
        } catch (Throwable $e) {
            throw new RuntimeException(
                HostConnectionError::format($e, 'Bereich '.$path.' @ '.$this->endpointLabel()),
                0,
                $e
            );
        }
    }

    public function writeFile(string $path, string $localPath): void
    {
        if (! is_file($localPath)) {
            throw new RuntimeException('Lokale Datei nicht lesbar.');
        }

        try {
            if ($this->ftp) {
                $this->ftp->writeFile($path, $localPath);

                return;
            }

            $handle = fopen($localPath, 'rb');
            if ($handle === false) {
                throw new RuntimeException('Lokale Datei nicht lesbar.');
            }
            try {
                $path = $this->normalizePath($path);
                $parent = dirname(str_replace('\\', '/', $path));
                if ($parent !== '.' && $parent !== '') {
                    $this->ensureDirectory($parent);
                }
                $this->sftp()->writeStream($path, $handle);
            } finally {
                if (is_resource($handle)) {
                    fclose($handle);
                }
            }
        } catch (Throwable $e) {
            throw new RuntimeException(
                HostConnectionError::format($e, 'Schreiben '.$path.' @ '.$this->endpointLabel()),
                0,
                $e
            );
        }
    }

    public function write(string $path, string $contents): void
    {
        try {
            if ($this->ftp) {
                $this->ftp->write($path, $contents);

                return;
            }

            $path = $this->normalizePath($path);
            $parent = dirname(str_replace('\\', '/', $path));
            if ($parent !== '.' && $parent !== '') {
                $this->ensureDirectory($parent);
            }
            $this->sftp()->write($path, $contents);
        } catch (Throwable $e) {
            throw new RuntimeException(
                HostConnectionError::format($e, 'Schreiben '.$path.' @ '.$this->endpointLabel()),
                0,
                $e
            );
        }
    }

    public function delete(string $path): void
    {
        try {
            if ($this->ftp) {
                $this->ftp->delete($path);

                return;
            }

            $this->sftp()->delete($this->normalizePath($path));
        } catch (Throwable $e) {
            throw new RuntimeException(
                HostConnectionError::format($e, 'Löschen '.$path.' @ '.$this->endpointLabel()),
                0,
                $e
            );
        }
    }

    public function ensureDirectory(string $path): void
    {
        $path = $this->normalizePath($path);
        if ($path === '') {
            return;
        }

        try {
            if ($this->ftp) {
                $this->ftp->ensureDirectory($path);

                return;
            }

            $fs = $this->sftp();
            $parts = explode('/', $path);
            $built = '';
            foreach ($parts as $part) {
                $built = $built === '' ? $part : $built.'/'.$part;
                if (! $fs->directoryExists($built)) {
                    $fs->createDirectory($built);
                }
            }
        } catch (Throwable $e) {
            throw new RuntimeException(
                HostConnectionError::format($e, 'Ordner '.$path.' @ '.$this->endpointLabel()),
                0,
                $e
            );
        }
    }

    /**
     * @return array{
     *   savegame: string|null,
     *   savegames: list<array{slotKey: string, path: string}>,
     *   modSettings: string|null,
     *   candidates: list<string>
     * }
     */
    public function probePaths(?string $hintSavegame = null, ?string $hintModSettings = null): array
    {
        $modSettings = null;
        $candidates = [];
        $listErrors = [];
        /** @var array<string, string> $savegames path by slot key */
        $savegames = [];

        if ($hintSavegame && $this->looksLikeSavegameDir($hintSavegame)) {
            $slot = $this->slotKeyFromPath($hintSavegame);
            $savegames[$slot] = $this->normalizePath($hintSavegame);
        }
        if ($hintModSettings && $this->directoryLooksPresent($hintModSettings)) {
            $modSettings = $this->normalizePath($hintModSettings);
        }

        $roots = [''];
        try {
            $top = $this->listDirectories('');
            $candidates = array_merge($candidates, $top);
            foreach ($top as $dir) {
                $base = strtolower(basename(str_replace('\\', '/', $dir)));
                if (in_array($base, ['documents', 'my games', 'farming simulator 25', 'farmingsimulator25', 'fs25'], true)) {
                    $roots[] = $dir;
                }
                $this->collectSavegameCandidate($dir, $savegames);
                if ($base === 'modsettings') {
                    $modSettings ??= $this->normalizePath($dir);
                }
            }
        } catch (Throwable $e) {
            $listErrors[] = HostConnectionError::format($e);
        }

        foreach ($roots as $root) {
            if ($modSettings === null) {
                $found = $this->findNamedDir($root, ['modsettings', 'modSettings']);
                if ($found) {
                    $modSettings = $found;
                }
            }

            try {
                foreach ($this->listDirectories($root) as $child) {
                    $candidates[] = $child;
                    $this->collectSavegameCandidate($child, $savegames);
                    $base = strtolower(basename(str_replace('\\', '/', $child)));
                    if ($modSettings === null && $base === 'modsettings') {
                        $modSettings = $this->normalizePath($child);
                    }

                    // One more level (My Games / FarmingSimulator25). Nested copies under
                    // *backup* still register, but preferSavegamePath keeps live slots.
                    try {
                        foreach ($this->listDirectories($child) as $grand) {
                            $candidates[] = $grand;
                            $this->collectSavegameCandidate($grand, $savegames);
                            $gbase = strtolower(basename(str_replace('\\', '/', $grand)));
                            if ($modSettings === null && $gbase === 'modsettings') {
                                $modSettings = $this->normalizePath($grand);
                            }
                        }
                    } catch (Throwable) {
                        // ignore deeper listing failures
                    }
                }
            } catch (Throwable $e) {
                $listErrors[] = HostConnectionError::format($e);
            }
        }

        if ($savegames === [] && $modSettings === null && $listErrors !== []) {
            throw new RuntimeException(
                'Pfad-Suche fehlgeschlagen: '.$listErrors[0]
                .' — optional Savegame-Pfad manuell setzen.'
            );
        }

        ksort($savegames, SORT_NATURAL | SORT_FLAG_CASE);
        $list = [];
        foreach ($savegames as $slot => $path) {
            $list[] = ['slotKey' => $slot, 'path' => $path];
        }

        $primary = $list[0]['path'] ?? null;

        return [
            'savegame' => $primary,
            'savegames' => $list,
            'modSettings' => $modSettings,
            'candidates' => array_values(array_unique($candidates)),
        ];
    }

    /**
     * @param  array<string, string>  $savegames
     */
    private function collectSavegameCandidate(string $dir, array &$savegames): void
    {
        $base = basename(str_replace('\\', '/', $dir));
        if (! preg_match('/^savegame\d*$/i', $base)) {
            return;
        }
        if (! $this->looksLikeSavegameDir($dir)) {
            return;
        }
        $slot = strtolower($base);
        $candidate = $this->normalizePath($dir);
        $savegames[$slot] = self::preferSavegamePath($savegames[$slot] ?? null, $candidate);
    }

    /**
     * Prefer live top-level slots over nested copies under backup/archive folders.
     */
    public static function preferSavegamePath(?string $current, string $candidate): string
    {
        $candidate = trim(str_replace('\\', '/', $candidate), '/');
        if ($current === null || $current === '') {
            return $candidate;
        }
        $current = trim(str_replace('\\', '/', $current), '/');
        if ($current === $candidate) {
            return $current;
        }

        $currentBackup = self::pathLooksLikeBackup($current);
        $candidateBackup = self::pathLooksLikeBackup($candidate);
        if ($currentBackup !== $candidateBackup) {
            return $candidateBackup ? $current : $candidate;
        }

        $currentDepth = substr_count($current, '/');
        $candidateDepth = substr_count($candidate, '/');
        if ($currentDepth !== $candidateDepth) {
            return $candidateDepth < $currentDepth ? $candidate : $current;
        }

        return strlen($candidate) < strlen($current) ? $candidate : $current;
    }

    public static function pathLooksLikeBackup(string $path): bool
    {
        $normalized = strtolower(str_replace('\\', '/', $path));
        foreach (explode('/', $normalized) as $segment) {
            if ($segment === '') {
                continue;
            }
            if (preg_match('/(?:^|[_-])(backup|bak|old|copy|archiv|archive|tmp|temp)(?:$|[_-])/i', $segment)) {
                return true;
            }
            if (in_array($segment, ['backup', 'backups', 'bak', 'old', 'archive', 'archives', 'archiv'], true)) {
                return true;
            }
        }

        return false;
    }

    private function slotKeyFromPath(string $path): string
    {
        $base = strtolower(basename(str_replace('\\', '/', $this->normalizePath($path))));

        return preg_match('/^savegame\d*$/', $base) ? $base : $base;
    }

    private function sftp(): Filesystem
    {
        if (! $this->sftp) {
            throw new RuntimeException('SFTP-Client nicht initialisiert.');
        }

        return $this->sftp;
    }

    private function findNamedDir(string $parent, array $names): ?string
    {
        $want = array_map('strtolower', $names);
        try {
            foreach ($this->listDirectories($parent) as $dir) {
                $base = strtolower(basename(str_replace('\\', '/', $dir)));
                if (in_array($base, $want, true) || preg_match('/^savegame\d*$/i', $base)) {
                    if (str_starts_with($base, 'savegame') && ! $this->looksLikeSavegameDir($dir)) {
                        continue;
                    }

                    return $this->normalizePath($dir);
                }
            }
        } catch (Throwable) {
            return null;
        }

        return null;
    }

    private function looksLikeSavegameDir(string $path): bool
    {
        $path = $this->normalizePath($path);
        if ($this->fileExists($path.'/farms.xml') || $this->fileExists($path.'/careerSavegame.xml')) {
            return true;
        }

        return $this->directoryLooksPresent($path);
    }

    private function directoryLooksPresent(string $path): bool
    {
        try {
            $this->listDirectories($path);

            return true;
        } catch (Throwable) {
            return false;
        }
    }

    private function normalizePath(string $path): string
    {
        $path = str_replace('\\', '/', trim($path));
        $path = trim($path, '/');

        return $path;
    }
}
