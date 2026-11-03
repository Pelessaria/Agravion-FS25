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
            $runningVersion = $host['hello'][$item['id']]['version'] ?? null;
            if ($runningVersion === null) {
                $runningVersion = $this->feedModVersion($item, $feedMods);
            }
            // modSettings/hello is optional — fall back to version inside the installed zip.
            if ($runningVersion === null && $installed && is_string($installedPath) && str_ends_with(strtolower($installedPath), '.zip')) {
                $runningVersion = $host['zipVersions'][$item['id']] ?? null;
            }

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
        $modsDir = null;
        $combined = null;
        if ($modSettings !== '') {
            $parent = trim(dirname($modSettings), '/.');
            $sibling = ($parent === '' || $parent === '.') ? 'mods' : $parent.'/mods';
            $item = $this->catalog()[0] ?? null;
            if ($item !== null) {
                $helloPath = $modSettings.'/'.$item['folderName'].'/hello.xml';
                try {
                    $combined = $client->sizeAndRead($sibling.'/'.$item['zipName'], $helloPath);
                    if (($combined['size'] ?? null) !== null && $combined['size'] > 0) {
                        $modsDir = $sibling;
                    }
                } catch (Throwable) {
                    $combined = null;
                }
            }
        }
        if ($modsDir === null && $combined === null) {
            try {
                $modsDir = ConnectorDeployService::resolveModsDirectory($client, $access);
            } catch (Throwable) {
                $modsDir = null;
            }
        }

        foreach ($this->catalog() as $item) {
            $path = null;
            $isInstalled = false;
            if ($modsDir !== null) {
                $path = rtrim($modsDir, '/').'/'.$item['zipName'];
                $known = is_array($combined) && ($combined['size'] ?? 0) > 0;
                if ($known) {
                    $isInstalled = true;
                } else {
                    $isInstalled = $client->fileExists($path);
                    if (! $isInstalled) {
                        $folder = rtrim($modsDir, '/').'/'.$item['folderName'];
                        if ($this->dirPresent($client, $folder)) {
                            $isInstalled = true;
                            $path = $folder;
                        }
                    }
                }
            }
            $installed[$item['id']] = $isInstalled;
            $paths[$item['id']] = $isInstalled ? $path : null;
            $zipVersions[$item['id']] = null;

            $hello[$item['id']] = ['present' => false, 'version' => null];
            if ($item['id'] === 'FS25_AgriVisionConnector' && is_array($combined)) {
                $raw = (string) ($combined['body'] ?? '');
                if ($raw !== '' && preg_match('/<agrivisionConnector\b[^>]*\bversion="([^"]+)"/i', $raw, $m)) {
                    $hello[$item['id']] = ['present' => true, 'version' => trim($m[1]) ?: null];
                } elseif ($raw !== '') {
                    $hello[$item['id']] = ['present' => true, 'version' => null];
                }
            } elseif ($item['id'] === 'FS25_AgriVisionConnector' && $modSettings !== '') {
                $connectorDir = $modSettings.'/'.$item['folderName'];
                $helloPath = $connectorDir.'/hello.xml';
                try {
                    if ($client->fileExists($helloPath)) {
                        $raw = $client->read($helloPath);
                        $version = null;
                        if (preg_match('/<agrivisionConnector\b[^>]*\bversion="([^"]+)"/i', $raw, $m)) {
                            $version = trim($m[1]) ?: null;
                        }
                        $hello[$item['id']] = ['present' => true, 'version' => $version];
                    } elseif ($this->dirPresent($client, $connectorDir)) {
                        $hello[$item['id']] = ['present' => true, 'version' => null];
                    }
                } catch (Throwable) {
                    // Missing modSettings is normal until the mod has run once.
                }
            }

            if (
                $isInstalled
                && is_string($path)
                && str_ends_with(strtolower($path), '.zip')
                && ($hello[$item['id']]['version'] ?? null) === null
            ) {
                $zipVersions[$item['id']] = $this->versionFromRemoteZip($client, $path);
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

    private function versionFromRemoteZip(HostFileClient $client, string $remoteZip): ?string
    {
        try {
            $size = $client->fileSize($remoteZip);
            $xml = ZipModDescReader::xml($size, static fn (int $offset, int $length): string => $client->readRange($remoteZip, $offset, $length));
            if (! is_string($xml) || ! preg_match('/<version>\s*([^<]+)\s*<\/version>/i', $xml, $match)) {
                return null;
            }

            return trim($match[1]) ?: null;
        } catch (Throwable) {
            return null;
        }
    }

    private function dirPresent(HostFileClient $client, string $path): bool
    {
        try {
            $client->listDirectories($path);

            return true;
        } catch (Throwable) {
            return false;
        }
    }
}
