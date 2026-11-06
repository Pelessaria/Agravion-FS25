<?php

namespace App\Services\Update;

use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Http;
use RuntimeException;
use Throwable;
use ZipArchive;

/**
 * Shared-hosting-safe updater: downloads the public GitHub zipball and overlays
 * application files without Docker, Composer, or shell access.
 *
 * Preserves .env and storage/. Does not replace vendor/ (must ship in release ZIP
 * or stay as previously installed). Runs migrations after a successful overlay.
 */
final class GithubUpdateService
{
    private const STATE_FILE = 'update-state.json';

    private const LOG_FILE = 'agravion-update.log';

    /**
     * @return array{
     *   enabled: bool,
     *   installedVersion: string,
     *   installedSha: string|null,
     *   installedAt: string|null,
     *   repo: string,
     *   branch: string,
     *   remoteSha: string|null,
     *   remoteMessage: string|null,
     *   remoteHtmlUrl: string|null,
     *   updateAvailable: bool,
     *   checkedAt: string,
     *   lastError: string|null,
     *   lastErrorAt: string|null,
     *   migrationError: string|null
     * }
     */
    public function status(): array
    {
        $state = $this->readState();
        $owner = (string) config('agravion.github.owner');
        $repo = (string) config('agravion.github.repo');
        $branch = (string) config('agravion.github.branch');

        $remote = null;
        try {
            $remote = $this->fetchBranchHead($owner, $repo, $branch);
        } catch (Throwable) {
            $remote = null;
        }

        $installedSha = $state['sha'] ?? null;
        $remoteSha = $remote['sha'] ?? null;

        return [
            'enabled' => (bool) config('agravion.updates.enabled'),
            'installedVersion' => (string) config('agravion.version'),
            'installedSha' => $installedSha,
            'installedAt' => $state['installedAt'] ?? null,
            'repo' => $owner.'/'.$repo,
            'branch' => $branch,
            'remoteSha' => $remoteSha,
            'remoteMessage' => $remote['message'] ?? null,
            'remoteHtmlUrl' => $remote['html_url'] ?? null,
            'updateAvailable' => is_string($remoteSha)
                && ($installedSha === null || ! hash_equals($installedSha, $remoteSha)),
            'checkedAt' => gmdate('c'),
            'lastError' => isset($state['lastError']) ? (string) $state['lastError'] : null,
            'lastErrorAt' => isset($state['lastErrorAt']) ? (string) $state['lastErrorAt'] : null,
            'migrationError' => isset($state['migrationError']) ? (string) $state['migrationError'] : null,
            'updateLog' => $this->readUpdateLog(80),
        ];
    }

    /**
     * @return list<string>
     */
    public function readUpdateLog(int $maxLines = 80): array
    {
        $path = storage_path('logs/'.self::LOG_FILE);
        if (! File::exists($path)) {
            return [];
        }

        try {
            $raw = (string) File::get($path);
        } catch (Throwable) {
            return [];
        }

        $lines = preg_split('/\r\n|\n|\r/', $raw) ?: [];
        $lines = array_values(array_filter($lines, static fn (string $line): bool => trim($line) !== ''));
        if (count($lines) <= $maxLines) {
            return $lines;
        }

        return array_slice($lines, -$maxLines);
    }

    /**
     * @return array{
     *   ok: bool,
     *   fromSha: string|null,
     *   toSha: string,
     *   filesWritten: int,
     *   migrationsRan: bool,
     *   message: string
     * }
     */
    public function apply(?string $confirmSha = null, bool $force = false): array
    {
        if (! config('agravion.updates.enabled')) {
            throw new RuntimeException('Updates are disabled on this installation.');
        }

        if (! class_exists(ZipArchive::class)) {
            throw new RuntimeException('PHP ZipArchive extension is required for updates.');
        }

        $owner = (string) config('agravion.github.owner');
        $repo = (string) config('agravion.github.repo');
        $branch = (string) config('agravion.github.branch');
        $head = $this->fetchBranchHead($owner, $repo, $branch);
        $toSha = $head['sha'];

        if ($confirmSha !== null && $confirmSha !== '' && ! hash_equals($toSha, $confirmSha)) {
            throw new RuntimeException('Remote HEAD changed. Check for updates again.');
        }

        $state = $this->readState();
        $fromSha = $state['sha'] ?? null;
        $alreadyLatest = is_string($fromSha) && hash_equals($fromSha, $toSha);

        // Same Git SHA can still mean a stale SPA in public/ (failed copy, cache, skipped dist).
        // Without --force we still re-deploy the frontend; with --force we re-overlay backend too.
        // If a previous run left migrationError, retry migrate without re-downloading.
        if ($alreadyLatest && ! $force) {
            if (! empty($state['migrationError']) || ! empty($state['lastError'])) {
                try {
                    $this->runMigrations();
                    $this->writeState([
                        'sha' => $toSha,
                        'installedAt' => gmdate('c'),
                        'fromSha' => $fromSha,
                        'filesWritten' => $state['filesWritten'] ?? 0,
                        'migrationsRan' => true,
                        'migrationError' => null,
                        'lastError' => null,
                        'lastErrorAt' => null,
                    ]);
                    $this->logUpdate("OK migration retry for {$toSha}");

                    return [
                        'ok' => true,
                        'fromSha' => $fromSha,
                        'toSha' => $toSha,
                        'filesWritten' => (int) ($state['filesWritten'] ?? 0),
                        'migrationsRan' => true,
                        'message' => 'Migrations retry succeeded. Reload the page.',
                    ];
                } catch (Throwable $e) {
                    $detail = $this->formatThrowable($e);
                    $this->logUpdate('MIGRATION RETRY FAILED: '.$detail);
                    $this->writeState(array_merge($state, [
                        'migrationError' => $detail,
                        'lastError' => 'Migration retry failed: '.$detail,
                        'lastErrorAt' => gmdate('c'),
                    ]));
                    throw new RuntimeException('Migration retry failed: '.$detail, 0, $e);
                }
            }

            return $this->redeploySpaFromGithub($owner, $repo, $toSha, $fromSha);
        }

        [$zipPath, $extractPath] = $this->downloadAndExtract($owner, $repo, $toSha);

        try {
            // Never touch secrets / runtime while overlaying application code.
            $backendRoot = $this->locateBackendRoot($extractPath);
            $filesWritten = $this->overlayDirectory($backendRoot, base_path());
            $this->compileDdsTool();

            $frontendDist = $this->locateFrontendDist($extractPath);
            if ($frontendDist !== null) {
                $filesWritten += $this->deploySpa($frontendDist);
            } else {
                throw new RuntimeException('Update archive is missing frontend/dist — UI was not refreshed.');
            }

            $this->fixWebPermissions();
            $this->syncComposerDependencies();

            $migrationsRan = false;
            try {
                $this->runMigrations();
                $migrationsRan = true;
            } catch (Throwable $e) {
                $detail = $this->formatThrowable($e);
                $this->logUpdate('MIGRATION FAILED: '.$detail);
                $this->writeState([
                    'sha' => $toSha,
                    'installedAt' => gmdate('c'),
                    'fromSha' => $fromSha,
                    'filesWritten' => $filesWritten,
                    'migrationsRan' => false,
                    'migrationError' => $detail,
                    'lastError' => 'Files updated, but migrations failed: '.$detail,
                    'lastErrorAt' => gmdate('c'),
                ]);

                throw new RuntimeException(
                    'Files updated, but migrations failed: '.$detail,
                    0,
                    $e
                );
            }

            try {
                Artisan::call('optimize:clear');
            } catch (Throwable) {
                // Optional on constrained hosts.
            }

            // Re-assert APP_KEY still present after overlay.
            $envPath = base_path('.env');
            if (! File::exists($envPath) || ! preg_match('/^APP_KEY=base64:.+/m', (string) File::get($envPath))) {
                throw new RuntimeException('Update aborted post-check: APP_KEY missing in .env (env was preserved; check file manually).');
            }

            $this->writeState([
                'sha' => $toSha,
                'installedAt' => gmdate('c'),
                'fromSha' => $fromSha,
                'filesWritten' => $filesWritten,
                'migrationsRan' => $migrationsRan,
                'migrationError' => null,
                'lastError' => null,
                'lastErrorAt' => null,
            ]);
            $this->logUpdate("OK update to {$toSha}, files={$filesWritten}, migrations=1");

            return [
                'ok' => true,
                'fromSha' => $fromSha,
                'toSha' => $toSha,
                'filesWritten' => $filesWritten,
                'migrationsRan' => $migrationsRan,
                'message' => 'Update applied safely (.env/storage preserved, SPA redeployed).',
            ];
        } catch (Throwable $e) {
            $detail = $this->formatThrowable($e);
            $this->logUpdate('UPDATE FAILED: '.$detail);
            $prev = $this->readState();
            $this->writeState(array_merge($prev, [
                'lastError' => $detail,
                'lastErrorAt' => gmdate('c'),
            ]));
            throw $e;
        } finally {
            File::delete($zipPath);
            if (File::exists($extractPath)) {
                File::deleteDirectory($extractPath);
            }
        }
    }

    /**
     * Re-copy frontend/dist → public/agravion.html + assets even when Git SHA already matches.
     *
     * @return array{ok: bool, fromSha: string|null, toSha: string, filesWritten: int, migrationsRan: bool, message: string}
     */
    private function redeploySpaFromGithub(string $owner, string $repo, string $toSha, ?string $fromSha): array
    {
        [$zipPath, $extractPath] = $this->downloadAndExtract($owner, $repo, $toSha);

        try {
            $frontendDist = $this->locateFrontendDist($extractPath);
            if ($frontendDist === null) {
                throw new RuntimeException('Update archive is missing frontend/dist — cannot refresh UI.');
            }

            $filesWritten = $this->deploySpa($frontendDist);
            $this->fixWebPermissions();

            $this->writeState([
                'sha' => $toSha,
                'installedAt' => gmdate('c'),
                'fromSha' => $fromSha,
                'filesWritten' => $filesWritten,
                'spaRedeployed' => true,
            ]);

            return [
                'ok' => true,
                'fromSha' => $fromSha,
                'toSha' => $toSha,
                'filesWritten' => $filesWritten,
                'migrationsRan' => false,
                'message' => 'Already on the latest commit — UI files were re-deployed. Hard-refresh the browser (Ctrl+F5).',
            ];
        } finally {
            File::delete($zipPath);
            if (File::exists($extractPath)) {
                File::deleteDirectory($extractPath);
            }
        }
    }

    /**
     * @return array{0: string, 1: string} [zipPath, extractPath]
     */
    private function downloadAndExtract(string $owner, string $repo, string $toSha): array
    {
        $work = storage_path('app/'.trim((string) config('agravion.updates.work_dir'), '/'));
        File::ensureDirectoryExists($work);
        $zipPath = $work.'/source.zip';
        $extractPath = $work.'/extract';

        if (File::exists($extractPath)) {
            File::deleteDirectory($extractPath);
        }
        File::ensureDirectoryExists($extractPath);

        $this->downloadZipball($owner, $repo, $toSha, $zipPath);

        $zip = new ZipArchive;
        if ($zip->open($zipPath) !== true) {
            throw new RuntimeException('Downloaded update archive could not be opened.');
        }

        if (! $zip->extractTo($extractPath)) {
            $zip->close();
            throw new RuntimeException('Update archive could not be extracted.');
        }
        $zip->close();

        return [$zipPath, $extractPath];
    }

    /**
     * Place Vite build at public/agravion.html + public/assets (never overwrite public/index.php).
     */
    private function deploySpa(string $distPath): int
    {
        $written = 0;
        $assets = $distPath.DIRECTORY_SEPARATOR.'assets';
        if (File::isDirectory($assets)) {
            $written += $this->overlayDirectory($assets, public_path('assets'));
        }

        foreach (['favicon.svg', 'favicon-light.svg', 'logo.svg'] as $file) {
            $src = $distPath.DIRECTORY_SEPARATOR.$file;
            if (File::exists($src)) {
                File::copy($src, public_path($file));
                $written++;
            }
        }

        $index = $distPath.DIRECTORY_SEPARATOR.'index.html';
        if (File::exists($index)) {
            File::copy($index, public_path('agravion.html'));
            @chmod(public_path('agravion.html'), 0644);
            $written++;
        }

        return $written;
    }

    private function fixWebPermissions(): void
    {
        $env = base_path('.env');
        if (File::exists($env)) {
            @chmod($env, 0640);
        }

        foreach ([storage_path(), base_path('bootstrap/cache')] as $dir) {
            if (! File::isDirectory($dir)) {
                continue;
            }
            try {
                File::chmod($dir, 0775);
            } catch (Throwable) {
                // Host may forbid chmod.
            }
        }
    }

    /**
     * @return array{sha: string, message: string|null, html_url: string|null}
     */
    private function fetchBranchHead(string $owner, string $repo, string $branch): array
    {
        $response = $this->githubClient()
            ->get("https://api.github.com/repos/{$owner}/{$repo}/commits/{$branch}");

        if ($response->status() === 404) {
            throw new RuntimeException("GitHub repository or branch not found: {$owner}/{$repo}@{$branch}");
        }

        if (! $response->successful()) {
            throw new RuntimeException('GitHub API error HTTP '.$response->status());
        }

        $json = $response->json();
        $sha = is_array($json) ? (string) ($json['sha'] ?? '') : '';
        if ($sha === '' || strlen($sha) < 7) {
            throw new RuntimeException('GitHub response did not include a commit SHA.');
        }

        $message = null;
        $htmlUrl = null;
        if (is_array($json)) {
            $commit = is_array($json['commit'] ?? null) ? $json['commit'] : [];
            $message = isset($commit['message']) ? trim((string) $commit['message']) : null;
            if (is_string($message) && str_contains($message, "\n")) {
                $message = trim(explode("\n", $message, 2)[0]);
            }
            $htmlUrl = isset($json['html_url']) ? (string) $json['html_url'] : null;
        }

        return [
            'sha' => $sha,
            'message' => $message,
            'html_url' => $htmlUrl,
        ];
    }

    private function downloadZipball(string $owner, string $repo, string $sha, string $zipPath): void
    {
        $response = $this->githubClient()
            ->withHeaders(['Accept' => 'application/vnd.github+json'])
            ->sink($zipPath)
            ->get("https://api.github.com/repos/{$owner}/{$repo}/zipball/{$sha}");

        if (! $response->successful() || ! File::exists($zipPath) || File::size($zipPath) < 100) {
            throw new RuntimeException('GitHub zipball download failed (HTTP '.$response->status().').');
        }
    }

    private function githubClient(): \Illuminate\Http\Client\PendingRequest
    {
        $request = Http::timeout(120)
            ->acceptJson()
            ->withHeaders([
                'User-Agent' => 'Agravion-Updater/0.3',
                'X-GitHub-Api-Version' => '2022-11-28',
            ]);

        $token = config('agravion.github.token');
        if (is_string($token) && $token !== '') {
            $request = $request->withToken($token);
        }

        return $request;
    }

    private function locateBackendRoot(string $extractPath): string
    {
        $entries = File::directories($extractPath);
        if ($entries === []) {
            throw new RuntimeException('Update archive was empty.');
        }

        $root = $entries[0];
        $backend = $root.DIRECTORY_SEPARATOR.'backend';
        if (File::isDirectory($backend) && File::exists($backend.DIRECTORY_SEPARATOR.'artisan')) {
            return $backend;
        }

        if (File::exists($root.DIRECTORY_SEPARATOR.'artisan')) {
            return $root;
        }

        throw new RuntimeException('Could not locate Laravel backend/ inside the update archive.');
    }

    private function locateFrontendDist(string $extractPath): ?string
    {
        $entries = File::directories($extractPath);
        if ($entries === []) {
            return null;
        }

        $root = $entries[0];
        $dist = $root.DIRECTORY_SEPARATOR.'frontend'.DIRECTORY_SEPARATOR.'dist';
        if (File::isDirectory($dist) && File::exists($dist.DIRECTORY_SEPARATOR.'index.html')) {
            return $dist;
        }

        return null;
    }

    private function compileDdsTool(): void
    {
        $src = base_path('tools/dds2rgba/main.c');
        $out = base_path('bin/dds2rgba');
        if (! is_file($src)) {
            return;
        }
        $gcc = trim((string) shell_exec('command -v gcc 2>/dev/null'));
        if ($gcc === '') {
            return;
        }
        File::ensureDirectoryExists(dirname($out));
        $cmd = escapeshellarg($gcc).' -O2 -o '.escapeshellarg($out).' '.escapeshellarg($src);
        shell_exec($cmd.' 2>/dev/null');
        if (is_file($out)) {
            @chmod($out, 0755);
        }
    }

    private function overlayDirectory(string $source, string $destination): int
    {
        File::ensureDirectoryExists($destination);
        $written = 0;
        $skip = array_map('strtolower', (array) config('agravion.updates.skip_zip_segments', []));

        $iterator = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($source, \FilesystemIterator::SKIP_DOTS),
            \RecursiveIteratorIterator::SELF_FIRST
        );

        /** @var \SplFileInfo $file */
        foreach ($iterator as $file) {
            $relative = str_replace('\\', '/', substr($file->getPathname(), strlen($source) + 1));
            if ($relative === '' || $relative === false) {
                continue;
            }

            $segments = explode('/', strtolower($relative));
            foreach ($segments as $segment) {
                if (in_array($segment, $skip, true)) {
                    continue 2;
                }
            }

            if ($this->isPreservedRelative($relative)) {
                continue;
            }

            $target = $destination.DIRECTORY_SEPARATOR.str_replace('/', DIRECTORY_SEPARATOR, $relative);

            if ($file->isDir()) {
                File::ensureDirectoryExists($target);

                continue;
            }

            $this->copyOverlayFile($file->getPathname(), $target, $relative);
            $written++;
        }

        return $written;
    }

    private function copyOverlayFile(string $from, string $to, string $relative): void
    {
        $dir = dirname($to);
        File::ensureDirectoryExists($dir);

        if (! is_writable($dir)) {
            throw new RuntimeException($this->permissionHint("directory not writable: {$dir}"));
        }

        if (File::exists($to) && ! is_writable($to)) {
            @chmod($to, 0664);
        }

        if (File::exists($to) && ! is_writable($to)) {
            throw new RuntimeException($this->permissionHint("file not writable: {$relative}"));
        }

        if (! @copy($from, $to)) {
            $err = error_get_last()['message'] ?? 'copy failed';
            throw new RuntimeException($this->permissionHint("{$err} ({$relative})"));
        }
    }

    private function permissionHint(string $detail): string
    {
        $backend = base_path();

        return "Update permission denied ({$detail}). "
            .'As root run: chown -R www-data:www-data '.escapeshellarg($backend)
            .' && chmod 640 '.escapeshellarg($backend.'/.env')
            .' && cd '.escapeshellarg($backend)
            .' && sudo -u www-data php artisan agravion:update --apply';
    }

    private function isPreservedRelative(string $relative): bool
    {
        $relative = strtolower(str_replace('\\', '/', $relative));
        foreach ((array) config('agravion.updates.preserve', []) as $preserve) {
            $preserve = strtolower(trim(str_replace('\\', '/', (string) $preserve), '/'));
            if ($preserve === '') {
                continue;
            }
            if ($relative === $preserve || str_starts_with($relative, $preserve.'/')) {
                return true;
            }
        }

        return false;
    }

    private function runMigrations(): void
    {
        $exit = Artisan::call('migrate', ['--force' => true]);
        $output = trim(Artisan::output());
        $this->logUpdate('migrate exit='.$exit.($output !== '' ? "\n".$output : ''));
        if ($exit !== 0) {
            throw new RuntimeException(
                'artisan migrate exited with code '.$exit
                .($output !== '' ? ': '.$output : '')
            );
        }
    }

    private function formatThrowable(Throwable $e): string
    {
        $parts = [];
        $current = $e;
        $guard = 0;
        while ($current !== null && $guard < 5) {
            $message = trim($current->getMessage());
            if ($message !== '' && ! in_array($message, $parts, true)) {
                $parts[] = $message;
            }
            $current = $current->getPrevious();
            $guard++;
        }

        return mb_substr($parts !== [] ? implode(' — ', $parts) : 'Unknown update error', 0, 4000);
    }

    private function logUpdate(string $line): void
    {
        try {
            $path = storage_path('logs/'.self::LOG_FILE);
            File::ensureDirectoryExists(dirname($path));
            File::append($path, '['.gmdate('c').'] '.$line.PHP_EOL);
        } catch (Throwable) {
            // logging must never break updates
        }
    }

    /**
     * Best-effort: install new PHP deps when composer.lock changes (vendor/ is preserved).
     */
    private function syncComposerDependencies(): void
    {
        $base = base_path();
        $phar = $base.DIRECTORY_SEPARATOR.'composer.phar';
        $php = PHP_BINARY !== '' ? PHP_BINARY : 'php';

        if (is_file($phar)) {
            $cmd = escapeshellarg($php).' '.escapeshellarg($phar)
                .' install --no-dev --optimize-autoloader --no-interaction';
        } else {
            $which = trim((string) shell_exec('command -v composer 2>/dev/null'));
            if ($which === '') {
                return;
            }
            $cmd = escapeshellarg($which).' install --no-dev --optimize-autoloader --no-interaction';
        }

        $descriptor = [
            0 => ['pipe', 'r'],
            1 => ['pipe', 'w'],
            2 => ['pipe', 'w'],
        ];
        $proc = proc_open($cmd, $descriptor, $pipes, $base, null);
        if (! is_resource($proc)) {
            return;
        }
        fclose($pipes[0]);
        stream_get_contents($pipes[1]);
        stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        proc_close($proc);
    }

    /**
     * @return array<string, mixed>
     */
    private function readState(): array
    {
        $path = storage_path('app/'.self::STATE_FILE);
        if (! File::exists($path)) {
            return [];
        }

        $decoded = json_decode((string) File::get($path), true);

        return is_array($decoded) ? $decoded : [];
    }

    /**
     * @param  array<string, mixed>  $state
     */
    private function writeState(array $state): void
    {
        File::put(
            storage_path('app/'.self::STATE_FILE),
            json_encode($state, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)
        );
    }
}
