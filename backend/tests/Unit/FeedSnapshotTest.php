<?php

namespace Tests\Unit;

use App\Services\Fs25\FeedSnapshot;
use PHPUnit\Framework\TestCase;

class FeedSnapshotTest extends TestCase
{
    public function test_from_raw_normalizes_stats_and_counts(): void
    {
        $stats = [
            'server' => [
                'name' => 'Test Farm',
                'mapName' => 'Riverbend Springs',
                'mapSize' => 4096,
                'version' => '1.24.0.0',
                'dayTime' => 52000000,
            ],
            'Slots' => [
                'capacity' => 10,
                'numUsed' => 2,
            ],
            'Mods' => [
                'Mod' => [
                    ['name' => 'FS25_A', 'author' => 'A', 'version' => '1.0', 'hash' => 'aaa', 'title' => 'A'],
                    ['name' => 'FS25_B', 'author' => 'B', 'version' => '2.0', 'hash' => 'bbb', 'title' => 'B'],
                ],
            ],
            'Vehicles' => [
                'Vehicle' => [
                    ['name' => 'Tractor', 'category' => 'tractor', 'type' => 't', 'x' => 1, 'y' => 2, 'z' => 3],
                ],
            ],
        ];

        $career = '<careerSavegame><statistics><money>12345</money></statistics></careerSavegame>';
        $vehicles = '<vehicles><vehicle uniqueId="1"/><vehicle uniqueId="2"/></vehicles>';
        $economy = '<economy><fillType name="wheat"/><fillType name="barley"/></economy>';

        $snapshot = FeedSnapshot::fromRaw(
            baseUrl: 'https://example.test:8080',
            fetchedAtUtc: '2026-10-14T00:00:00Z',
            statsJson: $stats,
            careerXml: $career,
            vehiclesXml: $vehicles,
            economyXml: $economy,
        );

        $this->assertSame('online', $snapshot->linkState);
        $this->assertSame('Test Farm', $snapshot->serverName);
        $this->assertSame('Riverbend Springs', $snapshot->mapName);
        $this->assertSame(4096, $snapshot->mapSize);
        $this->assertSame(2, $snapshot->playersOnline);
        $this->assertSame(10, $snapshot->playerCapacity);
        $this->assertSame(2, $snapshot->modCount);
        $this->assertSame(1, $snapshot->vehicleCountStats);
        $this->assertSame(2, $snapshot->vehicleCountSavegame);
        $this->assertSame(2, $snapshot->economyFillTypes);
        $this->assertSame('12345', $snapshot->careerMoney);
        $this->assertArrayNotHasKey('code', $snapshot->toArray());
    }

    public function test_slots_from_attributes_and_slot_flags(): void
    {
        $stats = [
            'server' => [
                '@attributes' => [
                    'name' => 'Attr Server',
                    'mapName' => 'Map',
                    'version' => '1.24.0.0',
                ],
            ],
            'Slots' => [
                '@attributes' => [
                    'capacity' => '10',
                    'numUsed' => '0',
                ],
                'Slot' => [
                    ['@attributes' => ['isUsed' => 'false']],
                    ['@attributes' => ['isUsed' => 'false']],
                ],
            ],
        ];

        $snapshot = FeedSnapshot::fromRaw(
            baseUrl: 'https://example.test:8080',
            fetchedAtUtc: '2026-10-14T00:00:00Z',
            statsJson: $stats,
            careerXml: '',
            vehiclesXml: '',
            economyXml: '',
        );

        $this->assertSame('Attr Server', $snapshot->serverName);
        $this->assertSame(0, $snapshot->playersOnline);
        $this->assertSame(10, $snapshot->playerCapacity);
        $this->assertSame('1.24.0.0', $snapshot->gameVersion);
    }

    public function test_slots_from_live_json_shape(): void
    {
        // Shape observed on FS25 dedicated-server-stats.json (lowercase slots.used + players[]).
        $stats = [
            'server' => [
                'name' => 'Pelle Lokal',
                'mapName' => 'Schwesing Bahnhof',
                'version' => '1.24.0.0',
            ],
            'slots' => [
                'capacity' => 12,
                'used' => 0,
                'players' => array_fill(0, 12, ['isUsed' => false]),
            ],
        ];

        $snapshot = FeedSnapshot::fromRaw(
            baseUrl: 'http://10.10.2.17:8081',
            fetchedAtUtc: '2026-10-14T00:00:00Z',
            statsJson: $stats,
            careerXml: '',
            vehiclesXml: '',
            economyXml: '',
        );

        $this->assertSame(0, $snapshot->playersOnline);
        $this->assertSame(12, $snapshot->playerCapacity);
    }

    public function test_flat_lowercase_mods_array(): void
    {
        $stats = [
            'server' => ['name' => 'Demo', 'version' => '1.24.0.0'],
            'slots' => ['capacity' => 8, 'used' => 0, 'players' => []],
            'mods' => [
                ['name' => 'FS25_AgravionConnector', 'author' => 'Agravion', 'version' => '0.1.1.1', 'title' => 'Agravion Connector'],
                ['name' => 'FS25_Courseplay', 'author' => 'CP', 'version' => '8.1.0.3', 'title' => 'CoursePlay'],
            ],
        ];

        $snapshot = FeedSnapshot::fromRaw(
            baseUrl: 'http://example.test:8080',
            fetchedAtUtc: '2026-10-14T00:00:00Z',
            statsJson: $stats,
            careerXml: '',
            vehiclesXml: '',
            economyXml: '',
        );

        $this->assertSame(2, $snapshot->modCount);
        $this->assertSame('FS25_AgravionConnector', $snapshot->mods[0]['name']);
        $this->assertSame('Agravion Connector', $snapshot->mods[0]['title']);
    }
}
