<?php

namespace App\Services\Fs25;

use App\Models\HostAccess;
use App\Models\Workspace;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * Pull Agravion connector files from host modSettings into a local cache.
 *
 * Dashboard page loads never open FTP. Cron refreshes vehicles_full.xml and
 * icons_manifest.xml, then RETR missing store icons. Never gate downloads on FTP LIST.
 */
final class ConnectorSnapshotService
{
    public const MOD_FOLDER = 'FS25_AgravionConnector';

    /** Seconds between automatic checks once every icon is already a PNG. */
    public const ICON_SYNC_INTERVAL_SEC = 300;

    /** Seconds before the next pull while icons are still missing. */
    public const ICON_BACKLOG_INTERVAL_SEC = 15;

    /** Seconds between vehicles/manifest FTP pulls when the cron is healthy. */
    public const STATE_SYNC_INTERVAL_SEC = 60;

    /** Live-map page pulls only live_map.xml this often (connector writes ~2 s when busy). */
    public const LIVE_SYNC_INTERVAL_SEC = 2;

    /** Seconds to wait before retrying one DDS that did not become a PNG. */
    private const CONVERT_COOLDOWN_SEC = 120;

    /** Per-file FTP cap so one dead transfer cannot block the rest of the queue. */
    private const ICON_READ_TIMEOUT_SEC = 12;

    /** @var resource|null */
    private static $iconLock = null;

    /**
     * @return array{
     *   vehicles: list<array<string, mixed>>,
     *   icons: list<array{key: string, name: string|null, author: string|null, version: string|null, iconFile: string, kind?: string}>,
     *   basePath: string|null
     * }
     */
    public function read(Workspace $workspace): array
    {
        $result = $this->readVehicles($workspace);

        return [
            'vehicles' => $result['vehicles'],
            'icons' => [],
            'basePath' => $result['basePath'],
        ];
    }

    /**
     * Local cache only — never opens FTP. Cron fills the files via refreshLocalState.
     *
     * @return array{vehicles: list<array<string, mixed>>, basePath: string|null}
     */
    public function readVehicles(Workspace $workspace): array
    {
        $empty = ['vehicles' => [], 'basePath' => null];
        $path = $this->localVehiclesPath($workspace);
        if (! is_file($path)) {
            return $empty;
        }

        try {
            $vehicles = ConnectorVehiclesParser::parse((string) file_get_contents($path));
        } catch (Throwable) {
            return $empty;
        }

        $access = $this->hostAccess($workspace);
        $base = $access !== null ? $this->connectorBase($access) : null;

        return [
            'vehicles' => $vehicles,
            'basePath' => $base,
        ];
    }

    /**
     * @return array{changed: bool, skipped: string|null, detail: string|null, vehicles: bool, manifest: bool}
     */
    public function refreshLocalStateIfDue(Workspace $workspace, ?int $intervalSec = null): array
    {
        $intervalSec ??= self::STATE_SYNC_INTERVAL_SEC;
        $marker = $this->stateSyncMarkerPath($workspace);
        if ($intervalSec > 0 && is_file($marker)) {
            $age = time() - (int) filemtime($marker);
            if ($age >= 0 && $age < $intervalSec) {
                return [
                    'changed' => false,
                    'skipped' => 'throttled',
                    'detail' => null,
                    'vehicles' => false,
                    'manifest' => false,
                ];
            }
        }

        $result = $this->refreshLocalState($workspace);
        if ($result['skipped'] === null || in_array($result['skipped'], ['unchanged'], true)) {
            File::ensureDirectoryExists(dirname($marker));
            File::put($marker, (string) time());
        }

        return $result;
    }

    /**
     * FTP-pull vehicles_full.xml and icons_manifest.xml into storage.
     * Ignores generation / writtenAtUtc when deciding whether the content changed.
     *
     * @return array{changed: bool, skipped: string|null, detail: string|null, vehicles: bool, manifest: bool}
     */
    public function refreshLocalState(Workspace $workspace): array
    {
        $access = $this->hostAccess($workspace);
        if ($access === null) {
            return [
                'changed' => false,
                'skipped' => 'no_host_access',
                'detail' => 'HostAccess fehlt oder ohne Passwort',
                'vehicles' => false,
                'manifest' => false,
            ];
        }

        $base = $this->connectorBase($access);
        if ($base === null) {
            return [
                'changed' => false,
                'skipped' => 'no_mod_settings',
                'detail' => 'remote_mod_settings_path leer',
                'vehicles' => false,
                'manifest' => false,
            ];
        }

        try {
            $client = new HostFileClient($access);
        } catch (Throwable $e) {
            return [
                'changed' => false,
                'skipped' => 'connect_failed',
                'detail' => $e->getMessage(),
                'vehicles' => false,
                'manifest' => false,
            ];
        }

        $dir = $this->localStateDir($workspace);
        File::ensureDirectoryExists($dir);
        $vehiclesChanged = false;
        $manifestChanged = false;
        $detail = null;

        try {
            $remoteVehicles = $client->read($base.'/state/vehicles_full.xml');
            $vehiclesChanged = $this->storeLocalIfChanged($this->localVehiclesPath($workspace), $remoteVehicles);
        } catch (Throwable $e) {
            $detail = $e->getMessage();
        }

        try {
            $remoteManifest = $client->read($base.'/state/icons_manifest.xml');
            $manifestChanged = $this->storeLocalIfChanged($this->localManifestPath($workspace), $remoteManifest);
        } catch (Throwable $e) {
            $detail = $detail ?? $e->getMessage();
        }

        foreach ([
            'fields_geometry.xml',
            'fields_state.xml',
            'fruits_manifest.xml',
            'storage_state.xml',
            'live_map.xml',
            'brands_manifest.xml',
            'brands_probe.xml',
        ] as $file) {
            try {
                $remote = $client->read($base.'/state/'.$file);
                $this->storeLocalIfChanged($this->localStateDir($workspace).'/'.$file, $remote);
            } catch (Throwable) {
                // Field / brand files are optional until the connector that writes them is installed.
            }
        }

        $this->pullPdaOverview($client, $workspace, $base);

        try {
            $this->pullFruitIcons($client, $workspace, $base);
        } catch (Throwable) {
            // Fruit icons are decorative. The map still renders without them.
        }

        if (! is_file($this->localVehiclesPath($workspace)) && ! is_file($this->localManifestPath($workspace))) {
            return [
                'changed' => false,
                'skipped' => 'state_failed',
                'detail' => $detail ?? 'Connector-State konnte nicht gelesen werden',
                'vehicles' => false,
                'manifest' => false,
            ];
        }

        return [
            'changed' => $vehiclesChanged || $manifestChanged,
            'skipped' => ($vehiclesChanged || $manifestChanged) ? null : 'unchanged',
            'detail' => $detail,
            'vehicles' => $vehiclesChanged,
            'manifest' => $manifestChanged,
        ];
    }

    /**
     * Local field cache only. Page loads do not open FTP.
     *
     * @return array{
     *   ok: bool,
     *   error: string|null,
     *   mapSize: int|null,
     *   mapFrame: array{worldX: float, worldZ: float, originX: float, originZ: float, scaleX: float, scaleZ: float, padX: float, padZ: float}|null,
     *   precisionFarming: bool|null,
     *   geometryAt: string|null,
     *   stateAt: string|null,
     *   pdaMap: bool,
     *   fields: list<array<string, mixed>>
     * }
     */
    public function readFields(Workspace $workspace): array
    {
        $geoPath = $this->localStateDir($workspace).'/fields_geometry.xml';
        $statePath = $this->localStateDir($workspace).'/fields_state.xml';
        $geometryXml = is_file($geoPath) ? (string) file_get_contents($geoPath) : '';
        $stateXml = is_file($statePath) ? (string) file_get_contents($statePath) : '';
        $merged = ConnectorFieldsParser::merge($geometryXml, $stateXml);
        if ($merged['mapSize'] === null && $workspace->map_size) {
            $merged['mapSize'] = (int) $workspace->map_size;
        }

        $savedTramlines = $this->savedTramlines($workspace);
        foreach ($merged['fields'] as &$field) {
            $key = $field['fruitIcon'] ?? null;
            $field['iconUrl'] = null;
            if (is_string($key) && $this->fruitIconPath($workspace, $key) !== null) {
                $field['iconUrl'] = '/api/workspaces/'.$workspace->public_id.'/connector/fruits/'.$key;
            }
            if (($field['tramline'] ?? null) === null) {
                $farmlandId = $field['farmlandId'] ?? null;
                $saved = is_numeric($farmlandId) ? ($savedTramlines[(string) $farmlandId] ?? null) : null;
                if (is_array($saved) && isset($saved['direction']) && is_numeric($saved['direction'])) {
                    $field['tramline'] = [
                        'width' => (float) $saved['width'],
                        'direction' => (float) $saved['direction'],
                        'spacing' => (float) $saved['spacing'],
                    ];
                }
            }
        }
        unset($field);

        $merged['ok'] = $geometryXml !== '' || $stateXml !== '';
        $merged['error'] = $merged['ok'] ? null : 'missing';
        $merged['pdaMap'] = $this->pdaMapPath($workspace) !== null;
        $marker = $this->localStateDir($workspace).'/overview.failed';
        $merged['pdaError'] = (! $merged['pdaMap'] && is_file($marker)) ? trim((string) file_get_contents($marker)) : null;

        return $merged;
    }

    /**
     * Local storage cache only. Page loads do not open FTP.
     *
     * @return array{ok: bool, error: string|null, writtenAt: string|null, places: list<array<string, mixed>>}
     */
    public function readStorage(Workspace $workspace): array
    {
        $path = $this->localStateDir($workspace).'/storage_state.xml';
        if (! is_file($path)) {
            return [
                'ok' => false,
                'error' => 'missing',
                'writtenAt' => null,
                'places' => [],
            ];
        }

        $parsed = ConnectorStorageParser::parse((string) file_get_contents($path));
        $icons = new ModIconCacheService;
        foreach ($parsed['places'] as &$place) {
            $storeKey = $place['storeKey'] ?? null;
            $place['iconUrl'] = null;
            if (is_string($storeKey) && $storeKey !== ''
                && ($icons->localPath($workspace, $storeKey) !== null || $icons->localDdsPath($workspace, $storeKey) !== null)) {
                $place['iconUrl'] = $icons->publicUrl($workspace, $storeKey);
            }
        }
        unset($place);

        return [
            'ok' => true,
            'error' => null,
            'writtenAt' => $parsed['writtenAt'],
            'places' => $parsed['places'],
        ];
    }

    public function hasLiveFile(Workspace $workspace): bool
    {
        return is_file($this->localStateDir($workspace).'/live_map.xml');
    }

    /**
     * FTP-pull only live_map.xml so the live page can refresh without the full state cycle.
     */
    public function refreshLiveFileIfDue(Workspace $workspace, ?int $intervalSec = null): void
    {
        $intervalSec ??= self::LIVE_SYNC_INTERVAL_SEC;
        $marker = $this->localStateDir($workspace).'/.live_sync';
        if ($intervalSec > 0 && is_file($marker)) {
            $age = time() - (int) filemtime($marker);
            if ($age >= 0 && $age < $intervalSec) {
                return;
            }
        }

        $access = $this->hostAccess($workspace);
        $base = $access !== null ? $this->connectorBase($access) : null;
        if ($access === null || $base === null) {
            File::ensureDirectoryExists(dirname($marker));
            File::put($marker, (string) time());

            return;
        }

        $lockPath = $this->localStateDir($workspace).'/.live_sync.lock';
        File::ensureDirectoryExists(dirname($lockPath));
        $lock = @fopen($lockPath, 'c+');
        if ($lock === false) {
            return;
        }
        // Non-blocking: concurrent page polls must not stack FTP waits.
        if (! flock($lock, LOCK_EX | LOCK_NB)) {
            fclose($lock);

            return;
        }

        try {
            // Re-check throttle after winning the lock.
            if ($intervalSec > 0 && is_file($marker)) {
                $age = time() - (int) filemtime($marker);
                if ($age >= 0 && $age < $intervalSec) {
                    return;
                }
            }

            $client = new HostFileClient($access);
            $remote = $client->read($base.'/state/live_map.xml', 2);
            $this->storeLocalIfChanged($this->localStateDir($workspace).'/live_map.xml', $remote);
            File::ensureDirectoryExists(dirname($marker));
            File::put($marker, (string) time());
        } catch (Throwable) {
            // Keep the last cached live_map.xml; the page still renders.
            File::ensureDirectoryExists(dirname($marker));
            File::put($marker, (string) time());
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }

    /**
     * Local live-map cache. When the connector has not written live_map.xml yet,
     * vehicle positions from the existing vehicle snapshot are used instead.
     *
     * @return array<string, mixed>
     */
    public function readLive(Workspace $workspace, bool $fresh = false): array
    {
        if ($fresh) {
            $this->refreshLiveFileIfDue($workspace);
        }

        $path = $this->localStateDir($workspace).'/live_map.xml';
        if (! is_file($path)) {
            return $this->liveFromVehicles($workspace);
        }

        $parsed = ConnectorLiveParser::parse((string) file_get_contents($path));
        $parsed['writtenAt'] = gmdate('c', (int) filemtime($path));

        return [
            'ok' => true,
            'error' => null,
            'source' => 'live',
            ...$parsed,
        ];
    }

    /**
     * @return array<string, array{width: float, direction: float, spacing: float}>
     */
    private function savedTramlines(Workspace $workspace): array
    {
        $path = storage_path('app/connector/'.$workspace->public_id.'/precision/tramlines.json');
        if (! is_file($path)) {
            return [];
        }
        $decoded = json_decode((string) file_get_contents($path), true);
        if (! is_array($decoded)) {
            return [];
        }
        $out = [];
        foreach ($decoded as $id => $row) {
            if (! is_array($row) || ! isset($row['width'], $row['spacing'], $row['direction']) || ! is_numeric($row['direction'])) {
                continue;
            }
            $out[(string) $id] = [
                'width' => (float) $row['width'],
                'direction' => (float) $row['direction'],
                'spacing' => (float) $row['spacing'],
            ];
        }

        return $out;
    }

    /**
     * @return array<string, mixed>
     */
    private function liveFromVehicles(Workspace $workspace): array
    {
        $blank = ConnectorLiveParser::blank();
        $vehicles = $this->readVehicles($workspace)['vehicles'] ?? [];
        foreach ($vehicles as $vehicle) {
            if (! is_array($vehicle) || ! is_numeric($vehicle['x'] ?? null) || ! is_numeric($vehicle['z'] ?? null)) {
                continue;
            }
            $blank['vehicles'][] = [
                'id' => (string) ($vehicle['uniqueId'] ?? ''),
                'name' => $vehicle['name'] ?? $vehicle['nameHint'] ?? null,
                'farmId' => $vehicle['farmId'] ?? null,
                'x' => (float) $vehicle['x'],
                'z' => (float) $vehicle['z'],
                'heading' => null,
                'ai' => false,
                'driver' => null,
                'controlled' => false,
                'attachments' => null,
            ];
        }
        $path = $this->localVehiclesPath($workspace);
        $blank['writtenAt'] = is_file($path) ? gmdate('c', (int) filemtime($path)) : null;

        return [
            'ok' => $blank['vehicles'] !== [],
            'error' => $blank['vehicles'] === [] ? 'missing' : null,
            'source' => 'vehicles',
            ...$blank,
        ];
    }

    private function pullFruitIcons(HostFileClient $client, Workspace $workspace, string $base): void
    {
        $manifest = $this->localStateDir($workspace).'/fruits_manifest.xml';
        if (! is_file($manifest)) {
            return;
        }

        $entries = ConnectorFieldsParser::fruitIcons((string) file_get_contents($manifest));
        $dir = storage_path('app/connector/'.$workspace->public_id.'/icons/fruits');
        $pulled = 0;
        foreach ($entries as $entry) {
            if ($pulled >= 24) {
                return;
            }
            if ($this->fruitIconPath($workspace, $entry['key']) !== null) {
                continue;
            }
            try {
                $bytes = $client->read($base.'/'.$entry['iconFile'], 8);
            } catch (Throwable) {
                continue;
            }
            $pulled++;
            $ext = strtolower(pathinfo($entry['iconFile'], PATHINFO_EXTENSION));
            if ($ext === 'dds') {
                $converted = DdsToPng::convert($bytes);
                if ($converted === null) {
                    continue;
                }
                $bytes = $converted;
                $ext = 'png';
            } elseif ($ext === 'jpeg') {
                $ext = 'jpg';
            } elseif (! in_array($ext, ['png', 'jpg', 'webp'], true)) {
                continue;
            }
            File::ensureDirectoryExists($dir);
            File::put($dir.'/'.$entry['key'].'.'.$ext, $bytes);
        }
    }

    public function fruitIconPath(Workspace $workspace, string $key): ?string
    {
        $key = strtolower($key);
        if (! preg_match('/^[a-z0-9_-]{1,64}$/', $key)) {
            return null;
        }
        $dir = storage_path('app/connector/'.$workspace->public_id.'/icons/fruits');
        foreach (['png', 'jpg', 'jpeg', 'webp'] as $ext) {
            $path = $dir.'/'.$key.'.'.$ext;
            if (is_file($path)) {
                return $path;
            }
        }

        return null;
    }

    /**
     * @return array{downloaded: int, converted: int, skipped: string|null, pending: int, errors: int, listed: int, detail: string|null}
     */
    public function syncStoreIconsIfDue(Workspace $workspace, ?int $intervalSec = null, int $budgetSec = 40): array
    {
        $intervalSec ??= self::ICON_SYNC_INTERVAL_SEC;
        $marker = $this->iconSyncMarkerPath($workspace);
        $gap = $intervalSec === 0
            ? 0
            : (is_file($this->iconBacklogFlag($workspace)) ? self::ICON_BACKLOG_INTERVAL_SEC : $intervalSec);
        if ($gap > 0 && is_file($marker)) {
            $age = time() - (int) filemtime($marker);
            if ($age >= 0 && $age < $gap) {
                return [
                    'downloaded' => 0,
                    'converted' => 0,
                    'skipped' => 'throttled',
                    'pending' => 0,
                    'errors' => 0,
                    'listed' => 0,
                    'detail' => null,
                ];
            }
        }

        $result = $this->syncStoreIcons($workspace, $budgetSec);

        // A finished check waits five minutes. A backlog waits only a few seconds.
        if ($result['skipped'] === null
            || in_array($result['skipped'], ['unchanged', 'connect_failed', 'no_icons', 'manifest_failed', 'convert_cooldown'], true)) {
            File::ensureDirectoryExists(dirname($marker));
            File::put($marker, (string) time());
            $checked = storage_path('app/connector/icon-sync.checked');
            File::ensureDirectoryExists(dirname($checked));
            File::put($checked, (string) time());
            $this->noteIconBacklog($workspace, $result);
        }

        return $result;
    }

    /**
     * @return array{downloaded: int, converted: int, skipped: string|null, pending: int, errors: int, listed: int, detail: string|null}
     */
    public function syncStoreIcons(Workspace $workspace, int $budgetSec = 40): array
    {
        if (function_exists('set_time_limit')) {
            @set_time_limit(max(60, $budgetSec + 30));
        }
        if (function_exists('ignore_user_abort')) {
            @ignore_user_abort(true);
        }

        if (! $this->acquireIconLock()) {
            return $this->syncResult(skipped: 'busy', pending: 1, detail: 'Icon-Sync läuft bereits');
        }

        try {
            return $this->syncStoreIconsLocked($workspace, $budgetSec);
        } finally {
            $this->releaseIconLock();
        }
    }

    /**
     * @return array{downloaded: int, converted: int, skipped: string|null, pending: int, errors: int, listed: int, detail: string|null}
     */
    private function syncStoreIconsLocked(Workspace $workspace, int $budgetSec): array
    {
        $access = $this->hostAccess($workspace);
        if ($access === null) {
            return $this->syncResult(skipped: 'no_host_access', detail: 'HostAccess fehlt oder ohne Passwort');
        }

        $base = $this->connectorBase($access);
        if ($base === null) {
            return $this->syncResult(skipped: 'no_mod_settings', detail: 'remote_mod_settings_path leer');
        }

        $state = $this->refreshLocalState($workspace);
        if ($state['skipped'] === 'connect_failed' || $state['skipped'] === 'state_failed') {
            Log::warning('Agravion connector state refresh failed', [
                'workspace' => $workspace->public_id,
                'skipped' => $state['skipped'],
                'detail' => $state['detail'],
            ]);

            return $this->syncResult(skipped: $state['skipped'] ?? 'state_failed', detail: $state['detail']);
        }

        $manifestPath = $this->localManifestPath($workspace);
        $jobs = [];
        if (is_file($manifestPath)) {
            $entries = ConnectorIconsParser::parse((string) file_get_contents($manifestPath));
            foreach ($entries as $icon) {
                if (($icon['kind'] ?? 'store') !== 'store') {
                    continue;
                }
                $key = trim((string) $icon['key']);
                $iconFile = trim(str_replace('\\', '/', (string) $icon['iconFile']));
                if ($key === '' || $iconFile === '') {
                    continue;
                }
                $remote = str_starts_with($iconFile, $base.'/')
                    ? $iconFile
                    : rtrim($base, '/').'/'.ltrim($iconFile, '/');
                $ext = strtolower(pathinfo($iconFile, PATHINFO_EXTENSION) ?: 'dds');
                if (! in_array($ext, ['dds', 'png', 'jpg', 'jpeg', 'webp'], true)) {
                    $ext = 'dds';
                    if (! str_contains(strtolower($iconFile), '.dds')) {
                        $remote = preg_replace('/\.[^.]+$/', '', $remote).'.dds';
                    }
                }
                $jobs[$key] = [
                    'key' => $key,
                    'ext' => $ext,
                    'remote' => $remote,
                ];
            }
        }

        // Vehicles whose copy failed are absent from the manifest. Still ask for
        // icons/store/<storeKey>.dds so a later successful copy is picked up.
        $jobs = $this->mergeVehicleStoreJobs($workspace, $base, $jobs);
        $jobs = $this->mergeStorageStoreJobs($workspace, $base, $jobs);
        $jobs = $this->mergeBrandIconJobs($workspace, $base, $jobs);

        if ($jobs === []) {
            return $this->syncResult(
                skipped: 'no_icons',
                detail: is_file($manifestPath)
                    ? 'icons_manifest.xml ohne store-Einträge'
                    : 'Lokales icons_manifest.xml / brands_manifest.xml fehlt'
            );
        }

        try {
            $client = new HostFileClient($access);
        } catch (Throwable $e) {
            Log::warning('Agravion icon sync connect failed', [
                'workspace' => $workspace->public_id,
                'error' => $e->getMessage(),
            ]);

            return $this->syncResult(skipped: 'connect_failed', detail: $e->getMessage());
        }

        $jobList = array_values($jobs);
        $result = $this->downloadIconJobs($client, $workspace, $jobList, $budgetSec);
        $this->recordIconPass($workspace, $jobList, $result);

        return $result;
    }

    /**
     * @param  array<string, array{key: string, ext: string, remote: string}>  $jobs
     * @return array<string, array{key: string, ext: string, remote: string}>
     */
    private function mergeVehicleStoreJobs(Workspace $workspace, string $base, array $jobs): array
    {
        $path = $this->localVehiclesPath($workspace);
        if (! is_file($path)) {
            return $jobs;
        }

        try {
            $vehicles = ConnectorVehiclesParser::parse((string) file_get_contents($path));
        } catch (Throwable) {
            return $jobs;
        }

        foreach ($vehicles as $vehicle) {
            $key = $vehicle['storeKey'] ?? null;
            if (! is_string($key) || $key === '' || isset($jobs[$key])) {
                continue;
            }
            $jobs[$key] = [
                'key' => $key,
                'ext' => 'dds',
                'remote' => rtrim($base, '/').'/icons/store/'.$key.'.dds',
            ];
        }

        return $jobs;
    }

    /**
     * Placeable store images are not vehicles. Pull their keys from the storage snapshot.
     *
     * @param  array<string, array{key: string, ext: string, remote: string}>  $jobs
     * @return array<string, array{key: string, ext: string, remote: string}>
     */
    private function mergeStorageStoreJobs(Workspace $workspace, string $base, array $jobs): array
    {
        $path = $this->localStateDir($workspace).'/storage_state.xml';
        if (! is_file($path)) {
            return $jobs;
        }

        try {
            $parsed = ConnectorStorageParser::parse((string) file_get_contents($path));
        } catch (Throwable) {
            return $jobs;
        }

        foreach ($parsed['places'] as $place) {
            $key = $place['storeKey'] ?? null;
            if (! is_string($key) || $key === '' || isset($jobs[$key])) {
                continue;
            }
            $jobs[$key] = [
                'key' => $key,
                'ext' => 'dds',
                'remote' => rtrim($base, '/').'/icons/store/'.$key.'.dds',
            ];
        }

        return $jobs;
    }

    /**
     * Brand logos live under icons/brands/; cache keys are brand__<key>.
     *
     * @param  array<string, array{key: string, ext: string, remote: string}>  $jobs
     * @return array<string, array{key: string, ext: string, remote: string}>
     */
    private function mergeBrandIconJobs(Workspace $workspace, string $base, array $jobs): array
    {
        $path = $this->localStateDir($workspace).'/brands_manifest.xml';
        if (! is_file($path)) {
            return $jobs;
        }

        try {
            $entries = ConnectorBrandsParser::parse((string) file_get_contents($path));
        } catch (Throwable) {
            return $jobs;
        }

        $cache = new ModIconCacheService;
        foreach ($entries as $icon) {
            $brandKey = trim((string) ($icon['key'] ?? ''));
            $iconFile = trim(str_replace('\\', '/', (string) ($icon['iconFile'] ?? '')));
            if ($brandKey === '' || $iconFile === '') {
                continue;
            }
            $cacheKey = $cache->brandCacheKey($brandKey);
            if (isset($jobs[$cacheKey])) {
                continue;
            }
            $remote = str_starts_with($iconFile, $base.'/')
                ? $iconFile
                : rtrim($base, '/').'/'.ltrim($iconFile, '/');
            $ext = strtolower(pathinfo($iconFile, PATHINFO_EXTENSION) ?: 'dds');
            if (! in_array($ext, ['dds', 'png', 'jpg', 'jpeg', 'webp'], true)) {
                $ext = 'dds';
            }
            $jobs[$cacheKey] = [
                'key' => $cacheKey,
                'ext' => $ext,
                'remote' => $remote,
            ];
        }

        return $jobs;
    }

    public function cachedIconPath(Workspace $workspace, string $key): ?string
    {
        return (new ModIconCacheService)->localPath($workspace, $key)
            ?? (new ModIconCacheService)->localDdsPath($workspace, $key);
    }

    public function cachedBrandIconPath(Workspace $workspace, string $brandKey): ?string
    {
        $cache = new ModIconCacheService;
        $key = $cache->brandCacheKey($brandKey);

        return $cache->localPath($workspace, $key) ?? $cache->localDdsPath($workspace, $key);
    }

    /**
     * @param  list<array{key: string, ext: string, remote: string}>  $jobs
     * @return array{downloaded: int, converted: int, skipped: string|null, pending: int, errors: int, listed: int, detail: string|null}
     */
    private function downloadIconJobs(HostFileClient $client, Workspace $workspace, array $jobs, int $budgetSec): array
    {
        $cache = new ModIconCacheService;
        $dir = $cache->cacheDir($workspace);
        File::ensureDirectoryExists($dir);

        $cooldown = $this->readConvertCooldown($dir);
        $catalog = $this->readIconCatalog($dir);
        $known = $catalog !== [];
        $now = time();
        $work = [];
        $cooling = 0;
        foreach ($jobs as $job) {
            $safeKey = preg_replace('/[^a-zA-Z0-9._-]+/', '_', $job['key']) ?? 'icon';
            $remote = $this->normalizeIconRemote($job['remote']);
            if ($remote === null) {
                continue;
            }
            $hasPng = $cache->localPath($workspace, $safeKey) !== null;
            $remoteChanged = $known && ($catalog[$safeKey] ?? null) !== $remote;
            if ($hasPng && ! $remoteChanged) {
                continue;
            }
            if (! $remoteChanged && ($cooldown[$safeKey] ?? 0) > $now) {
                $cooling++;
                continue;
            }
            $work[] = [
                'key' => $safeKey,
                'ext' => $job['ext'],
                'remote' => $remote,
                'pngLocal' => $dir.'/'.$safeKey.'.png',
                'force' => $remoteChanged,
            ];
        }

        $listed = count($jobs);
        if ($work === []) {
            if ($cooling === 0) {
                $this->writeIconCatalog($dir, $jobs);
            }

            return $this->syncResult(
                pending: $cooling,
                listed: $listed,
                skipped: $cooling > 0 ? 'convert_cooldown' : 'unchanged',
                detail: $cooling > 0 ? 'DDS liegt lokal, Konvertierung pausiert' : 'Manifest unverändert'
            );
        }

        $work = $this->rotateAfterCursor($dir, $work);
        $deadline = time() + max(5, $budgetSec);
        $downloaded = 0;
        $converted = 0;
        $errors = 0;
        $firstError = null;

        Log::info('Agravion icon sync starting RETR', [
            'workspace' => $workspace->public_id,
            'listed' => $listed,
            'missing' => count($work),
            'firstRemote' => $work[0]['remote'] ?? null,
        ]);

        foreach ($work as $job) {
            if (time() >= $deadline) {
                break;
            }
            File::put($dir.'/.icon-cursor', $job['key']);
            if (function_exists('set_time_limit')) {
                @set_time_limit(self::ICON_READ_TIMEOUT_SEC + 20);
            }
            try {
                $ddsLocal = $dir.'/'.$job['key'].'.dds';
                $bytes = null;
                $fetched = false;
                if (! $job['force'] && $job['ext'] === 'dds' && is_file($ddsLocal)) {
                    $cached = file_get_contents($ddsLocal);
                    if (is_string($cached) && DdsToPng::hasPayload($cached)) {
                        $bytes = $cached;
                    } else {
                        File::delete($ddsLocal);
                    }
                }
                if ($bytes === null) {
                    $bytes = $client->read($job['remote'], self::ICON_READ_TIMEOUT_SEC);
                    $fetched = true;
                }
                if ($bytes === '' || strlen($bytes) <= 32) {
                    $errors++;
                    $firstError ??= 'RETR leer '.$job['remote'];
                    $cooldown[$job['key']] = time() + self::CONVERT_COOLDOWN_SEC;
                    $this->writeConvertCooldown($dir, $cooldown);
                    continue;
                }
                if ($fetched) {
                    $downloaded++;
                }
                $isDds = str_starts_with($bytes, 'DDS ') || $job['ext'] === 'dds';
                if ($isDds) {
                    if ($fetched) {
                        File::put($ddsLocal, $bytes);
                    }
                    $png = DdsToPng::convert($bytes);
                    if ($png !== null && str_starts_with($png, "\x89PNG")) {
                        File::put($job['pngLocal'], $png);
                        unset($cooldown[$job['key']]);
                        $converted++;
                    } else {
                        $errors++;
                        if (! DdsToPng::hasPayload($bytes) && is_file($ddsLocal)) {
                            File::delete($ddsLocal);
                        }
                        $cooldown[$job['key']] = time() + self::CONVERT_COOLDOWN_SEC;
                        $this->writeConvertCooldown($dir, $cooldown);
                        $firstError ??= 'DDS→PNG fehlgeschlagen für '.$job['key'].' ('.DdsToPng::describe($bytes).')';
                    }
                } else {
                    $writeExt = in_array($job['ext'], ['png', 'jpg', 'jpeg', 'webp'], true) ? $job['ext'] : 'png';
                    File::put($dir.'/'.$job['key'].'.'.$writeExt, $bytes);
                    if ($writeExt === 'png') {
                        File::put($job['pngLocal'], $bytes);
                    }
                    $converted++;
                }
            } catch (Throwable $e) {
                $errors++;
                $cooldown[$job['key']] = time() + self::CONVERT_COOLDOWN_SEC;
                $this->writeConvertCooldown($dir, $cooldown);
                $firstError ??= $e->getMessage().' @ '.$job['remote'];
                Log::warning('Agravion icon RETR failed', [
                    'workspace' => $workspace->public_id,
                    'remote' => $job['remote'],
                    'error' => $e->getMessage(),
                ]);
            }
        }

        $missing = 0;
        $actionable = 0;
        foreach ($jobs as $job) {
            $safeKey = preg_replace('/[^a-zA-Z0-9._-]+/', '_', $job['key']) ?? 'icon';
            if ($cache->localPath($workspace, $safeKey) !== null) {
                continue;
            }
            $missing++;
            if (($cooldown[$safeKey] ?? 0) <= time()) {
                $actionable++;
            }
        }

        $this->writeConvertCooldown($dir, $cooldown);
        if ($missing === 0) {
            $this->writeIconCatalog($dir, $jobs);
        }

        return [
            'downloaded' => $downloaded,
            'converted' => $converted,
            'skipped' => null,
            'pending' => $missing,
            'errors' => $errors,
            'listed' => $listed,
            'detail' => $firstError,
            'actionable' => $actionable,
        ];
    }

    /**
     * @param  list<array{key: string, ext: string, remote: string}>  $jobs
     * @param  array{downloaded: int, converted: int, skipped: string|null, pending: int, errors: int, listed: int, detail: string|null, actionable?: int}  $result
     */
    private function recordIconPass(Workspace $workspace, array $jobs, array $result): void
    {
        $inventory = $this->iconInventory($workspace, $jobs);
        $payload = [
            'at' => gmdate('c'),
            'listed' => $result['listed'],
            'downloaded' => $result['downloaded'],
            'converted' => $result['converted'],
            'errors' => $result['errors'],
            'pending' => $result['pending'],
            'actionable' => $result['actionable'] ?? $result['pending'],
            'skipped' => $result['skipped'],
            'detail' => $result['detail'],
            'dds2rgba' => DdsToPng::externalToolAvailable(),
            'inventory' => $inventory,
        ];
        $this->writeIconStatus($workspace, $payload);

        Log::info('Agravion icon sync pass', [
            'workspace' => $workspace->public_id,
            'listed' => $result['listed'],
            'downloaded' => $result['downloaded'],
            'converted' => $result['converted'],
            'errors' => $result['errors'],
            'pending' => $result['pending'],
            'actionable' => $payload['actionable'],
            'skipped' => $result['skipped'],
            'png' => $inventory['png'],
            'ddsOnly' => $inventory['ddsOnly'],
            'missingFile' => $inventory['missingFile'],
            'dds2rgba' => $payload['dds2rgba'],
            'formats' => $inventory['formats'],
            'firstError' => $result['detail'],
        ]);
    }

    /**
     * @param  list<array{key: string, ext: string, remote: string}>  $jobs
     * @return array{png: int, ddsOnly: int, missingFile: int, formats: array<string, int>}
     */
    private function iconInventory(Workspace $workspace, array $jobs): array
    {
        $cache = new ModIconCacheService;
        $png = 0;
        $ddsOnly = 0;
        $missingFile = 0;
        $formats = [];
        foreach ($jobs as $job) {
            $safeKey = preg_replace('/[^a-zA-Z0-9._-]+/', '_', $job['key']) ?? 'icon';
            if ($cache->localPath($workspace, $safeKey) !== null) {
                $png++;
                continue;
            }
            $ddsPath = $cache->localDdsPath($workspace, $safeKey);
            if ($ddsPath === null) {
                $missingFile++;
                continue;
            }
            $ddsOnly++;
            $bytes = @file_get_contents($ddsPath);
            if (! is_string($bytes) || $bytes === '') {
                continue;
            }
            $desc = DdsToPng::describe($bytes);
            $formats[$desc] = ($formats[$desc] ?? 0) + 1;
        }
        arsort($formats);

        return [
            'png' => $png,
            'ddsOnly' => $ddsOnly,
            'missingFile' => $missingFile,
            'formats' => array_slice($formats, 0, 8, true),
        ];
    }

    /**
     * @param  array<string, mixed>  $payload
     */
    private function writeIconStatus(Workspace $workspace, array $payload): void
    {
        $path = $this->iconStatusPath($workspace);
        File::ensureDirectoryExists(dirname($path));
        File::put($path, json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)."\n");
    }

    /**
     * @return array<string, mixed>|null
     */
    public function readIconStatus(Workspace $workspace): ?array
    {
        $path = $this->iconStatusPath($workspace);
        if (! is_file($path)) {
            return null;
        }
        $decoded = json_decode((string) file_get_contents($path), true);

        return is_array($decoded) ? $decoded : null;
    }

    private function iconStatusPath(Workspace $workspace): string
    {
        return storage_path('app/connector/'.$workspace->public_id.'/icons/.status.json');
    }

    /**
     * @return array{downloaded: int, converted: int, skipped: string|null, pending: int, errors: int, listed: int, detail: string|null}
     */
    private function syncResult(
        int $downloaded = 0,
        int $converted = 0,
        ?string $skipped = null,
        int $pending = 0,
        int $errors = 0,
        int $listed = 0,
        ?string $detail = null,
    ): array {
        return [
            'downloaded' => $downloaded,
            'converted' => $converted,
            'skipped' => $skipped,
            'pending' => $pending,
            'errors' => $errors,
            'listed' => $listed,
            'detail' => $detail,
        ];
    }

    private function acquireIconLock(): bool
    {
        if (is_resource(self::$iconLock)) {
            return true;
        }
        $path = storage_path('app/connector/icon-sync.lock');
        File::ensureDirectoryExists(dirname($path));
        $handle = fopen($path, 'c+');
        if ($handle === false) {
            return false;
        }
        if (! flock($handle, LOCK_EX | LOCK_NB)) {
            fclose($handle);

            return false;
        }
        self::$iconLock = $handle;

        return true;
    }

    private function releaseIconLock(): void
    {
        if (! is_resource(self::$iconLock)) {
            self::$iconLock = null;

            return;
        }
        flock(self::$iconLock, LOCK_UN);
        fclose(self::$iconLock);
        self::$iconLock = null;
    }

    /**
     * @return array<string, int>
     */
    private function readConvertCooldown(string $dir): array
    {
        $path = $dir.'/.convert-cooldown.json';
        if (! is_file($path)) {
            return [];
        }
        $decoded = json_decode((string) file_get_contents($path), true);
        if (! is_array($decoded)) {
            return [];
        }
        $now = time();
        $out = [];
        foreach ($decoded as $key => $until) {
            if (is_string($key) && is_int($until) && $until > $now) {
                $out[$key] = $until;
            }
        }

        return $out;
    }

    /**
     * @param  array<string, int>  $cooldown
     */
    private function writeConvertCooldown(string $dir, array $cooldown): void
    {
        $path = $dir.'/.convert-cooldown.json';
        $now = time();
        $keep = [];
        foreach ($cooldown as $key => $until) {
            if (is_string($key) && is_int($until) && $until > $now) {
                $keep[$key] = $until;
            }
        }
        if ($keep === []) {
            if (is_file($path)) {
                File::delete($path);
            }

            return;
        }
        File::put($path, json_encode($keep));
    }

    /**
     * @return array<string, string>
     */
    private function readIconCatalog(string $dir): array
    {
        $path = $dir.'/.icon-catalog.json';
        if (! is_file($path)) {
            return [];
        }
        $decoded = json_decode((string) file_get_contents($path), true);
        if (! is_array($decoded)) {
            return [];
        }
        $out = [];
        foreach ($decoded as $key => $remote) {
            if (is_string($key) && is_string($remote) && $key !== '' && $remote !== '') {
                $out[$key] = $remote;
            }
        }

        return $out;
    }

    /**
     * Store key + remote path. Manifest timestamps are ignored, so a rewrite
     * with the same icons does not look like a change.
     *
     * @param  list<array{key: string, ext: string, remote: string}>  $jobs
     */
    private function writeIconCatalog(string $dir, array $jobs): void
    {
        $catalog = [];
        foreach ($jobs as $job) {
            $safeKey = preg_replace('/[^a-zA-Z0-9._-]+/', '_', $job['key']) ?? 'icon';
            $remote = $this->normalizeIconRemote($job['remote']);
            if ($remote === null) {
                continue;
            }
            $catalog[$safeKey] = $remote;
        }
        ksort($catalog);
        File::put($dir.'/.icon-catalog.json', json_encode($catalog));
    }

    private function normalizeIconRemote(string $remote): ?string
    {
        $path = str_replace('\\', '/', $remote);
        $baseName = basename($path);
        $remoteDir = rtrim(dirname($path), '/');
        if ($baseName === '' || $baseName === '.' || $baseName === '..') {
            return null;
        }

        return ($remoteDir !== '' && $remoteDir !== '.' ? $remoteDir : 'icons/store').'/'.$baseName;
    }

    private function hostAccess(Workspace $workspace): ?HostAccess
    {
        $access = HostAccess::query()->where('workspace_id', $workspace->id)->first();
        if ($access === null) {
            return null;
        }
        $password = $access->password();
        if ($password === null || $password === '') {
            return null;
        }

        return $access;
    }

    private function connectorBase(HostAccess $access): ?string
    {
        $modSettings = trim((string) ($access->remote_mod_settings_path ?? ''));
        if ($modSettings === '') {
            return null;
        }

        return rtrim(str_replace('\\', '/', $modSettings), '/').'/'.self::MOD_FOLDER;
    }

    private function iconSyncMarkerPath(Workspace $workspace): string
    {
        return storage_path('app/connector/'.$workspace->public_id.'/icons/.last_sync');
    }

    private function stateSyncMarkerPath(Workspace $workspace): string
    {
        return storage_path('app/connector/'.$workspace->public_id.'/state/.last_sync');
    }

    private function localStateDir(Workspace $workspace): string
    {
        return storage_path('app/connector/'.$workspace->public_id.'/state');
    }

    /**
     * The in-game PDA overview, copied once by the connector. Skip the FTP
     * read once a local file is present; the texture does not change mid-save.
     */
    private function pullPdaOverview(HostFileClient $client, Workspace $workspace, string $base): void
    {
        $dir = $this->localStateDir($workspace);
        foreach (['overview.dds', 'overview.png'] as $file) {
            $local = $dir.'/'.$file;
            if (is_file($local) && filesize($local) > 64) {
                continue;
            }
            try {
                $remote = $client->read($base.'/state/'.$file);
                if ($remote !== '') {
                    $this->storeLocalIfChanged($local, $remote);
                }
            } catch (Throwable) {
                // Older connectors do not copy the PDA texture.
            }
        }
        $this->ensurePdaPng($workspace);
        if ($this->pdaMapPath($workspace) !== null) {
            return;
        }

        $marker = $dir.'/overview.failed';
        if (is_file($marker) && time() - (int) filemtime($marker) < 600) {
            return;
        }

        try {
            $access = $this->hostAccess($workspace);
            $png = $access === null ? null : (new MapOverviewExtractor)->pngFromMapZip($client, $access, (string) ($workspace->map_name ?? ''));
            if (is_string($png) && str_starts_with($png, "\x89PNG")) {
                File::ensureDirectoryExists($dir);
                File::put($dir.'/overview.png', $png);
                if (is_file($marker)) {
                    File::delete($marker);
                }

                return;
            }
        } catch (Throwable $e) {
            Log::warning('Agravion PDA map: '.$e->getMessage());
            File::ensureDirectoryExists($dir);
            File::put($marker, $e->getMessage());

            return;
        }

        File::ensureDirectoryExists($dir);
        File::put($marker, 'PDA-Textur wurde nicht gefunden');
    }

    public function pdaMapPath(Workspace $workspace): ?string
    {
        $png = $this->localStateDir($workspace).'/overview.png';
        if (! is_file($png) || filesize($png) < 64) {
            return null;
        }
        $head = file_get_contents($png, false, null, 0, 8);

        return is_string($head) && str_starts_with($head, "\x89PNG") ? $png : null;
    }

    private function ensurePdaPng(Workspace $workspace): void
    {
        $dir = $this->localStateDir($workspace);
        $png = $dir.'/overview.png';
        $dds = $dir.'/overview.dds';
        if (is_file($png) && (! is_file($dds) || filemtime($png) >= filemtime($dds))) {
            return;
        }
        if (! is_file($dds)) {
            return;
        }
        $bytes = file_get_contents($dds);
        if (! is_string($bytes) || $bytes === '') {
            return;
        }
        $converted = DdsToPng::convert($bytes, 8192);
        if ($converted === null || ! str_starts_with($converted, "\x89PNG")) {
            return;
        }
        File::ensureDirectoryExists($dir);
        File::put($png, $converted);
    }

    private function localVehiclesPath(Workspace $workspace): string
    {
        return $this->localStateDir($workspace).'/vehicles_full.xml';
    }

    private function localManifestPath(Workspace $workspace): string
    {
        return $this->localStateDir($workspace).'/icons_manifest.xml';
    }

    private function storeLocalIfChanged(string $path, string $remoteXml): bool
    {
        $incoming = self::stableXmlFingerprint($remoteXml);
        if (is_file($path)) {
            $existing = self::stableXmlFingerprint((string) file_get_contents($path));
            if ($existing === $incoming) {
                return false;
            }
        }
        File::ensureDirectoryExists(dirname($path));
        File::put($path, $remoteXml);

        return true;
    }

    public static function stableXmlFingerprint(string $xml): string
    {
        $normalized = preg_replace('/\s(generation|writtenAtUtc)="[^"]*"/', '', $xml) ?? $xml;

        return hash('sha256', $normalized);
    }

    private function iconBacklogFlag(Workspace $workspace): string
    {
        return storage_path('app/connector/'.$workspace->public_id.'/icons/.backlog');
    }

    /**
     * @param  array{skipped: string|null, pending: int, actionable?: int}  $result
     */
    private function noteIconBacklog(Workspace $workspace, array $result): void
    {
        $flag = $this->iconBacklogFlag($workspace);
        $global = storage_path('app/connector/icon-sync.backlog');
        $actionable = $result['skipped'] === null
            ? (int) ($result['actionable'] ?? $result['pending'])
            : 0;
        if ($actionable > 0) {
            File::ensureDirectoryExists(dirname($flag));
            File::put($flag, (string) $actionable);
            File::ensureDirectoryExists(dirname($global));
            File::put($global, '1');

            return;
        }
        if (! in_array($result['skipped'], [null, 'unchanged', 'convert_cooldown'], true)) {
            return;
        }
        if (is_file($flag)) {
            File::delete($flag);
        }
        $any = glob(storage_path('app/connector/*/icons/.backlog'));
        if (($any === false || $any === []) && is_file($global)) {
            File::delete($global);
        }
    }

    /**
     * @param  list<array{key: string, ext: string, remote: string, pngLocal: string, force: bool}>  $work
     * @return list<array{key: string, ext: string, remote: string, pngLocal: string, force: bool}>
     */
    private function rotateAfterCursor(string $dir, array $work): array
    {
        $path = $dir.'/.icon-cursor';
        if (! is_file($path) || $work === []) {
            return $work;
        }
        $cursor = trim((string) file_get_contents($path));
        if ($cursor === '') {
            return $work;
        }
        foreach ($work as $index => $job) {
            if ($job['key'] !== $cursor) {
                continue;
            }

            return array_values(array_merge(
                array_slice($work, $index + 1),
                array_slice($work, 0, $index + 1),
            ));
        }

        return $work;
    }

    /**
     * @param  list<array<string, mixed>>  $connector
     * @param  list<array<string, mixed>>  $savegame
     * @return list<array<string, mixed>>
     */
    public static function mergeMeta(array $connector, array $savegame): array
    {
        if ($connector === []) {
            return $savegame;
        }
        if ($savegame === []) {
            return $connector;
        }

        $byId = [];
        foreach ($savegame as $row) {
            $id = $row['uniqueId'] ?? null;
            if (is_string($id) && $id !== '') {
                $byId[$id] = $row;
            }
        }
        foreach ($connector as $row) {
            $id = $row['uniqueId'] ?? null;
            if (! is_string($id) || $id === '') {
                continue;
            }
            $prev = $byId[$id] ?? [];
            foreach ($row as $key => $value) {
                if ($value !== null) {
                    $prev[$key] = $value;
                }
            }
            $byId[$id] = $prev;
        }

        $out = array_values($byId);
        foreach ($savegame as $row) {
            $id = $row['uniqueId'] ?? null;
            if (! is_string($id) || $id === '') {
                $out[] = $row;
            }
        }

        return $out;
    }
}
