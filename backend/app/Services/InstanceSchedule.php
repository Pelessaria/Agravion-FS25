<?php

namespace App\Services;

use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;

/**
 * One scheduler cron per installation directory.
 *
 * Several customers on the same VPS each have their own directory, database,
 * and cron entry. Installing or renewing one entry never removes another.
 * Root writes /etc/cron.d (reliable on a VPS). Otherwise the current user's
 * crontab is updated, and only this install's marker line is replaced.
 */
final class InstanceSchedule
{
    public static function tokenForPath(string $path): string
    {
        $path = rtrim(str_replace('\\', '/', $path), '/');

        return substr(hash('sha256', $path), 0, 12);
    }

    public static function token(): string
    {
        return self::tokenForPath(base_path());
    }

    public static function marker(): string
    {
        return '# agravion:'.self::token();
    }

    public static function cronDPath(): string
    {
        return '/etc/cron.d/agravion-'.self::token();
    }

    public static function cronDBody(string $user, string $php, string $artisan, string $log): string
    {
        return "SHELL=/bin/sh\n"
            ."MAILTO=\"\"\n"
            ."PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n"
            .'* * * * * '.$user.' '.self::quote($php).' '.self::quote($artisan)
            .' schedule:run >> '.self::quote($log)." 2>&1\n";
    }

    /**
     * Keep every other installation's lines. Drop only this install's previous
     * scheduler or icon-sync line, then append the current one.
     */
    public static function mergeCrontab(string $existing, string $line, string $artisanPath, string $marker): string
    {
        $artisanPath = str_replace('\\', '/', $artisanPath);
        $kept = [];
        foreach (preg_split('/\R/', $existing) ?: [] as $existingLine) {
            if (trim($existingLine) === '') {
                continue;
            }
            if (str_contains($existingLine, $marker)) {
                continue;
            }
            $normalized = str_replace('\\', '/', $existingLine);
            $ownsThisInstall = str_contains($normalized, $artisanPath)
                && (str_contains($normalized, 'schedule:run') || str_contains($normalized, 'agravion:sync-store-icons'));
            if ($ownsThisInstall) {
                continue;
            }
            $kept[] = $existingLine;
        }

        return implode("\n", $kept).(count($kept) > 0 ? "\n" : '').$line."\n";
    }

    public const HEARTBEAT_FRESH_SEC = 180;

    public static function touchHeartbeat(): void
    {
        $path = self::heartbeatPath();
        File::ensureDirectoryExists(dirname($path));
        File::put($path, (string) time());
    }

    /**
     * active: this install's cron ran in the last three minutes.
     * installed: the entry exists, but no run has been seen yet.
     * stale: the entry exists, and the last run is too old.
     * missing: no entry for this directory.
     *
     * @return 'active'|'installed'|'stale'|'missing'
     */
    public static function classify(bool $installed, ?int $lastRunUnix, int $now): string
    {
        if ($lastRunUnix !== null && $lastRunUnix > 0 && ($now - $lastRunUnix) >= 0 && ($now - $lastRunUnix) <= self::HEARTBEAT_FRESH_SEC) {
            return 'active';
        }
        if (! $installed) {
            return 'missing';
        }
        if ($lastRunUnix === null || $lastRunUnix <= 0) {
            return 'installed';
        }

        return 'stale';
    }

    /**
     * @return array{state: string, installed: bool, active: bool, daemon: string, lastRunAt: string|null}
     */
    public static function status(): array
    {
        $installed = self::isInstalled();
        $lastRunUnix = self::lastHeartbeat();
        $state = self::classify($installed, $lastRunUnix, time());

        return [
            'state' => $state,
            'installed' => $installed || $state === 'active',
            'active' => $state === 'active',
            'daemon' => self::daemonState(),
            'lastRunAt' => $lastRunUnix !== null ? gmdate('c', $lastRunUnix) : null,
        ];
    }

    public static function isInstalled(): bool
    {
        $artisan = str_replace('\\', '/', base_path('artisan'));
        $cronD = self::cronDPath();
        if (is_file($cronD)) {
            $body = (string) file_get_contents($cronD);

            return str_contains(str_replace('\\', '/', $body), $artisan);
        }

        $ok = self::markerPath();
        if (! is_file($ok)) {
            return false;
        }

        return str_contains(str_replace('\\', '/', (string) file_get_contents($ok)), $artisan);
    }

    /**
     * @return array{ok: bool, detail: string}
     */
    public static function install(): array
    {
        if (PHP_OS_FAMILY === 'Windows') {
            return ['ok' => false, 'detail' => 'Scheduler cron is installed on the Linux host.'];
        }

        $php = self::phpCli();
        $artisan = base_path('artisan');
        $log = storage_path('logs/schedule.log');
        File::ensureDirectoryExists(dirname($log));

        if (self::runningAsRoot() && is_dir('/etc/cron.d')) {
            return self::installCronD($php, $artisan, $log);
        }

        if (is_file(self::cronDPath())) {
            self::remember('cron.d '.self::cronDPath());

            return ['ok' => true, 'detail' => 'Scheduler already installed at '.self::cronDPath()];
        }

        return self::installUserCrontab($php, $artisan, $log);
    }

    public static function ensureInstalled(): void
    {
        if (PHP_OS_FAMILY === 'Windows' || app()->runningUnitTests()) {
            return;
        }

        $stamp = self::markerPath();
        if (self::isInstalled() && is_file($stamp) && (time() - (int) filemtime($stamp)) < 86400) {
            return;
        }

        $fail = storage_path('app/instance-schedule.failed');
        if (! self::isInstalled() && is_file($fail) && (time() - (int) filemtime($fail)) < 3600) {
            return;
        }

        try {
            $result = self::install();
        } catch (\Throwable $e) {
            Log::warning('Agravion scheduler cron was not installed', ['detail' => $e->getMessage()]);

            return;
        }
        if ($result['ok']) {
            if (is_file($fail)) {
                File::delete($fail);
            }

            return;
        }

        File::ensureDirectoryExists(dirname($fail));
        File::put($fail, $result['detail']);
        Log::warning('Agravion scheduler cron was not installed', ['detail' => $result['detail']]);
    }

    /**
     * @return array{ok: bool, detail: string}
     */
    private static function installCronD(string $php, string $artisan, string $log): array
    {
        $user = self::webUser();
        $body = self::cronDBody($user, $php, $artisan, $log);
        $path = self::cronDPath();
        if (file_put_contents($path, $body) === false) {
            return ['ok' => false, 'detail' => 'Could not write '.$path];
        }
        @chmod($path, 0644);
        self::removeOwnUserCrontabLine($user, $artisan);
        self::remember($path);

        return ['ok' => true, 'detail' => 'Scheduler cron '.$path.' as '.$user];
    }

    /**
     * @return array{ok: bool, detail: string}
     */
    private static function installUserCrontab(string $php, string $artisan, string $log): array
    {
        if (self::shellDisabled()) {
            return ['ok' => false, 'detail' => 'shell_exec is disabled; install the scheduler as root via agravion:install-schedule'];
        }

        $line = '* * * * * '.self::quote($php).' '.self::quote($artisan)
            .' schedule:run >> '.self::quote($log).' 2>&1 '.self::marker();
        $user = self::runningAsRoot() ? self::webUser() : null;
        $existing = shell_exec(self::crontabCommand($user, 'list'));
        $existing = is_string($existing) ? $existing : '';
        $body = self::mergeCrontab($existing, $line, $artisan, self::marker());
        $tmp = storage_path('app/instance-schedule.crontab');
        File::ensureDirectoryExists(dirname($tmp));
        File::put($tmp, $body);
        shell_exec(self::crontabCommand($user, 'install', $tmp));
        $check = shell_exec(self::crontabCommand($user, 'list'));
        if (! is_string($check) || ! str_contains($check, self::marker())) {
            return ['ok' => false, 'detail' => 'crontab rejected the scheduler line'];
        }
        self::remember($line);

        return ['ok' => true, 'detail' => 'Scheduler cron installed for this directory'];
    }

    private static function removeOwnUserCrontabLine(string $user, string $artisan): void
    {
        if (self::shellDisabled()) {
            return;
        }
        $existing = shell_exec(self::crontabCommand($user, 'list'));
        if (! is_string($existing) || ! str_contains($existing, $artisan)) {
            return;
        }
        $body = self::mergeCrontab($existing, '', $artisan, self::marker());
        $body = trim($body);
        $tmp = storage_path('app/instance-schedule.crontab');
        File::ensureDirectoryExists(dirname($tmp));
        File::put($tmp, $body === '' ? "\n" : $body."\n");
        shell_exec(self::crontabCommand($user, 'install', $tmp));
    }

    private static function crontabCommand(?string $user, string $action, string $file = ''): string
    {
        $bin = 'crontab';
        if ($user !== null && $user !== '') {
            $bin .= ' -u '.self::quote($user);
        }
        if ($action === 'list') {
            return $bin.' -l 2>/dev/null';
        }

        return $bin.' '.self::quote($file).' 2>&1';
    }

    private static function remember(string $detail): void
    {
        $path = self::markerPath();
        File::ensureDirectoryExists(dirname($path));
        if (is_file($path) && ! is_writable($path)) {
            return;
        }
        if (! is_file($path) && ! is_writable(dirname($path))) {
            return;
        }
        File::put($path, $detail."\n".str_replace('\\', '/', base_path('artisan')));
    }

    private static function markerPath(): string
    {
        return storage_path('app/instance-schedule.cron');
    }

    private static function heartbeatPath(): string
    {
        return storage_path('app/instance-schedule.heartbeat');
    }

    private static function lastHeartbeat(): ?int
    {
        $path = self::heartbeatPath();
        if (! is_file($path)) {
            return null;
        }
        $raw = trim((string) file_get_contents($path));
        if ($raw !== '' && ctype_digit($raw)) {
            return (int) $raw;
        }
        $mtime = filemtime($path);

        return $mtime === false ? null : (int) $mtime;
    }

    private static function daemonState(): string
    {
        if (PHP_OS_FAMILY === 'Windows' || self::shellDisabled()) {
            return 'unknown';
        }

        foreach (['cron', 'crond'] as $unit) {
            $out = shell_exec('systemctl is-active '.escapeshellarg($unit).' 2>/dev/null');
            $out = is_string($out) ? trim($out) : '';
            if ($out === 'active') {
                return 'running';
            }
            if ($out === 'inactive' || $out === 'failed') {
                return 'stopped';
            }
        }

        $pids = shell_exec('pgrep -x cron 2>/dev/null || pgrep -x crond 2>/dev/null');
        if (is_string($pids) && trim($pids) !== '') {
            return 'running';
        }

        return 'unknown';
    }

    private static function runningAsRoot(): bool
    {
        if (function_exists('posix_geteuid')) {
            return posix_geteuid() === 0;
        }

        return get_current_user() === 'root';
    }

    private static function webUser(): string
    {
        foreach (['nginx', 'www-data'] as $user) {
            if (function_exists('posix_getpwnam') && posix_getpwnam($user) !== false) {
                return $user;
            }
        }

        return 'www-data';
    }

    private static function shellDisabled(): bool
    {
        $disabled = array_map('trim', explode(',', (string) ini_get('disable_functions')));

        return in_array('shell_exec', $disabled, true);
    }

    private static function phpCli(): string
    {
        $binary = PHP_BINARY;
        $base = strtolower(basename($binary));
        if ($binary !== '' && ! str_contains($base, 'fpm') && is_executable($binary) && preg_match('/^php(?:\d+(?:\.\d+)?)?$/', $base) === 1) {
            return $binary;
        }
        foreach (['/usr/bin/php', '/usr/bin/php8.3', '/usr/bin/php8.4', '/usr/bin/php8.2', '/usr/bin/php8.5'] as $path) {
            if (is_executable($path)) {
                return $path;
            }
        }

        return 'php';
    }

    private static function quote(string $value): string
    {
        return escapeshellarg($value);
    }
}
