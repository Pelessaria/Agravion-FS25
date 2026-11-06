<?php

namespace App\Services\Fs25;

use App\Models\HostAccess;
use App\Models\Workspace;
use RuntimeException;
use Throwable;

/**
 * Serve the packaged connector zip from the repo and push it to the game host mods folder.
 */
final class ConnectorDeployService
{
    public const MOD_ZIP = 'FS25_AgravionConnector.zip';

    public const MOD_NAME = 'FS25_AgravionConnector';

    public function packagePath(): string
    {
        // Prefer backend/resources (survives GitHub zipball overlay of Laravel root).
        $candidates = [
            base_path('resources/connector/'.self::MOD_ZIP),
            base_path('../connector/dist/'.self::MOD_ZIP),
            dirname(base_path()).'/connector/dist/'.self::MOD_ZIP,
        ];
        foreach ($candidates as $path) {
            $real = realpath($path);
            if ($real !== false && is_file($real)) {
                return $real;
            }
        }

        throw new RuntimeException(
            'Connector-Paket fehlt (resources/connector/'.self::MOD_ZIP.'). Bitte connector/pack.ps1 ausführen.'
        );
    }

    public function packageVersion(): ?string
    {
        try {
            $zipPath = $this->packagePath();
        } catch (Throwable) {
            return $this->versionFromModDescFile();
        }

        if (! class_exists(\ZipArchive::class)) {
            return $this->versionFromModDescFile();
        }

        $zip = new \ZipArchive;
        if ($zip->open($zipPath) !== true) {
            return $this->versionFromModDescFile();
        }
        $raw = $zip->getFromName('modDesc.xml');
        $zip->close();
        if (! is_string($raw) || $raw === '') {
            return $this->versionFromModDescFile();
        }
        $fromZip = null;
        if (preg_match('/<version>\s*([^<]+)\s*<\/version>/i', $raw, $m)) {
            $fromZip = trim($m[1]) ?: null;
        }
        $fromFile = $this->versionFromModDescFile();
        if ($fromFile !== null && ($fromZip === null || $this->versionIsNewer($fromFile, $fromZip))) {
            return $fromFile;
        }

        return $fromZip;
    }

    private function versionIsNewer(string $left, string $right): bool
    {
        $a = array_map('intval', explode('.', preg_replace('/[^0-9.]/', '', $left) ?? '0'));
        $b = array_map('intval', explode('.', preg_replace('/[^0-9.]/', '', $right) ?? '0'));
        $len = max(count($a), count($b), 4);
        for ($i = 0; $i < $len; $i++) {
            $av = $a[$i] ?? 0;
            $bv = $b[$i] ?? 0;
            if ($av === $bv) {
                continue;
            }

            return $av > $bv;
        }

        return false;
    }

    private function versionFromModDescFile(): ?string
    {
        $modDesc = $this->modDescPath();
        if ($modDesc === null) {
            return null;
        }
        $raw = @file_get_contents($modDesc);
        if (! is_string($raw) || ! preg_match('/<version>\s*([^<]+)\s*<\/version>/i', $raw, $m)) {
            return null;
        }

        return trim($m[1]) ?: null;
    }

    /**
     * @return array{ok: bool, error: string|null, remotePath: string|null, bytes: int|null, version: string|null, restarted: bool, note: string|null}
     */
    public function deploy(Workspace $workspace, ?string $modsPathHint = null): array
    {
        $access = HostAccess::query()->where('workspace_id', $workspace->id)->first();
        if (! $access) {
            return $this->fail('Dateizugang nicht konfiguriert.');
        }

        set_time_limit(0);
        $console = new DedicatedServerConsole;
        $stoppedByUs = false;
        try {
            $local = $this->packagePath();
            $bytes = filesize($local);
            if ($bytes === false || $bytes < 1) {
                return $this->fail('Connector-Paket ist leer oder unlesbar.');
            }

            try {
                $stoppedByUs = $console->stopIfRunning($workspace);
            } catch (Throwable $e) {
                return $this->fail($e->getMessage());
            }
            if ($stoppedByUs) {
                // The web UI flips before Windows releases the zip handle.
                sleep(5);
            }

            $client = new HostFileClient($access);
            $modsDir = self::knownModsDirectory($access, $modsPathHint);
            $remote = rtrim($modsDir, '/').'/'.self::MOD_ZIP;
            $last = null;
            for ($attempt = 0; $attempt < 4; $attempt++) {
                try {
                    $client->writeFile($remote, $local);
                    $version = $this->packageVersion();
                    if (is_string($version) && $version !== '') {
                        try {
                            $console->stampModFile($workspace, self::MOD_ZIP, $version, (int) $bytes);
                        } catch (Throwable) {
                            // The file is on the host. The next hello read still corrects the cache.
                        }
                    }
                    $note = null;
                    if ($stoppedByUs) {
                        try {
                            $console->run($workspace, 'start');
                        } catch (Throwable $e) {
                            $note = 'Die Datei liegt auf dem Server. Der Dedicated Server ließ sich danach nicht starten: '.$e->getMessage();
                        }
                    }

                    return [
                        'ok' => true,
                        'error' => null,
                        'remotePath' => $remote,
                        'bytes' => (int) $bytes,
                        'version' => $version,
                        'restarted' => $stoppedByUs && $note === null,
                        'note' => $note,
                    ];
                } catch (Throwable $e) {
                    $last = $e;
                    if ($attempt < 3 && $this->fileStillLocked($e)) {
                        sleep(4);
                        continue;
                    }
                    break;
                }
            }

            if ($stoppedByUs) {
                try {
                    $console->run($workspace, 'start');
                } catch (Throwable) {
                    // The upload already failed. Leave the start error out of the message.
                }
            }

            $message = HostConnectionError::format($last ?? new RuntimeException('Upload fehlgeschlagen.'), 'Connector-Deploy');
            if ($last !== null && $this->fileStillLocked($last)) {
                $message = 'Der Dedicated Server hält mods/'.self::MOD_ZIP.' offen. Windows gibt die Datei erst frei, wenn der Prozess aus ist. '.$message;
            }

            return $this->fail($message);
        } catch (Throwable $e) {
            return $this->fail(HostConnectionError::format($e, 'Connector-Deploy'));
        }
    }

    private function fileStillLocked(Throwable $error): bool
    {
        $text = strtolower($error->getMessage());

        return str_contains($text, 'timed out')
            || str_contains($text, '0 bytes')
            || str_contains($text, '550')
            || str_contains($text, 'being used')
            || str_contains($text, 'permission')
            || str_contains($text, 'locked');
    }

    /**
     * The mods folder sits next to modSettings. Listing it just to confirm the name
     * opens a second FTP session and is what made the upload fail while another
     * job was already connected.
     */
    public static function knownModsDirectory(HostAccess $access, ?string $hint = null): string
    {
        $hint = $hint !== null ? trim(str_replace('\\', '/', $hint), '/') : '';
        if ($hint !== '') {
            return $hint;
        }
        $modSettings = trim(str_replace('\\', '/', (string) ($access->remote_mod_settings_path ?? '')), '/');
        if ($modSettings === '') {
            return 'mods';
        }
        $parent = trim(dirname($modSettings), '/.');

        return $parent === '' || $parent === '.' ? 'mods' : $parent.'/mods';
    }

    public static function resolveModsDirectory(HostFileClient $client, HostAccess $access, ?string $hint = null): string
    {
        $hint = $hint !== null ? trim(str_replace('\\', '/', $hint)) : '';
        if ($hint !== '') {
            return trim($hint, '/');
        }

        $modSettings = trim(str_replace('\\', '/', (string) ($access->remote_mod_settings_path ?? '')), '/');
        if ($modSettings !== '') {
            $parent = trim(dirname($modSettings), '/.');
            $siblings = ['mods', 'Mods', 'MODS'];
            foreach ($siblings as $name) {
                $candidate = $parent === '' || $parent === '.' ? $name : $parent.'/'.$name;
                if ($client->fileExists($candidate) || self::dirLooksPresent($client, $candidate)) {
                    return $candidate;
                }
            }

            return $parent === '' || $parent === '.' ? 'mods' : $parent.'/mods';
        }

        foreach (['mods', 'Mods', 'My Games/FarmingSimulator25/mods', 'Documents/My Games/FarmingSimulator25/mods'] as $candidate) {
            if (self::dirLooksPresent($client, $candidate)) {
                return $candidate;
            }
        }

        return 'mods';
    }

    private static function dirLooksPresent(HostFileClient $client, string $path): bool
    {
        try {
            $client->listDirectories($path);

            return true;
        } catch (Throwable) {
            return false;
        }
    }

    private function modDescPath(): ?string
    {
        $candidates = [
            base_path('../connector/FS25_AgravionConnector/modDesc.xml'),
            base_path('connector/FS25_AgravionConnector/modDesc.xml'),
            dirname(base_path()).'/connector/FS25_AgravionConnector/modDesc.xml',
        ];
        foreach ($candidates as $path) {
            $real = realpath($path);
            if ($real !== false && is_file($real)) {
                return $real;
            }
        }

        return null;
    }

    /**
     * @return array{ok: bool, error: string|null, remotePath: string|null, bytes: int|null, version: string|null, restarted: bool, note: string|null}
     */
    private function fail(string $error): array
    {
        return [
            'ok' => false,
            'error' => $error,
            'remotePath' => null,
            'bytes' => null,
            'version' => $this->packageVersion(),
            'restarted' => false,
            'note' => null,
        ];
    }
}
