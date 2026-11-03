<?php

namespace App\Services\Fs25;

use App\Models\HostAccess;
use App\Models\Workspace;
use GuzzleHttp\Cookie\CookieJar;
use Illuminate\Http\Client\PendingRequest;
use Illuminate\Support\Facades\Http;
use RuntimeException;
use Throwable;

/**
 * Talks to the dedicated-server web UI and the already configured file access.
 * Start, stop, settings and mod switches are submitted only when the fetched page contains that control.
 */
final class DedicatedServerConsole
{
    private const MAX_BYTES = 80 * 1024 * 1024;

    /**
     * @return array<string, mixed>
     */
    public function snapshot(Workspace $workspace): array
    {
        $workspace->loadMissing('hostAccess');
        $result = [
            'webConfigured' => $workspace->consoleConfigured(),
            'ftpConfigured' => $workspace->hostAccess !== null,
            'loggedIn' => false,
            'running' => null,
            'actions' => [],
            'mods' => [],
            'settings' => [],
            'log' => null,
            'error' => null,
            'savegameRead' => false,
            'at' => null,
            'pending' => false,
        ];

        try {
            $result['mods'] = $this->ftpMods($workspace);
        } catch (Throwable) {
            $result['error'] = 'Dateizugang fehlgeschlagen.';
        }

        $pages = [];
        $client = null;
        $base = null;
        if ($workspace->consoleConfigured()) {
            try {
                [$client, $base, $home] = $this->open($workspace);
                $pages = $this->withPages($client, $base, $home, ['logs.html', 'settings.html']);
                $result['loggedIn'] = true;
                $result['running'] = $home['running'];
                $result['actions'] = $this->publicActions($pages);
                $result['mods'] = $this->mergeMods($result['mods'], $pages);
                $result['settings'] = $this->publicSettings($pages);
                $result['log'] = $this->readLog($client, $base, $pages, $workspace);
            } catch (RuntimeException $e) {
                $result['error'] = trim(($result['error'] ? $result['error'].' ' : '').$e->getMessage());
            } catch (Throwable) {
                $result['error'] = trim(($result['error'] ? $result['error'].' ' : '').'Die Serveroberfläche ist nicht erreichbar.');
            }
        }

        try {
            [$result['mods'], $result['savegameRead']] = $this->describeMods($workspace, $result['mods'], $pages, $client, $base);
        } catch (Throwable) {
            $result['savegameRead'] = false;
        }

        return $result;
    }

    /**
     * The page reads this file. Opening the page does not contact the game server.
     *
     * @return array<string, mixed>
     */
    public function cached(Workspace $workspace): array
    {
        $workspace->loadMissing('hostAccess');
        $path = $this->cachePath($workspace);
        if (! is_file($path)) {
            return $this->blank($workspace, true);
        }
        try {
            $data = json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
        } catch (Throwable) {
            return $this->blank($workspace, true);
        }

        return is_array($data) ? $data : $this->blank($workspace, true);
    }

    /**
     * @return array<string, mixed>
     */
    public function refresh(Workspace $workspace): array
    {
        $result = $this->snapshot($workspace);
        $result['at'] = now()->toIso8601String();
        $result['pending'] = false;
        $path = $this->cachePath($workspace);
        $dir = dirname($path);
        if (! is_dir($dir) && ! mkdir($dir, 0775, true) && ! is_dir($dir)) {
            return $result;
        }
        file_put_contents($path, json_encode($result, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));

        return $result;
    }

    /**
     * @return array{ok: true, note?: string}
     */
    public function run(Workspace $workspace, string $actionId): array
    {
        if (! in_array($actionId, ['start', 'stop', 'restart'], true)) {
            throw new RuntimeException('Unbekannte Aktion.');
        }
        [$client, $base, $home] = $this->open($workspace);
        $pages = $this->withPages($client, $base, $home, []);
        if ($actionId === 'restart') {
            $restart = $this->findAction($pages, 'restart');
            if ($restart !== null) {
                $this->submit($client, $base, $restart);

                return ['ok' => true];
            }
            $stop = $this->findAction($pages, 'stop');
            if ($stop === null) {
                throw new RuntimeException('Die Oberfläche zeigt gerade keinen Neustart und keinen Stopp.');
            }
            $this->submit($client, $base, $stop);
            sleep(3);
            [$client, $base, $home] = $this->open($workspace);
            $pages = $this->withPages($client, $base, $home, []);
            $start = $this->findAction($pages, 'start');
            if ($start === null) {
                return ['ok' => true, 'note' => 'stopped'];
            }
            $this->submit($client, $base, $start);

            return ['ok' => true];
        }
        $action = $this->findAction($pages, $actionId);
        if ($action === null) {
            throw new RuntimeException('Diese Schaltfläche ist auf der Serveroberfläche gerade nicht vorhanden.');
        }
        $this->submit($client, $base, $action);

        return ['ok' => true];
    }

    /**
     * @param  array<string, mixed>  $values
     * @return array{ok: true}
     */
    public function saveSettings(Workspace $workspace, array $values): array
    {
        [$client, $base, $home] = $this->open($workspace);
        $pages = $this->withPages($client, $base, $home, ['settings.html']);
        $form = null;
        $pageUrl = null;
        foreach ($pages as $page) {
            if (($page['settingsForm']['save'] ?? null) !== null) {
                $form = $page['settingsForm'];
                $pageUrl = $page['pageUrl'];
                break;
            }
        }
        if ($form === null || $pageUrl === null) {
            throw new RuntimeException('Die Oberfläche zeigt gerade kein speicherbares Einstellungsformular.');
        }
        $payload = [];
        foreach ($form['fields'] as $field) {
            $name = $field['name'];
            if ($field['type'] === 'checkbox') {
                $on = array_key_exists($name, $values)
                    ? filter_var($values[$name], FILTER_VALIDATE_BOOLEAN)
                    : $field['checked'];
                if ($on) {
                    $payload[$name] = $field['value'] !== '' ? $field['value'] : '1';
                }
                continue;
            }
            if ($field['type'] === 'select') {
                $wanted = array_key_exists($name, $values) ? (string) $values[$name] : $field['value'];
                $allowed = array_column($field['options'], 'value');
                if (! in_array($wanted, $allowed, true)) {
                    throw new RuntimeException('Ein Einstellungswert steht nicht zur Auswahl.');
                }
                $payload[$name] = $wanted;
                continue;
            }
            $payload[$name] = array_key_exists($name, $values) ? (string) $values[$name] : $field['value'];
        }
        if ($form['save']['name'] !== '') {
            $payload[$form['save']['name']] = $form['save']['value'];
        }
        $client->asForm()->post($this->absolute($base, $pageUrl, $form['action']), $payload);

        return ['ok' => true];
    }

    /**
     * @return array{ok: true, via: string}
     */
    public function upload(Workspace $workspace, string $filename, string $bytes): array
    {
        $name = $this->safeZip($filename);
        if (strlen($bytes) > self::MAX_BYTES) {
            throw new RuntimeException('Die Datei ist größer als 80 MB.');
        }
        $workspace->loadMissing('hostAccess');
        if ($workspace->consoleConfigured()) {
            try {
                if ($this->uploadViaWeb($workspace, $name, $bytes)) {
                    return ['ok' => true, 'via' => 'web'];
                }
            } catch (Throwable) {
                // The file access below is the fallback.
            }
        }
        $this->writeFtp($workspace, $name, $bytes);

        return ['ok' => true, 'via' => 'ftp'];
    }

    /**
     * @return array{name: string, bytes: string}
     */
    public function download(Workspace $workspace, string $filename): array
    {
        $name = $this->safeZip($filename);
        $workspace->loadMissing('hostAccess');
        if ($workspace->consoleConfigured()) {
            try {
                $fromWeb = $this->downloadViaWeb($workspace, $name);
                if ($fromWeb !== null) {
                    return ['name' => $name, 'bytes' => $fromWeb];
                }
            } catch (Throwable) {
                // Fall back to the file access.
            }
        }
        $access = $this->requireAccess($workspace);
        $client = new HostFileClient($access);
        $path = $this->modPath($client, $access, $name);
        if ($client->fileSize($path) > self::MAX_BYTES) {
            throw new RuntimeException('Die Datei ist größer als 80 MB.');
        }

        return ['name' => $name, 'bytes' => $client->read($path)];
    }

    /**
     * @return array{ok: true}
     */
    public function setActive(Workspace $workspace, string $filename, bool $active): array
    {
        $name = $this->safeZip($filename);
        [$client, $base, $home] = $this->open($workspace);
        $pages = $this->withPages($client, $base, $home, ['mods.html']);
        foreach ($pages as $page) {
            foreach ($page['modRows'] as $row) {
                if (strcasecmp($row['name'], $name) !== 0) {
                    continue;
                }
                $form = $page['modForm'] ?? null;
                if ($row['checkbox'] !== null && is_array($form) && ($form['save'] ?? null) !== null) {
                    $payload = [];
                    foreach ($form['fields'] as $field) {
                        $isTarget = $field['name'] === $row['checkbox'];
                        $on = $isTarget ? $active : (bool) $field['checked'];
                        if (($field['type'] ?? '') === 'checkbox') {
                            if ($on) {
                                $payload[$field['name']] = $field['value'] !== '' ? $field['value'] : '1';
                            }
                            continue;
                        }
                        $payload[$field['name']] = $field['value'];
                    }
                    if ($form['save']['name'] !== '') {
                        $payload[$form['save']['name']] = $form['save']['value'];
                    }
                    $client->asForm()->post($this->absolute($base, $page['pageUrl'], $form['action']), $payload);

                    return ['ok' => true];
                }
                $label = mb_strtolower((string) ($row['buttonValue'] ?? ''));
                $turnsOff = preg_match('/deaktiv|disable/u', $label) === 1;
                $turnsOn = ! $turnsOff && preg_match('/aktiv|activ|enable/u', $label) === 1;
                if ($row['buttonName'] && (($active && $turnsOn) || (! $active && $turnsOff))) {
                    $payload = [];
                    if (is_array($form)) {
                        foreach ($form['fields'] as $field) {
                            if (($field['type'] ?? '') === 'checkbox' && $field['checked']) {
                                $payload[$field['name']] = $field['value'] !== '' ? $field['value'] : '1';
                            } elseif (($field['type'] ?? '') !== 'checkbox') {
                                $payload[$field['name']] = $field['value'];
                            }
                        }
                    }
                    $payload[$row['buttonName']] = (string) $row['buttonValue'];
                    $action = is_array($form) ? $form['action'] : $page['pageUrl'];
                    $client->asForm()->post($this->absolute($base, $page['pageUrl'], $action), $payload);

                    return ['ok' => true];
                }
            }
        }

        throw new RuntimeException('Die Oberfläche bietet für diese Mod gerade keinen Schalter.');
    }

    /**
     * Replace one installed zip with the newer ModHub file.
     * This runs only while the game server is stopped, and only when the ModHub page
     * itself links the zip on the Giants download host.
     *
     * @return array{ok: true, note: string}
     */
    public function updateMod(Workspace $workspace, string $name): array
    {
        $name = $this->safeZip($name);
        $workspace->loadMissing('hostAccess');
        [$client, $base, $home] = $this->open($workspace);
        unset($client, $base);
        if (($home['running'] ?? null) !== false) {
            throw new RuntimeException('Ein Update ist nur möglich, solange der Spielserver aus ist.');
        }

        $installed = '';
        foreach ($this->cached($workspace)['mods'] ?? [] as $mod) {
            if (is_array($mod) && strcasecmp((string) ($mod['name'] ?? ''), $name) === 0) {
                $installed = trim((string) ($mod['version'] ?? ''));
                break;
            }
        }
        $stem = (string) preg_replace('/\.zip$/i', '', $name);
        $info = (new ModHubCatalog())->lookup([$stem])[$stem] ?? null;
        $latest = is_array($info) ? ($info['version'] ?? null) : null;
        $pageUrl = is_array($info) ? ($info['pageUrl'] ?? null) : null;
        if (! is_string($latest) || ! is_string($pageUrl) || ! ModHubCatalog::newer($installed, $latest)) {
            throw new RuntimeException('Für diese Mod liegt auf ModHub keine neuere Version.');
        }

        set_time_limit(0);
        $page = Http::withHeaders(['User-Agent' => 'AgriVision'])
            ->withOptions(['allow_redirects' => false])
            ->timeout(20)
            ->get($pageUrl);
        if ($page->status() >= 400) {
            throw new RuntimeException('Die ModHub-Seite ist nicht erreichbar.');
        }
        $zipUrl = ModHubCatalog::zipUrl((string) $page->body(), $name);
        if ($zipUrl === null) {
            throw new RuntimeException('ModHub bietet für diese Datei keinen direkten Download.');
        }
        $local = $this->downloadHubZip($zipUrl, $pageUrl);
        try {
            $workspace->loadMissing('hostAccess');
            if ($workspace->hostAccess !== null) {
                $this->writeFtpFile($workspace, $name, $local);
            } elseif (filesize($local) !== false && filesize($local) <= self::MAX_BYTES) {
                $bytes = file_get_contents($local);
                if (! is_string($bytes) || ! $this->uploadViaWeb($workspace, $name, $bytes)) {
                    throw new RuntimeException('Die Oberfläche hat die Datei nicht angenommen.');
                }
            } else {
                throw new RuntimeException('Die Datei ist größer als 80 MB. Ohne Dateizugang kann sie nicht automatisch ersetzt werden.');
            }
        } finally {
            @unlink($local);
        }

        return ['ok' => true, 'note' => 'Die Mod wurde ersetzt. Die neue Version erscheint, sobald die Oberfläche die Datei neu liest.'];
    }

    /**
     * @param  list<array<string, mixed>>  $mods
     * @param  list<array<string, mixed>>  $pages
     * @return array{0: list<array<string, mixed>>, 1: bool}
     */
    private function describeMods(Workspace $workspace, array $mods, array $pages, ?PendingRequest $client, ?string $base): array
    {
        $cards = [];
        foreach ($pages as $page) {
            foreach ($page['modCards'] ?? [] as $card) {
                if (! is_array($card) || ! isset($card['name'])) {
                    continue;
                }
                $key = strtolower((string) $card['name']);
                if (isset($cards[$key])) {
                    $previousActive = ($cards[$key]['active'] ?? null) === true;
                    $nextActive = ($card['active'] ?? null) === true;
                    if ($previousActive && ! $nextActive) {
                        continue;
                    }
                    if (! $nextActive && ($cards[$key]['title'] ?? '') !== '' && ($card['title'] ?? '') === '') {
                        continue;
                    }
                }
                $cards[$key] = $card;
            }
        }
        $sawActive = false;
        foreach ($cards as $card) {
            if (($card['active'] ?? null) === true) {
                $sawActive = true;
                break;
            }
        }

        $byName = [];
        foreach ($mods as $mod) {
            $byName[strtolower((string) $mod['name'])] = $mod;
        }
        foreach ($cards as $key => $card) {
            if (! isset($byName[$key])) {
                $byName[$key] = [
                    'name' => $card['name'],
                    'bytes' => $card['bytes'],
                    'active' => null,
                    'source' => 'web',
                    'download' => false,
                ];
            }
        }

        $career = $this->careerMods($workspace, $client, $base);
        $careerByStem = [];
        if ($career !== null) {
            foreach ($career as $item) {
                $careerByStem[strtolower($item['modName'])] = $item;
            }
        }

        $rows = [];
        foreach ($byName as $key => $mod) {
            $card = $cards[$key] ?? null;
            $stem = strtolower((string) preg_replace('/\.zip$/i', '', (string) $mod['name']));
            $saved = $careerByStem[$stem] ?? null;
            $title = is_array($card) ? trim((string) ($card['title'] ?? '')) : '';
            $version = is_array($card) ? trim((string) ($card['version'] ?? '')) : '';
            $author = is_array($card) ? trim((string) ($card['author'] ?? '')) : '';
            if ($title === '' && $saved !== null) {
                $title = $saved['title'];
            }
            if ($version === '' && $saved !== null) {
                $version = $saved['version'];
            }
            $bytes = $mod['bytes'] ?? null;
            if ($bytes === null && is_array($card)) {
                $bytes = $card['bytes'];
            }
            $active = $mod['active'] ?? null;
            if ($sawActive) {
                $active = is_array($card) && ($card['active'] ?? null) === true;
            }
            $rows[] = [
                'name' => $mod['name'],
                'title' => $title,
                'version' => $version,
                'author' => $author,
                'bytes' => is_int($bytes) ? $bytes : null,
                'active' => is_bool($active) ? $active : null,
                'used' => null,
                'mapDependency' => false,
                'source' => $mod['source'] ?? 'web',
                'download' => (bool) ($mod['download'] ?? false),
                'hubVersion' => null,
                'hubUrl' => null,
                'updateAvailable' => false,
            ];
        }

        $hub = $this->hubInfo($workspace, $rows);
        foreach ($rows as $index => $row) {
            $stem = (string) preg_replace('/\.zip$/i', '', (string) $row['name']);
            $info = $hub[strtolower($stem)] ?? null;
            if ($info === null) {
                continue;
            }
            $rows[$index]['hubVersion'] = $info['version'];
            $rows[$index]['hubUrl'] = $info['pageUrl'];
            $rows[$index]['updateAvailable'] = ModHubCatalog::newer((string) $row['version'], $info['version']);
            if ($rows[$index]['title'] === '' && is_string($info['title']) && $info['title'] !== '') {
                $rows[$index]['title'] = $info['title'];
            }
        }

        $savegameRead = $this->applyPurchaseMarks($workspace, $rows);

        usort($rows, static function (array $a, array $b): int {
            $left = $a['title'] !== '' ? $a['title'] : $a['name'];
            $right = $b['title'] !== '' ? $b['title'] : $b['name'];

            return strcasecmp($left, $right);
        });

        return [$rows, $savegameRead];
    }

    /**
     * A mod is unused when a player farm owns none of its vehicles or buildings
     * and the mod actually sells something. Map dependencies are marked separately
     * so they are not offered as unused.
     *
     * @param  list<array<string, mixed>>  $rows
     */
    private function applyPurchaseMarks(Workspace $workspace, array &$rows): bool
    {
        $files = $this->purchaseFiles($workspace);
        if ($files === null) {
            return false;
        }
        $playerFarms = SavegameUsage::playerFarmIds($files['farms.xml']);
        $owned = SavegameUsage::ownedModStems($files['vehicles.xml'], $playerFarms);
        foreach (SavegameUsage::ownedModStems($files['placeables.xml'], $playerFarms) as $stem => $_) {
            $owned[$stem] = true;
        }
        if (isset($files['items.xml'])) {
            foreach (SavegameUsage::ownedModStems($files['items.xml'], $playerFarms) as $stem => $_) {
                $owned[$stem] = true;
            }
        }

        $installed = [];
        foreach ($rows as $row) {
            $stem = (string) preg_replace('/\.zip$/i', '', (string) $row['name']);
            if ($stem !== '') {
                $installed[strtolower($stem)] = $stem;
            }
        }
        $mapStem = SavegameUsage::mapStem($files['careerSavegame.xml'] ?? '', $installed);
        $catalog = $this->modCatalog($workspace, $rows, $mapStem, $owned);
        $dependencies = [];
        foreach ($catalog['dependencies'] as $name) {
            $dependencies[strtolower($name)] = true;
        }
        if ($playerFarms === []) {
            foreach ($rows as $index => $row) {
                $stem = strtolower((string) preg_replace('/\.zip$/i', '', (string) $row['name']));
                $dependency = isset($dependencies[$stem]);
                $rows[$index]['mapDependency'] = $dependency;
                if ($dependency) {
                    $rows[$index]['used'] = true;
                }
            }

            return true;
        }

        foreach ($rows as $index => $row) {
            $stem = strtolower((string) preg_replace('/\.zip$/i', '', (string) $row['name']));
            $dependency = isset($dependencies[$stem]);
            $rows[$index]['mapDependency'] = $dependency;
            if ($dependency || isset($owned[$stem])) {
                $rows[$index]['used'] = true;
                continue;
            }
            if (! array_key_exists($stem, $catalog['store'])) {
                $rows[$index]['used'] = null;
                continue;
            }
            $rows[$index]['used'] = $catalog['store'][$stem] ? false : true;
        }

        return true;
    }

    /**
     * @return array<string, string>|null
     */
    private function purchaseFiles(Workspace $workspace): ?array
    {
        $workspace->loadMissing('hostAccess');
        $access = $workspace->hostAccess;
        if ($access === null) {
            return null;
        }
        $save = trim(str_replace('\\', '/', (string) $access->remote_savegame_path), '/');
        if ($save === '') {
            return null;
        }
        try {
            $client = new HostFileClient($access);
            $out = [];
            foreach (['vehicles.xml', 'placeables.xml', 'farms.xml', 'careerSavegame.xml', 'items.xml'] as $name) {
                $path = $save.'/'.$name;
                if (! $client->fileExists($path)) {
                    if ($name === 'items.xml' || $name === 'careerSavegame.xml') {
                        continue;
                    }

                    return null;
                }
                $size = $client->fileSize($path);
                if ($size > 40 * 1024 * 1024) {
                    if ($name === 'items.xml') {
                        continue;
                    }

                    return null;
                }
                $out[$name] = $client->read($path);
            }
        } catch (Throwable) {
            return null;
        }

        return isset($out['vehicles.xml'], $out['placeables.xml'], $out['farms.xml']) ? $out : null;
    }

    /**
     * @param  list<array<string, mixed>>  $rows
     * @param  array<string, true>  $owned
     * @return array{dependencies: list<string>, store: array<string, bool>}
     */
    private function modCatalog(Workspace $workspace, array $rows, ?string $mapStem, array $owned): array
    {
        $path = dirname($this->cachePath($workspace)).'/mod_desc.json';
        $cache = ['map' => null, 'items' => []];
        if (is_file($path)) {
            try {
                $decoded = json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
                if (is_array($decoded)) {
                    $cache['map'] = is_array($decoded['map'] ?? null) ? $decoded['map'] : null;
                    $cache['items'] = is_array($decoded['items'] ?? null) ? $decoded['items'] : [];
                }
            } catch (Throwable) {
                $cache = ['map' => null, 'items' => []];
            }
        }

        $dependencies = [];
        $store = [];
        $workspace->loadMissing('hostAccess');
        $access = $workspace->hostAccess;
        $client = null;
        $modsDir = null;
        if ($access !== null) {
            try {
                $client = new HostFileClient($access);
                $modsDir = trim(ConnectorDeployService::resolveModsDirectory($client, $access), '/');
            } catch (Throwable) {
                $client = null;
            }
        }

        $byLower = [];
        foreach ($rows as $row) {
            $byLower[strtolower((string) $row['name'])] = $row;
        }
        $deadline = microtime(true) + 8;
        $reads = 0;

        if ($client !== null && $modsDir !== null && $mapStem !== null) {
            $mapName = $mapStem.'.zip';
            $mapRow = $byLower[strtolower($mapName)] ?? null;
            $mapBytes = is_array($mapRow) && is_int($mapRow['bytes'] ?? null) ? $mapRow['bytes'] : null;
            $cachedMap = is_array($cache['map']) ? $cache['map'] : null;
            $cachedDeps = is_array($cachedMap['dependencies'] ?? null) ? $cachedMap['dependencies'] : null;
            if ($cachedMap !== null && $cachedDeps !== null
                && strcasecmp((string) ($cachedMap['name'] ?? ''), $mapName) === 0
                && $mapBytes !== null && (int) ($cachedMap['bytes'] ?? -1) === $mapBytes) {
                $dependencies = array_values(array_filter($cachedDeps, 'is_string'));
            } else {
                $xml = $this->readModDesc($client, $modsDir, $mapName);
                $reads++;
                if (is_string($xml)) {
                    $dependencies = SavegameUsage::dependencies($xml);
                    $cache['map'] = [
                        'name' => $mapName,
                        'bytes' => $mapBytes,
                        'dependencies' => $dependencies,
                    ];
                }
            }
        }

        $dependencyKeys = [];
        foreach ($dependencies as $name) {
            $dependencyKeys[strtolower($name)] = true;
        }
        foreach ($rows as $row) {
            $filename = (string) $row['name'];
            $stem = strtolower((string) preg_replace('/\.zip$/i', '', $filename));
            $key = strtolower($filename);
            $bytes = is_int($row['bytes'] ?? null) ? $row['bytes'] : null;
            $cached = is_array($cache['items'][$key] ?? null) ? $cache['items'][$key] : null;
            if ($cached !== null && is_bool($cached['store'] ?? null) && $bytes !== null && (int) ($cached['bytes'] ?? -1) === $bytes) {
                $store[$stem] = $cached['store'];
                continue;
            }
            if ($client === null || $modsDir === null || isset($owned[$stem]) || isset($dependencyKeys[$stem])) {
                continue;
            }
            if ($reads >= 8 || microtime(true) > $deadline) {
                continue;
            }
            $xml = $this->readModDesc($client, $modsDir, $filename);
            $reads++;
            if (! is_string($xml)) {
                continue;
            }
            $hasStore = SavegameUsage::hasStoreItems($xml);
            $store[$stem] = $hasStore;
            $cache['items'][$key] = ['bytes' => $bytes, 'store' => $hasStore];
        }

        $dir = dirname($path);
        if (! is_dir($dir) && ! mkdir($dir, 0775, true) && ! is_dir($dir)) {
            return ['dependencies' => $dependencies, 'store' => $store];
        }
        $handle = fopen($path, 'c+');
        if ($handle === false) {
            return ['dependencies' => $dependencies, 'store' => $store];
        }
        try {
            if (! flock($handle, LOCK_EX)) {
                return ['dependencies' => $dependencies, 'store' => $store];
            }
            $existing = stream_get_contents($handle);
            $decoded = is_string($existing) && $existing !== '' ? json_decode($existing, true) : null;
            $items = is_array($decoded['items'] ?? null) ? $decoded['items'] : [];
            foreach ($cache['items'] as $key => $item) {
                if (is_string($key) && is_array($item)) {
                    $items[$key] = $item;
                }
            }
            $map = is_array($cache['map']) ? $cache['map'] : ($decoded['map'] ?? null);
            $payload = json_encode([
                'map' => $map,
                'items' => $items,
            ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            rewind($handle);
            ftruncate($handle, 0);
            fwrite($handle, $payload === false ? '{}' : $payload);
            fflush($handle);
        } finally {
            flock($handle, LOCK_UN);
            fclose($handle);
        }

        return ['dependencies' => $dependencies, 'store' => $store];
    }

    private function readModDesc(HostFileClient $client, string $modsDir, string $filename): ?string
    {
        try {
            $safe = $this->safeZip($filename);
            $remote = $modsDir.'/'.$safe;
            if (! $client->fileExists($remote)) {
                return null;
            }
            $size = $client->fileSize($remote);
            if ($size < 22 || $size > 2_000_000_000) {
                return null;
            }

            return ZipModDescReader::xml($size, static function (int $offset, int $length) use ($client, $remote): string {
                return $client->readRange($remote, $offset, $length);
            });
        } catch (Throwable) {
            return null;
        }
    }

    /**
     * @param  list<array<string, mixed>>  $mods
     * @return array<string, array{version: ?string, pageUrl: ?string, title: ?string}>
     */
    private function hubInfo(Workspace $workspace, array $mods): array
    {
        $wanted = [];
        foreach ($mods as $mod) {
            $stem = (string) preg_replace('/\.zip$/i', '', (string) $mod['name']);
            if ($stem !== '') {
                $wanted[$stem] = strtolower($stem);
            }
        }
        if ($wanted === []) {
            return [];
        }

        $path = dirname($this->cachePath($workspace)).'/mod_hub.json';
        $cached = null;
        if (is_file($path)) {
            try {
                $decoded = json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
                if (is_array($decoded)) {
                    $cached = $decoded;
                }
            } catch (Throwable) {
                $cached = null;
            }
        }
        $fresh = is_array($cached) && (int) ($cached['at'] ?? 0) > time() - 6 * 3600;
        $items = is_array($cached['items'] ?? null) ? $cached['items'] : [];
        $missing = false;
        if ($fresh) {
            foreach ($wanted as $stem => $lower) {
                if (! isset($items[$stem]) && ! isset($items[$lower])) {
                    $missing = true;
                    break;
                }
            }
        }
        if (! $fresh || $missing) {
            try {
                $looked = (new ModHubCatalog())->lookup(array_keys($wanted));
                $items = $looked;
                $dir = dirname($path);
                if (! is_dir($dir)) {
                    mkdir($dir, 0775, true);
                }
                file_put_contents($path, json_encode([
                    'at' => time(),
                    'items' => $items,
                ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
            } catch (Throwable) {
                if (! is_array($items)) {
                    $items = [];
                }
            }
        }

        $byLower = [];
        foreach ($items as $tech => $info) {
            if (! is_array($info)) {
                continue;
            }
            $byLower[strtolower((string) $tech)] = [
                'version' => is_string($info['version'] ?? null) ? $info['version'] : null,
                'pageUrl' => is_string($info['pageUrl'] ?? null) ? $info['pageUrl'] : null,
                'title' => is_string($info['title'] ?? null) ? $info['title'] : null,
            ];
        }

        return $byLower;
    }

    /**
     * @return list<array{modName: string, title: string, version: string}>|null
     */
    private function careerMods(Workspace $workspace, ?PendingRequest $client, ?string $base): ?array
    {
        foreach ([$this->careerFromHost($workspace), $this->careerFromFeed($workspace)] as $xml) {
            if (! is_string($xml)) {
                continue;
            }
            $parsed = SavegameModList::parse($xml);
            if ($parsed !== []) {
                return $parsed;
            }
        }

        $cached = $this->cachedCareer($workspace);
        if ($cached !== null) {
            $parsed = SavegameModList::parse($cached);
            if ($parsed !== []) {
                return $parsed;
            }
        }

        $xml = $this->careerFromWeb($workspace, $client, $base);
        if ($xml === null) {
            return null;
        }
        $this->storeCareer($workspace, $xml);
        $parsed = SavegameModList::parse($xml);

        return $parsed !== [] ? $parsed : null;
    }

    private function careerFromHost(Workspace $workspace): ?string
    {
        $workspace->loadMissing('hostAccess');
        $access = $workspace->hostAccess;
        if ($access === null) {
            return null;
        }
        $save = trim(str_replace('\\', '/', (string) $access->remote_savegame_path), '/');
        if ($save === '') {
            return null;
        }
        try {
            $client = new HostFileClient($access);
            foreach ([$save.'/careerSavegame.xml', $save.'/careerSavegame'] as $path) {
                if (! $client->fileExists($path)) {
                    continue;
                }
                $xml = $client->read($path);
                if (stripos($xml, '<mod') !== false) {
                    return $xml;
                }
            }
        } catch (Throwable) {
            return null;
        }

        return null;
    }

    private function careerFromFeed(Workspace $workspace): ?string
    {
        $base = trim((string) $workspace->feed_base_url);
        $code = $workspace->feedCode();
        if ($base === '' || $code === null || $code === '') {
            return null;
        }
        try {
            $xml = DedicatedServerFeedClient::fromParts($base, $code)->fetchSavegame('careerSavegame');
        } catch (Throwable) {
            return null;
        }

        return stripos($xml, '<mod') !== false ? $xml : null;
    }

    private function careerFromWeb(Workspace $workspace, ?PendingRequest $client, ?string $base): ?string
    {
        if ($client === null || $base === null || ! $workspace->consoleConfigured()) {
            return null;
        }
        try {
            $response = $client->get($base.'/savegames.html?lang=en');
        } catch (Throwable) {
            return null;
        }
        if ($response->status() >= 400) {
            return null;
        }
        $page = DedicatedServerPage::parse((string) $response->body(), $base.'/savegames.html?lang=en');
        $links = $page['savegameDownloads'] ?? [];
        if ($links === []) {
            return null;
        }
        $wanted = '';
        $workspace->loadMissing('hostAccess');
        if ($workspace->hostAccess !== null) {
            $wanted = strtolower(basename(trim(str_replace('\\', '/', (string) $workspace->hostAccess->remote_savegame_path), '/')));
        }
        $href = null;
        if ($wanted !== '') {
            foreach ($links as $link) {
                if (strcasecmp(basename(rtrim((string) $link, '/')), $wanted) === 0) {
                    $href = (string) $link;
                    break;
                }
            }
        } elseif (count($links) === 1) {
            $href = (string) $links[0];
        }
        if ($href === null) {
            return null;
        }
        try {
            $url = $this->absolute($base, $base.'/savegames.html?lang=en', $href);
            $download = $client->get($url);
        } catch (Throwable) {
            return null;
        }
        if ($download->status() >= 400) {
            return null;
        }
        $body = (string) $download->body();
        if (strlen($body) > self::MAX_BYTES || ! str_starts_with($body, "PK")) {
            return null;
        }

        return $this->careerXmlFromZip($body);
    }

    private function careerXmlFromZip(string $body): ?string
    {
        if (! class_exists(\ZipArchive::class)) {
            return null;
        }
        $tmp = tempnam(sys_get_temp_dir(), 'avsg');
        if ($tmp === false) {
            return null;
        }
        try {
            file_put_contents($tmp, $body);
            $zip = new \ZipArchive();
            if ($zip->open($tmp) !== true) {
                return null;
            }
            $xml = null;
            for ($i = 0; $i < $zip->numFiles; $i++) {
                $stat = $zip->statIndex($i);
                if (! is_array($stat)) {
                    continue;
                }
                $baseName = basename(str_replace('\\', '/', (string) ($stat['name'] ?? '')));
                if (strcasecmp($baseName, 'careerSavegame.xml') !== 0 && strcasecmp($baseName, 'careerSavegame') !== 0) {
                    continue;
                }
                $found = $zip->getFromIndex($i);
                if (is_string($found) && stripos($found, '<mod') !== false) {
                    $xml = $found;
                    break;
                }
            }
            $zip->close();

            return $xml;
        } finally {
            @unlink($tmp);
        }
    }

    private function cachedCareer(Workspace $workspace): ?string
    {
        $path = dirname($this->cachePath($workspace)).'/savegame_career.json';
        if (! is_file($path)) {
            return null;
        }
        try {
            $data = json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
        } catch (Throwable) {
            return null;
        }
        if (! is_array($data) || (int) ($data['at'] ?? 0) < time() - 1800) {
            return null;
        }
        $xml = $data['xml'] ?? null;

        return is_string($xml) && stripos($xml, '<mod') !== false ? $xml : null;
    }

    private function storeCareer(Workspace $workspace, string $xml): void
    {
        $path = dirname($this->cachePath($workspace)).'/savegame_career.json';
        $dir = dirname($path);
        if (! is_dir($dir) && ! mkdir($dir, 0775, true) && ! is_dir($dir)) {
            return;
        }
        file_put_contents($path, json_encode([
            'at' => time(),
            'xml' => $xml,
        ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
    }

    private function downloadHubZip(string $zipUrl, string $pageUrl): string
    {
        if (! ModHubCatalog::isGiantsZip($zipUrl)) {
            throw new RuntimeException('Die ModHub-Datei hat eine unerwartete Adresse.');
        }
        $tmp = tempnam(sys_get_temp_dir(), 'avmod');
        if ($tmp === false) {
            throw new RuntimeException('Temporäre Datei konnte nicht angelegt werden.');
        }
        $max = 800 * 1024 * 1024;
        try {
            $response = Http::withHeaders([
                'User-Agent' => 'AgriVision',
                'Referer' => $pageUrl,
            ])->withOptions([
                'sink' => $tmp,
                'allow_redirects' => false,
                'on_headers' => function ($incoming) use ($max): void {
                    $length = $incoming->getHeaderLine('Content-Length');
                    if ($length !== '' && (int) $length > $max) {
                        throw new RuntimeException('Die ModHub-Datei ist zu groß für den automatischen Austausch.');
                    }
                },
                'progress' => function ($total, $downloaded) use ($max): void {
                    if ($total > $max || $downloaded > $max) {
                        throw new RuntimeException('Die ModHub-Datei ist zu groß für den automatischen Austausch.');
                    }
                },
            ])->timeout(600)->get($zipUrl);
        } catch (RuntimeException $e) {
            @unlink($tmp);
            throw $e;
        } catch (Throwable $e) {
            @unlink($tmp);
            throw new RuntimeException('Die ModHub-Datei konnte nicht geladen werden.', 0, $e);
        }
        if ($response->status() !== 200) {
            @unlink($tmp);
            throw new RuntimeException('Die ModHub-Datei konnte nicht geladen werden.');
        }
        $size = filesize($tmp);
        $handle = fopen($tmp, 'rb');
        $magic = $handle !== false ? (string) fread($handle, 4) : '';
        if (is_resource($handle)) {
            fclose($handle);
        }
        if ($size === false || $size < 22 || $size > $max || $magic !== "PK\x03\x04") {
            @unlink($tmp);
            throw new RuntimeException('Die ModHub-Datei ist kein ZIP.');
        }

        return $tmp;
    }

    private function writeFtpFile(Workspace $workspace, string $name, string $localPath): void
    {
        $access = $this->requireAccess($workspace);
        $client = new HostFileClient($access);
        $dir = ConnectorDeployService::resolveModsDirectory($client, $access);
        $client->ensureDirectory($dir);
        $client->writeFile(trim($dir, '/').'/'.$name, $localPath);
    }

    /**
     * Login answers with a redirect whose body is only an error stub.
     * The home page is loaded afterwards with the session cookie, without following that redirect.
     *
     * @return array{0: PendingRequest, 1: string, 2: array<string, mixed>}
     */
    private function open(Workspace $workspace): array
    {
        $base = $this->baseUrl($workspace);
        $jar = new CookieJar();
        $client = Http::withOptions([
            'cookies' => $jar,
            'allow_redirects' => false,
            'http_errors' => false,
        ])->timeout(25)->connectTimeout(8);
        $homeUrl = $base.'/index.html?lang=en';
        $client->asForm()->post($homeUrl, [
            'username' => (string) $workspace->console_username,
            'password' => (string) $workspace->consolePassword(),
            'login' => 'Login',
        ]);
        $response = $client->get($homeUrl);
        if ($response->status() >= 400) {
            throw new RuntimeException('Die Serveroberfläche ist nicht erreichbar.');
        }
        $page = DedicatedServerPage::parse((string) $response->body(), $homeUrl);
        if ($page['loginForm']) {
            throw new RuntimeException('Anmeldung an der Serveroberfläche fehlgeschlagen.');
        }
        $page['pageUrl'] = $homeUrl;

        return [$client, $base, $page];
    }

    /**
     * @param  array<string, mixed>  $home
     * @param  list<string>  $names
     * @return list<array<string, mixed>>
     */
    private function withPages(PendingRequest $client, string $base, array $home, array $names): array
    {
        $home['pageUrl'] = $base.'/index.html?lang=en';
        $pages = [$home];
        foreach ($names as $name) {
            $url = $base.'/'.$name.'?lang=en';
            try {
                $response = $client->get($url);
            } catch (Throwable) {
                continue;
            }
            if ($response->status() >= 400) {
                continue;
            }
            $parsed = DedicatedServerPage::parse((string) $response->body(), $url);
            if ($parsed['loginForm']) {
                continue;
            }
            $parsed['pageUrl'] = $url;
            $pages[] = $parsed;
        }

        return $pages;
    }

    /**
     * @param  list<array<string, mixed>>  $pages
     * @return list<array{id: string, label: string}>
     */
    private function publicActions(array $pages): array
    {
        $actions = [];
        foreach (['start', 'stop', 'restart'] as $id) {
            $found = $this->findAction($pages, $id);
            if ($found !== null) {
                $actions[] = ['id' => $id, 'label' => $found['label']];
            }
        }

        return $actions;
    }

    /**
     * @param  list<array<string, mixed>>  $pages
     * @return array{id: string, label: string, action: string, buttonName: string, buttonValue: string, fields: list<array{name: string, value: string}>, pageUrl: string}|null
     */
    private function findAction(array $pages, string $id): ?array
    {
        foreach ($pages as $page) {
            foreach ($page['actions'] as $action) {
                if ($action['id'] === $id) {
                    $action['pageUrl'] = $page['pageUrl'];

                    return $action;
                }
            }
        }

        return null;
    }

    /**
     * @param  array<string, mixed>  $action
     */
    private function submit(PendingRequest $client, string $base, array $action): void
    {
        $payload = [];
        foreach ($action['fields'] as $field) {
            $payload[$field['name']] = $field['value'];
        }
        if ($action['buttonName'] !== '') {
            $payload[$action['buttonName']] = $action['buttonValue'];
        }
        $client->asForm()->post($this->absolute($base, $action['pageUrl'], $action['action']), $payload);
    }

    /**
     * @param  list<array<string, mixed>>  $ftp
     * @param  list<array<string, mixed>>  $pages
     * @return list<array<string, mixed>>
     */
    private function mergeMods(array $ftp, array $pages): array
    {
        $byName = [];
        foreach ($ftp as $mod) {
            $byName[strtolower($mod['name'])] = $mod;
        }
        foreach ($pages as $page) {
            foreach ($page['modRows'] as $row) {
                $key = strtolower($row['name']);
                $current = $byName[$key] ?? [
                    'name' => $row['name'],
                    'bytes' => null,
                    'active' => null,
                    'source' => 'web',
                    'download' => $row['download'] !== null,
                ];
                if ($row['active'] !== null) {
                    $current['active'] = $row['active'];
                }
                $current['source'] = isset($byName[$key]) ? 'both' : 'web';
                $current['download'] = ($current['download'] ?? false) || $row['download'] !== null;
                $byName[$key] = $current;
            }
        }
        $mods = array_values($byName);
        usort($mods, static fn (array $a, array $b): int => strcasecmp($a['name'], $b['name']));

        return $mods;
    }

    /**
     * @param  list<array<string, mixed>>  $pages
     * @return list<array<string, mixed>>
     */
    private function publicSettings(array $pages): array
    {
        foreach ($pages as $page) {
            $form = $page['settingsForm'] ?? null;
            if (! is_array($form) || $form['fields'] === []) {
                continue;
            }

            return array_map(static function (array $field): array {
                return [
                    'name' => $field['name'],
                    'label' => $field['label'],
                    'type' => $field['type'],
                    'value' => $field['type'] === 'checkbox' ? ($field['checked'] ? '1' : '0') : $field['value'],
                    'options' => $field['options'],
                ];
            }, $form['fields']);
        }

        return [];
    }

    /**
     * @param  list<array<string, mixed>>  $pages
     * @return array{name: string, text: string, truncated: bool}|null
     */
    private function readLog(PendingRequest $client, string $base, array $pages, Workspace $workspace): ?array
    {
        foreach ($pages as $page) {
            $inline = trim((string) ($page['logText'] ?? ''));
            if ($inline !== '') {
                return $this->tail('log', $inline);
            }
            foreach ($page['logLinks'] as $link) {
                try {
                    $url = $this->absolute($base, $page['pageUrl'] ?? $base, $link['href']);
                } catch (RuntimeException) {
                    continue;
                }
                $response = $client->get($url);
                if ($response->status() >= 400) {
                    continue;
                }
                $body = (string) $response->body();
                if ($body === '' || DedicatedServerPage::parse($body, $url)['loginForm']) {
                    continue;
                }
                $text = str_contains(strtolower($body), '<html') ? trim(strip_tags($body)) : $body;
                if ($text === '') {
                    continue;
                }

                return $this->tail($link['text'] !== '' ? $link['text'] : 'log', $text);
            }
        }

        $access = $workspace->hostAccess;
        if ($access === null) {
            return null;
        }
        try {
            $clientFiles = new HostFileClient($access);
            foreach ($this->logCandidates($access) as $path) {
                if (! $clientFiles->fileExists($path)) {
                    continue;
                }
                $size = $clientFiles->fileSize($path);
                $text = $size > 200000
                    ? $clientFiles->readRange($path, max(0, $size - 120000), 120000)
                    : $clientFiles->read($path);

                return $this->tail(basename($path), $text);
            }
        } catch (Throwable) {
            return null;
        }

        return null;
    }

    /**
     * @return list<string>
     */
    private function logCandidates(HostAccess $access): array
    {
        $paths = ['log.txt'];
        $save = trim(str_replace('\\', '/', (string) $access->remote_savegame_path), '/');
        if ($save !== '') {
            $parent = trim(dirname($save), '/.');
            if ($parent !== '' && $parent !== '.') {
                $paths[] = $parent.'/log.txt';
            }
        }

        return $paths;
    }

    /**
     * @return array{name: string, text: string, truncated: bool}
     */
    private function tail(string $name, string $text): array
    {
        $truncated = strlen($text) > 120000;
        if ($truncated) {
            $text = substr($text, -120000);
        }

        return ['name' => $name, 'text' => $text, 'truncated' => $truncated];
    }

    /**
     * @return list<array{name: string, bytes: int|null, active: null, source: string, download: bool}>
     */
    private function ftpMods(Workspace $workspace): array
    {
        $access = $workspace->hostAccess;
        if ($access === null) {
            return [];
        }
        $client = new HostFileClient($access);
        $dir = ConnectorDeployService::resolveModsDirectory($client, $access);
        $mods = [];
        foreach ($client->listNames($dir) as $name) {
            if (preg_match('/\.zip$/i', $name) !== 1) {
                continue;
            }
            $safe = $this->safeZip($name);
            $path = trim($dir, '/').'/'.$safe;
            $bytes = null;
            try {
                $bytes = $client->fileSize($path);
            } catch (Throwable) {
                $bytes = null;
            }
            $mods[] = [
                'name' => $safe,
                'bytes' => $bytes,
                'active' => null,
                'source' => 'ftp',
                'download' => true,
            ];
        }

        return $mods;
    }

    private function uploadViaWeb(Workspace $workspace, string $name, string $bytes): bool
    {
        [$client, $base, $home] = $this->open($workspace);
        foreach ($this->withPages($client, $base, $home, ['mods.html']) as $page) {
            $form = $page['modForm'] ?? null;
            if (! is_array($form) || $form['file'] === null) {
                continue;
            }
            $payload = [];
            foreach ($form['fields'] as $field) {
                if (($field['type'] ?? '') === 'checkbox') {
                    if ($field['checked']) {
                        $payload[$field['name']] = $field['value'] !== '' ? $field['value'] : '1';
                    }
                    continue;
                }
                if (($field['type'] ?? '') !== 'file') {
                    $payload[$field['name']] = $field['value'];
                }
            }
            $request = $client->attach($form['file'], $bytes, $name);
            if (($form['save']['name'] ?? '') !== '') {
                $payload[$form['save']['name']] = $form['save']['value'];
            }
            $request->post($this->absolute($base, $page['pageUrl'], $form['action']), $payload);

            return true;
        }

        return false;
    }

    private function downloadViaWeb(Workspace $workspace, string $name): ?string
    {
        [$client, $base, $home] = $this->open($workspace);
        foreach ($this->withPages($client, $base, $home, ['mods.html']) as $page) {
            foreach ($page['modRows'] as $row) {
                if (strcasecmp($row['name'], $name) !== 0 || $row['download'] === null) {
                    continue;
                }
                $url = $this->absolute($base, $page['pageUrl'], $row['download']);
                if ($url === null) {
                    continue;
                }
                $response = $client->get($url);
                if ($response->status() >= 400) {
                    continue;
                }
                $body = (string) $response->body();
                if (strlen($body) > self::MAX_BYTES) {
                    throw new RuntimeException('Die Datei ist größer als 80 MB.');
                }
                if ($body !== '') {
                    return $body;
                }
            }
        }

        return null;
    }

    private function writeFtp(Workspace $workspace, string $name, string $bytes): void
    {
        $access = $this->requireAccess($workspace);
        $client = new HostFileClient($access);
        $dir = ConnectorDeployService::resolveModsDirectory($client, $access);
        $client->ensureDirectory($dir);
        $client->write(trim($dir, '/').'/'.$name, $bytes);
    }

    private function requireAccess(Workspace $workspace): HostAccess
    {
        $access = $workspace->hostAccess;
        if ($access === null) {
            throw new RuntimeException('Dateizugang ist nicht konfiguriert.');
        }

        return $access;
    }

    private function modPath(HostFileClient $client, HostAccess $access, string $name): string
    {
        $dir = ConnectorDeployService::resolveModsDirectory($client, $access);
        $names = $client->listNames($dir);
        foreach ($names as $listed) {
            if (strcasecmp($listed, $name) === 0) {
                return trim($dir, '/').'/'.$this->safeZip($listed);
            }
        }

        throw new RuntimeException('Die Mod liegt nicht im Mods-Ordner.');
    }

    public static function origin(string $raw): string
    {
        $parts = parse_url(trim($raw));
        if (! is_array($parts) || empty($parts['scheme']) || empty($parts['host'])) {
            throw new RuntimeException('Die Adresse der Serveroberfläche muss mit http oder https beginnen.');
        }
        $scheme = strtolower((string) $parts['scheme']);
        if (! in_array($scheme, ['http', 'https'], true)) {
            throw new RuntimeException('Die Adresse der Serveroberfläche muss mit http oder https beginnen.');
        }
        $port = isset($parts['port']) ? ':'.$parts['port'] : '';

        return $scheme.'://'.$parts['host'].$port;
    }

    public static function displayOrigin(?string $raw): string
    {
        $raw = trim((string) $raw);
        if ($raw === '') {
            return '';
        }
        try {
            return self::origin($raw);
        } catch (RuntimeException) {
            return $raw;
        }
    }

    private function baseUrl(Workspace $workspace): string
    {
        $feed = trim((string) $workspace->feed_base_url);
        if ($feed !== '') {
            return self::origin($feed);
        }
        $raw = trim((string) $workspace->console_base_url);
        if ($raw === '') {
            throw new RuntimeException('Keine Adresse für die Serveroberfläche.');
        }

        return self::origin($raw);
    }

    /**
     * @return array<string, mixed>
     */
    private function blank(Workspace $workspace, bool $pending): array
    {
        return [
            'webConfigured' => $workspace->consoleConfigured(),
            'ftpConfigured' => $workspace->hostAccess !== null,
            'loggedIn' => false,
            'running' => null,
            'actions' => [],
            'mods' => [],
            'settings' => [],
            'log' => null,
            'error' => null,
            'savegameRead' => false,
            'at' => null,
            'pending' => $pending,
        ];
    }

    private function cachePath(Workspace $workspace): string
    {
        return storage_path('app/connector/'.$workspace->public_id.'/state/server_console.json');
    }

    private function absolute(string $base, string $pageUrl, string $href): string
    {
        $href = trim(html_entity_decode($href));
        if ($href === '' || str_starts_with($href, '#') || str_starts_with(strtolower($href), 'javascript:')) {
            throw new RuntimeException('Die Oberfläche verweist auf keine verwendbare Adresse.');
        }
        if (str_starts_with($href, 'http://') || str_starts_with($href, 'https://')) {
            $target = $href;
        } elseif (str_starts_with($href, '//')) {
            $scheme = parse_url($base, PHP_URL_SCHEME) ?: 'http';
            $target = $scheme.':'.$href;
        } elseif (str_starts_with($href, '/')) {
            $target = $base.$href;
        } else {
            $dir = preg_replace('#/[^/]*$#', '/', $pageUrl) ?: ($base.'/');
            $target = $dir.$href;
        }
        $expected = parse_url($base, PHP_URL_HOST);
        $actual = parse_url($target, PHP_URL_HOST);
        if (! is_string($expected) || ! is_string($actual) || strcasecmp($expected, $actual) !== 0) {
            throw new RuntimeException('Die Oberfläche verweist auf einen anderen Host.');
        }

        return $target;
    }

    private function safeZip(string $name): string
    {
        $base = basename(str_replace('\\', '/', $name));
        if (preg_match('/^[A-Za-z0-9._+ -]{1,180}\.zip$/', $base) !== 1) {
            throw new RuntimeException('Nur ZIP-Dateien mit einem einfachen Dateinamen.');
        }

        return $base;
    }

}
