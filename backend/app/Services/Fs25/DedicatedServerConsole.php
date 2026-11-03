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
            'at' => null,
            'pending' => false,
        ];

        try {
            $result['mods'] = $this->ftpMods($workspace);
        } catch (Throwable) {
            $result['error'] = 'Dateizugang fehlgeschlagen.';
        }

        if (! $workspace->consoleConfigured()) {
            return $result;
        }

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
