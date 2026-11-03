<?php

use App\Models\Workspace;
use App\Services\Fs25\ConnectorSnapshotService;
use App\Services\Fs25\DedicatedServerConsole;
use App\Services\Fs25\PrecisionLayerService;
use App\Services\InstanceSchedule;
use Illuminate\Foundation\Inspiring;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Schedule;

Artisan::command('inspire', function () {
    $this->comment(Inspiring::quote());
})->purpose('Display an inspiring quote');

Artisan::command('agrivision:sync-store-icons {--daemon : Keep pulling icons until the process is stopped}', function (ConnectorSnapshotService $icons) {
    if ($this->option('daemon')) {
        \App\Services\Fs25\IconSyncDaemon::writePid();
        $this->info('icon daemon '.getmypid());
    }

    $run = function (int $interval, int $budgetSec = 120) use ($icons): array {
        $pending = 0;
        $moved = 0;
        foreach (Workspace::query()->cursor() as $workspace) {
            $result = $icons->syncStoreIconsIfDue($workspace, $interval, $budgetSec);
            $pending += (int) $result['pending'];
            $moved += (int) $result['downloaded'] + (int) $result['converted'];
            $this->line(sprintf(
                '%s downloaded=%d converted=%d pending=%d listed=%d skipped=%s detail=%s',
                $workspace->public_id,
                $result['downloaded'],
                $result['converted'],
                $result['pending'],
                $result['listed'],
                $result['skipped'] ?? '-',
                $result['detail'] ?? '-'
            ));
            if (($result['skipped'] ?? null) === 'busy') {
                return ['pending' => $pending, 'moved' => 0];
            }
        }

        return ['pending' => $pending, 'moved' => $moved];
    };

    if (! $this->option('daemon')) {
        $deadline = time() + 480;
        do {
            $pass = $run(0, 120);
        } while ($pass['pending'] > 0 && $pass['moved'] > 0 && time() < $deadline);

        return;
    }

    while (true) {
        $deadline = time() + 480;
        $pass = ['pending' => 0, 'moved' => 0];
        try {
            do {
                $pass = $run(0, 120);
            } while ($pass['pending'] > 0 && $pass['moved'] > 0 && time() < $deadline);
        } catch (Throwable $e) {
            $this->error($e->getMessage());
        }
        sleep($pass['pending'] > 0 ? ConnectorSnapshotService::ICON_BACKLOG_INTERVAL_SEC : ConnectorSnapshotService::ICON_SYNC_INTERVAL_SEC);
    }
})->purpose('Pull missing vehicle store icons over FTP');

Schedule::call(function () {
    $service = app(ConnectorSnapshotService::class);
    foreach (Workspace::query()->cursor() as $workspace) {
        $service->refreshLocalStateIfDue($workspace);
    }
})
    ->everyMinute()
    ->name('connector-state')
    ->withoutOverlapping(2);

Schedule::call(function () {
    $layers = app(PrecisionLayerService::class);
    foreach (Workspace::query()->cursor() as $workspace) {
        $layers->refresh($workspace);
    }
})
    ->everyFiveMinutes()
    ->name('precision-layers')
    ->withoutOverlapping(8);

Schedule::command('agrivision:sync-store-icons')
    ->everyFiveMinutes()
    ->withoutOverlapping(20)
    ->appendOutputTo(storage_path('logs/icon-sync.log'));

Schedule::call(function () {
    $console = app(DedicatedServerConsole::class);
    foreach (Workspace::query()->cursor() as $workspace) {
        $workspace->loadMissing('hostAccess');
        if (! $workspace->consoleConfigured() && $workspace->hostAccess === null) {
            continue;
        }
        $console->refresh($workspace);
    }
})
    ->everyMinute()
    ->name('server-console')
    ->withoutOverlapping(3);

Schedule::call(fn () => InstanceSchedule::touchHeartbeat())
    ->everyMinute()
    ->name('scheduler-heartbeat');

Artisan::command('agrivision:install-schedule', function () {
    $result = \App\Services\InstanceSchedule::install();
    $this->line($result['detail']);

    return $result['ok'] ? 0 : 1;
})->purpose('Install this directory\'s scheduler cron without touching other installations');

Artisan::command('agrivision:schedule-status', function () {
    $status = \App\Services\InstanceSchedule::status();
    $this->line(sprintf(
        'state=%s installed=%s daemon=%s last=%s',
        $status['state'],
        $status['installed'] ? 'yes' : 'no',
        $status['daemon'],
        $status['lastRunAt'] ?? '-'
    ));

    return $status['active'] ? 0 : 1;
})->purpose('Report whether this install\'s scheduler cron is installed and running');

Artisan::command('agrivision:icon-status', function (ConnectorSnapshotService $icons) {
    $cache = new \App\Services\Fs25\ModIconCacheService;
    $this->line('dds2rgba='.(\App\Services\Fs25\DdsToPng::externalToolAvailable() ? 'yes' : 'no'));
    $exit = 0;
    foreach (Workspace::query()->cursor() as $workspace) {
        $dir = $cache->cacheDir($workspace);
        $state = storage_path('app/connector/'.$workspace->public_id.'/state');
        $png = is_dir($dir) ? count(glob($dir.'/*.png') ?: []) : 0;
        $dds = is_dir($dir) ? count(glob($dir.'/*.dds') ?: []) : 0;
        $manifest = is_file($state.'/icons_manifest.xml')
            ? substr_count((string) file_get_contents($state.'/icons_manifest.xml'), '<store ')
            : 0;
        $vehicles = is_file($state.'/vehicles_full.xml')
            ? substr_count((string) file_get_contents($state.'/vehicles_full.xml'), '<vehicle ')
            : 0;
        $status = $icons->readIconStatus($workspace);
        $inv = is_array($status['inventory'] ?? null) ? $status['inventory'] : null;
        $this->line(sprintf(
            '%s manifest=%d vehicles=%d disk_png=%d disk_dds=%d',
            $workspace->public_id,
            $manifest,
            $vehicles,
            $png,
            $dds
        ));
        if ($inv !== null) {
            $this->line(sprintf(
                '  last sync at=%s png=%d ddsOnly=%d missing=%d pending=%s detail=%s',
                $status['at'] ?? '-',
                $inv['png'] ?? 0,
                $inv['ddsOnly'] ?? 0,
                $inv['missingFile'] ?? 0,
                $status['pending'] ?? '-',
                $status['detail'] ?? '-'
            ));
            foreach (($inv['formats'] ?? []) as $format => $count) {
                $this->line(sprintf('  format %dx %s', $count, $format));
            }
            if (($inv['ddsOnly'] ?? 0) > 0 && ! \App\Services\Fs25\DdsToPng::externalToolAvailable()) {
                $this->warn('  BC7 icons need bin/dds2rgba — see docs/INSTALLATION.md');
                $exit = 1;
            } elseif (($inv['ddsOnly'] ?? 0) > 0 || ($inv['missingFile'] ?? 0) > 0) {
                $exit = 1;
            }
        } elseif ($manifest > 0 && $png === 0) {
            $this->warn('  no .status.json yet — wait for cron or run php artisan agrivision:sync-store-icons');
            $exit = 1;
        }
    }

    return $exit;
})->purpose('Show local connector icon cache counts and last sync inventory');
