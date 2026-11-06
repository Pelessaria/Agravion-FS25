<?php

namespace App\Console\Commands;

use App\Services\Update\GithubUpdateService;
use Illuminate\Console\Command;
use Throwable;

class SystemUpdateCommand extends Command
{
    protected $signature = 'agravion:update
        {--check : Only check GitHub for a newer commit}
        {--apply : Download zipball and overlay application files}
        {--force : Re-overlay backend even when already on the latest SHA}
        {--sha= : Expected remote SHA (optional safety check)}';

    protected $description = 'Check or apply Agravion updates from the public GitHub repository (shared-hosting safe).';

    public function handle(GithubUpdateService $updates): int
    {
        if ($this->option('apply')) {
            try {
                $result = $updates->apply(
                    $this->option('sha') ?: null,
                    (bool) $this->option('force'),
                );
            } catch (Throwable $e) {
                $this->error($e->getMessage());

                return self::FAILURE;
            }

            $this->info($result['message']);
            $this->line('toSha: '.$result['toSha']);
            $this->line('filesWritten: '.$result['filesWritten']);
            $this->line('migrationsRan: '.($result['migrationsRan'] ? 'yes' : 'no'));

            return self::SUCCESS;
        }

        try {
            $status = $updates->status();
        } catch (Throwable $e) {
            $this->error($e->getMessage());

            return self::FAILURE;
        }

        $this->table(
            ['Field', 'Value'],
            [
                ['repo', $status['repo']],
                ['branch', $status['branch']],
                ['installedVersion', $status['installedVersion']],
                ['installedSha', $status['installedSha'] ?? '—'],
                ['remoteSha', $status['remoteSha'] ?? '—'],
                ['updateAvailable', $status['updateAvailable'] ? 'yes' : 'no'],
                ['remoteMessage', $status['remoteMessage'] ?? '—'],
            ]
        );

        return self::SUCCESS;
    }
}
