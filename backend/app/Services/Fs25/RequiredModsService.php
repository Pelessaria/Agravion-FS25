<?php

namespace App\Services\Fs25;

use App\Models\Workspace;
use Throwable;

/**
 * Required game-host mods: installed and activated according to the server mod list.
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
                'id' => 'FS25_AgravionConnector',
                'title' => 'Agravion Connector',
                'zipName' => ConnectorDeployService::MOD_ZIP,
                'folderName' => ConnectorDeployService::MOD_NAME,
                'matchNames' => [
                    'agravion connector',
                    'fs25_agravionconnector',
                    'fs25_agravionconnector.zip',
                    'agravionconnector',
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
    public function status(Workspace $workspace, bool $fresh = false): array
    {
        $deploy = new ConnectorDeployService;
        $packageVersion = null;
        try {
            $packageVersion = $deploy->packageVersion();
        } catch (Throwable) {
            // optional
        }

        // The stats feed does not list mods. One small hello.xml read, and only
        // while the cached version is behind the package, corrects a stale list.
        $feedMods = [];
        $this->confirmRunningVersion($workspace, $packageVersion, $fresh);
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
            // hello.xml is the version the dedicated server actually loaded.
            // A newer stamped zip version means the file was replaced and the
            // process has not been restarted yet.
            $runningVersion = is_string($zipVersion) && $zipVersion !== '' ? $zipVersion : null;
            if (! is_string($runningVersion) || $runningVersion === '' || $this->isNewerVersion($loadedVersion, $runningVersion)) {
                $runningVersion = is_string($loadedVersion) && $loadedVersion !== '' ? $loadedVersion : $runningVersion;
            }

            if ($item['id'] === 'FS25_AgravionConnector' && is_string($runningVersion) && $runningVersion !== '') {
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
        $installed = [];
        $paths = [];
        $hello = [];
        $zipVersions = [];
        $cached = $this->cachedMods($workspace);

        foreach ($this->catalog() as $item) {
            $row = $this->cachedMatch($item, $cached);
            $version = is_array($row) && is_string($row['version'] ?? null) && $row['version'] !== ''
                ? $row['version']
                : null;
            $isInstalled = $row !== null;
            $active = is_array($row) && ($row['active'] ?? null) === true;
            $installed[$item['id']] = $isInstalled;
            $paths[$item['id']] = $isInstalled ? 'mods/'.$item['zipName'] : null;
            $zipVersions[$item['id']] = $version;
            // "active" on the cached row is the dedicated-server mod list
            // (Aktive Mods), not a guess from a missing hello.xml.
            $hello[$item['id']] = ['present' => $active, 'version' => $active ? $version : null];
        }

        return [
            'ok' => $cached !== [],
            'installed' => $installed,
            'paths' => $paths,
            'hello' => $hello,
            'zipVersions' => $zipVersions,
        ];
    }

    /**
     * @return list<array<string, mixed>>
     */
    private function cachedMods(Workspace $workspace): array
    {
        $path = storage_path('app/connector/'.$workspace->public_id.'/state/server_console.json');
        if (! is_file($path)) {
            return [];
        }
        $data = json_decode((string) file_get_contents($path), true);
        if (! is_array($data) || ! is_array($data['mods'] ?? null)) {
            return [];
        }

        return array_values(array_filter($data['mods'], 'is_array'));
    }

    /**
     * @param  array{matchNames: list<string>}  $item
     * @param  list<array<string, mixed>>  $mods
     * @return array<string, mixed>|null
     */
    private function cachedMatch(array $item, array $mods): ?array
    {
        foreach ($mods as $mod) {
            $name = (string) ($mod['name'] ?? '');
            $title = isset($mod['title']) ? (string) $mod['title'] : null;
            if ($this->matches($item['matchNames'], $name, $title)) {
                return $mod;
            }
        }

        return null;
    }

    /**
     * hello.xml is a few hundred bytes written next to the connector state.
     * Read it only when the cached mod version is older than the package,
     * with a hard 4 second cap, and remember the result in the mod list.
     */
    private function confirmRunningVersion(Workspace $workspace, ?string $packageVersion, bool $fresh): void
    {
        $cached = $this->cachedMods($workspace);
        $row = null;
        foreach ($this->catalog() as $item) {
            if ($item['id'] !== 'FS25_AgravionConnector') {
                continue;
            }
            $row = $this->cachedMatch($item, $cached);
        }
        $cachedVersion = is_array($row) && is_string($row['version'] ?? null) ? $row['version'] : null;
        if (! $this->shouldReadHello($workspace, $cachedVersion, $packageVersion, $fresh)) {
            return;
        }
        $this->noteHelloAttempt($workspace);
        $version = $this->readHelloVersion($workspace);
        if ($version === null) {
            return;
        }
        $bytes = is_array($row) && is_numeric($row['bytes'] ?? null) ? (int) $row['bytes'] : 0;
        if ($bytes < 22 && $version === $packageVersion) {
            $package = (new ConnectorDeployService)->packagePath();
            $size = is_string($package) && is_file($package) ? filesize($package) : false;
            $bytes = $size === false ? 0 : (int) $size;
        }
        if ($bytes < 22) {
            return;
        }
        try {
            (new DedicatedServerConsole)->stampModFile($workspace, ConnectorDeployService::MOD_ZIP, $version, $bytes);
        } catch (Throwable) {
            // The hello version is still returned from this request via the cache
            // only when the stamp succeeds. A failed stamp leaves the old row.
        }
    }

    private function shouldReadHello(Workspace $workspace, ?string $cachedVersion, ?string $packageVersion, bool $fresh): bool
    {
        if ($packageVersion === null || $packageVersion === '') {
            return false;
        }
        if ($cachedVersion !== null && $cachedVersion !== '' && ! $this->isNewerVersion($packageVersion, $cachedVersion)) {
            return false;
        }
        if ($fresh) {
            return true;
        }
        $path = $this->helloAttemptPath($workspace);
        if (is_file($path) && (time() - (int) filemtime($path)) < 120) {
            return false;
        }

        return true;
    }

    private function noteHelloAttempt(Workspace $workspace): void
    {
        $path = $this->helloAttemptPath($workspace);
        $dir = dirname($path);
        if (! is_dir($dir) && ! mkdir($dir, 0775, true) && ! is_dir($dir)) {
            return;
        }
        @touch($path);
    }

    private function helloAttemptPath(Workspace $workspace): string
    {
        return storage_path('app/connector/'.$workspace->public_id.'/state/hello.attempt');
    }

    private function readHelloVersion(Workspace $workspace): ?string
    {
        $workspace->loadMissing('hostAccess');
        $access = $workspace->hostAccess;
        if ($access === null) {
            return null;
        }
        $modSettings = trim(str_replace('\\', '/', (string) ($access->remote_mod_settings_path ?? '')), '/');
        if ($modSettings === '') {
            return null;
        }
        try {
            $xml = (new HostFileClient($access))->read($modSettings.'/FS25_AgravionConnector/hello.xml', 4);
        } catch (Throwable) {
            return null;
        }
        if (! is_string($xml) || preg_match('/<agravionConnector\b[^>]*\bversion="([^"]+)"/i', $xml, $match) !== 1) {
            return null;
        }
        $version = trim($match[1]);

        return $version !== '' ? $version : null;
    }

}
