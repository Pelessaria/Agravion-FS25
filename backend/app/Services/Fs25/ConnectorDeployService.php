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
    public const MOD_ZIP = 'FS25_AgriVisionConnector.zip';

    public const MOD_NAME = 'FS25_AgriVisionConnector';

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
        if (preg_match('/<version>\s*([^<]+)\s*<\/version>/i', $raw, $m)) {
            return trim($m[1]) ?: null;
        }

        return null;
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
     * @return array{ok: bool, error: string|null, remotePath: string|null, bytes: int|null, version: string|null}
     */
    public function deploy(Workspace $workspace, ?string $modsPathHint = null): array
    {
        $access = HostAccess::query()->where('workspace_id', $workspace->id)->first();
        if (! $access) {
            return $this->fail('Dateizugang nicht konfiguriert.');
        }

        try {
            $local = $this->packagePath();
            $bytes = filesize($local);
            if ($bytes === false || $bytes < 1) {
                return $this->fail('Connector-Paket ist leer oder unlesbar.');
            }

            $client = new HostFileClient($access);
            $modsDir = self::knownModsDirectory($access, $modsPathHint);
            $remote = rtrim($modsDir, '/').'/'.self::MOD_ZIP;
            $last = null;
            for ($attempt = 0; $attempt < 2; $attempt++) {
                try {
                    $client->writeFile($remote, $local);

                    return [
                        'ok' => true,
                        'error' => null,
                        'remotePath' => $remote,
                        'bytes' => (int) $bytes,
                        'version' => $this->packageVersion(),
                    ];
                } catch (Throwable $e) {
                    $last = $e;
                    if ($attempt === 0) {
                        usleep(2_000_000);
                    }
                }
            }

            return $this->fail(HostConnectionError::format($last ?? new RuntimeException('Upload fehlgeschlagen.'), 'Connector-Deploy'));
        } catch (Throwable $e) {
            return $this->fail(HostConnectionError::format($e, 'Connector-Deploy'));
        }
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
            base_path('../connector/FS25_AgriVisionConnector/modDesc.xml'),
            base_path('connector/FS25_AgriVisionConnector/modDesc.xml'),
            dirname(base_path()).'/connector/FS25_AgriVisionConnector/modDesc.xml',
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
     * @return array{ok: bool, error: string|null, remotePath: string|null, bytes: int|null, version: string|null}
     */
    private function fail(string $error): array
    {
        return [
            'ok' => false,
            'error' => $error,
            'remotePath' => null,
            'bytes' => null,
            'version' => $this->packageVersion(),
        ];
    }
}
