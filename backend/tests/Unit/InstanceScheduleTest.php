<?php

namespace Tests\Unit;

use App\Services\InstanceSchedule;
use PHPUnit\Framework\TestCase;

final class InstanceScheduleTest extends TestCase
{
    public function test_token_depends_on_the_install_directory(): void
    {
        $a = InstanceSchedule::tokenForPath('/var/www/hof-nord/backend');
        $b = InstanceSchedule::tokenForPath('/var/www/hof-sued/backend');

        $this->assertSame(12, strlen($a));
        $this->assertNotSame($a, $b);
        $this->assertSame($a, InstanceSchedule::tokenForPath('/var/www/hof-nord/backend/'));
    }

    public function test_merge_replaces_only_this_install(): void
    {
        $artisan = '/var/www/hof-nord/backend/artisan';
        $marker = '# agravion:aaa111aaa111';
        $line = '* * * * * /usr/bin/php '.$artisan.' schedule:run >> /var/www/hof-nord/backend/storage/logs/schedule.log 2>&1 '.$marker;
        $other = '* * * * * /usr/bin/php /var/www/hof-sued/backend/artisan schedule:run >> /var/www/hof-sued/backend/storage/logs/schedule.log 2>&1 # agravion:bbb222bbb222';
        $stale = '*/5 * * * * /usr/bin/php '.$artisan.' agravion:sync-store-icons >> /tmp/old.log 2>&1';
        $unrelated = '15 3 * * * /usr/bin/certbot renew';

        $merged = InstanceSchedule::mergeCrontab($other."\n".$stale."\n".$line."\n".$unrelated."\n", $line, $artisan, $marker);

        $this->assertSame(1, substr_count($merged, '# agravion:bbb222bbb222'));
        $this->assertSame(1, substr_count($merged, $marker));
        $this->assertStringContainsString('certbot renew', $merged);
        $this->assertStringNotContainsString('sync-store-icons', $merged);
        $this->assertSame($merged, InstanceSchedule::mergeCrontab($merged, $line, $artisan, $marker));
    }

    public function test_cron_d_body_names_the_site_user_and_this_artisan(): void
    {
        $body = InstanceSchedule::cronDBody(
            'www-data',
            '/usr/bin/php',
            '/var/www/hof-nord/backend/artisan',
            '/var/www/hof-nord/backend/storage/logs/schedule.log',
        );

        $this->assertStringContainsString('* * * * * www-data ', $body);
        $this->assertStringContainsString('/var/www/hof-nord/backend/artisan', $body);
        $this->assertStringNotContainsString('/var/www/hof-sued', $body);
        $this->assertStringEndsWith("\n", $body);
    }

    public function test_classify_active_installed_stale_and_missing(): void
    {
        $now = 1_700_000_000;

        $this->assertSame('active', InstanceSchedule::classify(true, $now - 30, $now));
        $this->assertSame('active', InstanceSchedule::classify(false, $now - 60, $now));
        $this->assertSame('installed', InstanceSchedule::classify(true, null, $now));
        $this->assertSame('stale', InstanceSchedule::classify(true, $now - 600, $now));
        $this->assertSame('missing', InstanceSchedule::classify(false, null, $now));
        $this->assertSame('missing', InstanceSchedule::classify(false, $now - 600, $now));
    }
}
