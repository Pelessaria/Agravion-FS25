<?php

namespace App\Services\Fs25;

use App\Models\Workspace;
use App\Services\InstanceSchedule;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;

/**
 * Icon FTP runs from the per-install scheduler cron (schedule:run).
 * When that cron is not installed yet, the next dashboard request still
 * finishes the HTTP response and then runs one check, so shared hosting
 * without cron does not stop completely.
 */
final class IconSyncDaemon
{
    public static function ensureStarted(): void
    {
        if (app()->runningInConsole() || app()->runningUnitTests()) {
            return;
        }
        if (PHP_OS_FAMILY === 'Windows') {
            return;
        }

        InstanceSchedule::ensureInstalled();
        if (InstanceSchedule::isInstalled()) {
            return;
        }

        app()->terminating(static function (): void {
            self::drainAfterResponse();
        });
    }

    public static function writePid(): void
    {
        $pidFile = storage_path('app/connector/icon-sync.pid');
        File::ensureDirectoryExists(dirname($pidFile));
        File::put($pidFile, (string) getmypid());
    }

    private static function drainAfterResponse(): void
    {
        $checked = storage_path('app/connector/icon-sync.checked');
        $backlog = is_file(storage_path('app/connector/icon-sync.backlog'));
        $gap = $backlog
            ? ConnectorSnapshotService::ICON_BACKLOG_INTERVAL_SEC
            : ConnectorSnapshotService::ICON_SYNC_INTERVAL_SEC;
        if (is_file($checked) && (time() - (int) filemtime($checked)) < $gap) {
            return;
        }

        $canDetach = function_exists('fastcgi_finish_request');
        if ($canDetach) {
            @fastcgi_finish_request();
        }
        if (function_exists('ignore_user_abort')) {
            @ignore_user_abort(true);
        }
        if (function_exists('set_time_limit')) {
            @set_time_limit(0);
        }

        try {
            $icons = app(ConnectorSnapshotService::class);
            foreach (Workspace::query()->cursor() as $workspace) {
                $result = $icons->syncStoreIconsIfDue($workspace);
                if (($result['skipped'] ?? null) === 'busy') {
                    return;
                }
            }
        } catch (\Throwable $e) {
            Log::warning('Agravion icon sync stopped', ['error' => $e->getMessage()]);
        }
    }
}
