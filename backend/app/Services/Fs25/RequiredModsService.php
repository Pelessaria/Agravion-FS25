<?php

namespace App\Services\Fs25;

use App\Models\HostAccess;
use App\Models\Workspace;
use Throwable;

/**
 * Required game-host mods: installed (zip on FTP) vs activated (loaded in feed / hello.xml).
 */
final class RequiredModsService
{
    /**
     * @return list<array{
     *   id: string,
     *   title: string,
     *   zipName: string,
     *   folderName: string,
     *   matchNames: list<string>,
     *   required: bool,
     *   deployable: bool
     * }>
     */
    public function catalog(): array
    {
        return [
            [
                'id' => 'FS25_AgriVisionConnector',
                'title' => 'AgriVision Connector',
                'zipName' => ConnectorDeployService::MOD_ZIP,
                'folderName' => ConnectorDeployService::MOD_NAME,
                'matchNames' => [
                    'agrivision connector',
                    'fs25_agrivisionconnector',
                    'fs25_agrivisionconnector.zip',
                    'agrivisionconnector',
                ],
                'required' => true,
                'deployable' => true,
            ],
        ];
    }

    /**
     * @return array{
     *   mods: list<array<string, mixed>>,
     *   checkedAt: string,
     *   packageVersion: string|null
     * }
     */
    public function status(Workspace $workspace): array
    {
        $deploy = new ConnectorDeployService;
        $packageVersion = null;
        try {
            $packageVersion = $deploy->packageVersion();
        } catch (Throwable) {
            // optional
        }

        $feedMods = $this->fetchFeedMods($workspace);
        $host = $this->hostProbe($workspace);

        $mods = [];
        foreach ($this->catalog() as $item) {
            $installed = $host['installed'][$item['id']] ?? false;
            $installedPath = $host['paths'][$item['id']] ?? null;
            $activated = $this->isActivated($item, $feedMods, $host['hello'][$item['id']] ?? null);
            $zipVersion = $host['zipVersions'][$item['id']] ?? null;
            $loadedVersion = $host['hello'][$item['id']]['version'] ?? null;
            if ($loadedVersion === null) {
                $loadedVersion = $this->feedModVersion($item, $feedMods);
            }
            // The file in mods/ is what was updated. hello.xml stays on the old
            // version until the dedicated server starts the new connector.
            $runningVersion = is_string($zipVersion) && $zipVersion !== '' ? $zipVersion : $loadedVersion;

            if ($item['id'] === 'FS25_AgriVisionConnector' && is_string($runningVersion) && $runningVersion !== '') {
                if ($workspace->connector_version !== $runningVersion) {
                    $workspace->connector_version = $runningVersion;
                    $workspace->save();
                }
            }

            $pkg = $item['deployable'] ? $packageVersion : null;
            $updateAvailable = $this->isNewerVersion($pkg, $runningVersion);
            // Installed but version unknown → surface as update check needed when a package exists.
            if (! $updateAvailable && $installed && $pkg !== null && ($runningVersion === null || $runningVersion === '')) {
                $updateAvailable = true;
            }

            $mods[] = [
                'id' => $item['id'],
                'title' => $item['title'],
                'zipName' => $item['zipName'],
                'required' => $item['required'],
                'deployable' => $item['deployable'],
                'installed' => $installed,
                'activated' => $activated,
                'installedPath' => $installedPath,
                'runningVersion' => $runningVersion,
                'packageVersion' => $pkg,
                'updateAvailable' => $updateAvailable,
                'status' => $this->statusKey($installed, $activated),
            ];
        }

        return [
            'mods' => $mods,
            'checkedAt' => gmdate('c'),
            'packageVersion' => $packageVersion,
            'hostAccess' => $host['ok'],
            'feedModsCount' => count($feedMods),
        ];
    }

    /**
     * @param  array{id: string, matchNames: list<string>}  $item
     * @param  list<array{name: string, title: string|null, version: string|null}>  $feedMods
     * @param  array{version: string|null, present: bool}|null  $hello
     */
    private function isActivated(array $item, array $feedMods, ?array $hello): bool
    {
        if ($hello !== null && ($hello['present'] ?? false)) {
            return true;
        }

        return $this->feedModVersion($item, $feedMods) !== null || $this->feedModMatched($item, $feedMods);
    }

    /**
     * @param  array{matchNames: list<string>}  $item
     * @param  list<array{name: string, title: string|null, version: string|null}>  $feedMods
     */
    private function feedModMatched(array $item, array $feedMods): bool
    {
        foreach ($feedMods as $mod) {
            if ($this->matches($item['matchNames'], $mod['name'] ?? '', $mod['title'] ?? null)) {
                return true;
            }
        }

        return false;
    }

    /**
     * @param  array{matchNames: list<string>}  $item
     * @param  list<array{name: string, title: string|null, version: string|null}>  $feedMods
     */
    private function feedModVersion(array $item, array $feedMods): ?string
    {
        foreach ($feedMods as $mod) {
            if ($this->matches($item['matchNames'], $mod['name'] ?? '', $mod['title'] ?? null)) {
                $version = $mod['version'] ?? null;

                return is_string($version) && $version !== '' ? $version : null;
            }
        }

        return null;
    }

    /**
     * @param  list<string>  $needles
     */
    private function matches(array $needles, string $name, ?string $title): bool
    {
        $hay = $this->norm($name.' '.($title ?? ''));
        if ($hay === '') {
            return false;
        }
        foreach ($needles as $needle) {
            $n = $this->norm($needle);
            if ($n === '') {
                continue;
            }
            if ($hay === $n || str_contains($hay, $n) || str_contains($n, $hay)) {
                return true;
            }
        }

        return false;
    }

    private function norm(string $value): string
    {
        $value = strtolower($value);
        $value = preg_replace('/\.zip$/i', '', $value) ?? $value;

        return preg_replace('/[^a-z0-9]+/i', '', $value) ?? '';
    }

    private function statusKey(bool $installed, bool $activated): string
    {
        if ($activated) {
            return 'active';
        }
        if ($installed) {
            return 'installed';
        }

        return 'missing';
    }

    private function isNewerVersion(?string $package, ?string $running): bool
    {
        if ($package === null || $package === '' || $running === null || $running === '') {
            return false;
        }
        $a = array_map('intval', explode('.', preg_replace('/[^0-9.]/', '', $package) ?? '0'));
        $b = array_map('intval', explode('.', preg_replace('/[^0-9.]/', '', $running) ?? '0'));
        $len = max(count($a), count($b), 4);
        for ($i = 0; $i < $len; $i++) {
            $left = $a[$i] ?? 0;
            $right = $b[$i] ?? 0;
            if ($left === $right) {
                continue;
            }

            return $left > $right;
        }

        return false;
    }

    /**
     * @return list<array{name: string, title: string|null, version: string|null}>
     */
    private function fetchFeedMods(Workspace $workspace): array
    {
        $base = trim((string) $workspace->feed_base_url);
        $code = $workspace->feedCode();
        if ($base === '' || $code === null || $code === '') {
            return [];
        }

        try {
            $client = DedicatedServerFeedClient::fromParts($base, $code, 6);
            $snapshot = $client->fetchLightSnapshot();

            return array_map(static function (array $mod): array {
                return [
                    'name' => (string) ($mod['name'] ?? ''),
                    'title' => isset($mod['title']) ? (string) $mod['title'] : null,
                    'version' => isset($mod['version']) ? (string) $mod['version'] : null,
                ];
            }, $snapshot->mods);
        } catch (Throwable) {
            return [];
        }
    }

    /**
     * @return array{
     *   ok: bool,
     *   installed: array<string, bool>,
     *   paths: array<string, string|null>,
     *   hello: array<string, array{present: bool, version: string|null}>,
     *   zipVersions: array<string, string|null>
     * }
     */
    private function hostProbe(Workspace $workspace): array
    {
        $empty = ['ok' => false, 'installed' => [], 'paths' => [], 'hello' => [], 'zipVersions' => []];
        $access = HostAccess::query()->where('workspace_id', $workspace->id)->first();
        if (! $access || ! $access->hasPassword()) {
            return $empty;
        }

        try {
            $client = new HostFileClient($access);
        } catch (Throwable) {
            return $empty;
        }

        $installed = [];
        $paths = [];
        $hello = [];
        $zipVersions = [];

        $modSettings = trim(str_replace('\\', '/', (string) ($access->remote_mod_settings_path ?? '')), '/');
        $parent = $modSettings === '' ? '' : trim(dirname($modSettings), '/.');
        $modsDir = ($parent === '' || $parent === '.') ? 'mods' : $parent.'/mods';

        foreach ($this->catalog() as $item) {
            $path = rtrim($modsDir, '/').'/'.$item['zipName'];
            $isInstalled = false;
            $zipVersions[$item['id']] = null;
            try {
                $raw = $client->read($path, 20);
                if (str_starts_with($raw, "PK")) {
                    $isInstalled = true;
                    $zipVersions[$item['id']] = $this->versionFromZipBytes($raw);
                }
            } catch (Throwable) {
                $isInstalled = false;
            }
            if (! $isInstalled) {
                try {
                    $isInstalled = $client->fileExists($path);
                } catch (Throwable) {
                    $isInstalled = false;
                }
            }
            $installed[$item['id']] = $isInstalled;
            $paths[$item['id']] = $isInstalled ? $path : null;

            $hello[$item['id']] = ['present' => false, 'version' => null];
            if ($item['id'] === 'FS25_AgriVisionConnector' && $modSettings !== '') {
                $helloPath = $modSettings.'/'.$item['folderName'].'/hello.xml';
                try {
                    $raw = $client->read($helloPath, 12);
                    $version = null;
                    if (preg_match('/<agrivisionConnector\b[^>]*\bversion="([^"]+)"/i', $raw, $m)) {
                        $version = trim($m[1]) ?: null;
                    }
                    if ($raw !== '') {
                        $hello[$item['id']] = ['present' => true, 'version' => $version];
                    }
                } catch (Throwable) {
                    // hello.xml is written when the connector runs. A missing file does not mean the zip is gone.
                }
            }
        }

        return [
            'ok' => true,
            'installed' => $installed,
            'paths' => $paths,
            'hello' => $hello,
            'zipVersions' => $zipVersions,
        ];
    }

    private function versionFromZipBytes(string $bytes): ?string
    {
        if (! str_starts_with($bytes, "PK\x03\x04") || ! class_exists(\ZipArchive::class)) {
            return null;
        }
        $tmp = tempnam(sys_get_temp_dir(), 'avzip');
        if ($tmp === false) {
            return null;
        }
        try {
            if (file_put_contents($tmp, $bytes) === false) {
                return null;
            }
            $zip = new \ZipArchive;
            if ($zip->open($tmp) !== true) {
                return null;
            }
            $xml = $zip->getFromName('modDesc.xml');
            $zip->close();
            if (! is_string($xml) || ! preg_match('/<version>\s*([^<]+)\s*<\/version>/i', $xml, $match)) {
                return null;
            }

            return trim($match[1]) ?: null;
        } finally {
            @unlink($tmp);
        }
    }

}
