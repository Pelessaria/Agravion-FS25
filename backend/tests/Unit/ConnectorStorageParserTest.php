<?php

namespace Tests\Unit;

use App\Services\Fs25\ConnectorStorageParser;
use PHPUnit\Framework\TestCase;

class ConnectorStorageParserTest extends TestCase
{
    public function test_groups_fills_under_their_place_and_keeps_missing_numbers_null(): void
    {
        $xml = <<<'XML'
        <?xml version="1.0" encoding="utf-8"?>
        <storageState schema="1" writtenAtUtc="2026-11-04T12:00:00Z">
          <bin id="silo:1" kind="silo" farmId="2" name="Hof &amp; Silo" level="1500" capacity="800000" />
          <fill bin="silo:1" fillType="WHEAT" title="Weizen" level="1500" capacity="800000" />
          <bin id="bale:1" kind="baleStorage" farmId="2" name="Ballenlager" level="4800" used="4" slots="20" />
          <fill bin="bale:1" fillType="STRAW" title="Stroh" level="4800" count="4" />
          <bin id="silo:2" kind="siloExtension" farmId="0" name="Leer" />
          <fill bin="missing" fillType="OAT" level="1" />
        </storageState>
        XML;

        $parsed = ConnectorStorageParser::parse($xml);

        $this->assertSame('2026-11-04T12:00:00Z', $parsed['writtenAt']);
        $this->assertCount(3, $parsed['places']);
        $this->assertSame('Hof & Silo', $parsed['places'][0]['name']);
        $this->assertSame(2, $parsed['places'][0]['farmId']);
        $this->assertFalse($parsed['places'][0]['foreign']);
        $this->assertSame(1500.0, $parsed['places'][0]['level']);
        $this->assertSame('WHEAT', $parsed['places'][0]['fills'][0]['fillType']);
        $this->assertNull($parsed['places'][0]['fills'][0]['count']);
        $this->assertSame(4.0, $parsed['places'][1]['fills'][0]['count']);
        $this->assertSame(20.0, $parsed['places'][1]['slots']);
        $this->assertNull($parsed['places'][2]['farmId']);
        $this->assertNull($parsed['places'][2]['level']);
        $this->assertSame([], $parsed['places'][2]['fills']);
    }
}
