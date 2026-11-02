<?php

namespace Tests\Unit;

use App\Services\Fs25\ConnectorFieldsParser;
use PHPUnit\Framework\TestCase;

class ConnectorFieldsParserTest extends TestCase
{
    public function test_merges_geometry_and_state_without_inventing_missing_values(): void
    {
        $geometry = <<<'XML'
        <fieldsGeometry schema="1" mapSize="2048" writtenAtUtc="2026-11-02T18:00:00Z">
          <field id="2" cx="10.5" cz="-4" areaHa="1.25" points="0,0 10,0 10,8" />
          <field id="1" cx="1" cz="2" areaHa="3.5" points="1,2 4,2 4,6 1,6" />
        </fieldsGeometry>
        XML;

        $state = <<<'XML'
        <fieldsState schema="1" precisionFarming="1" writtenAtUtc="2026-11-02T18:01:00Z">
          <field id="1" farmId="1" farmlandId="9" owned="1" fruit="WHEAT" fruitTitle="Weizen &amp; Korn" fruitIcon="wheat" growth="4" growthMax="8" harvestMin="6" harvestMax="8" crop="growing" ground="7" weed="1" weedFactor="0.2" stones="0" spray="1" sprayType="1" lime="2" roller="0" plow="1" stubble="0" water="0" scanned="1" n="40" nTarget="80" ph="6.25" phTarget="6.75" soil="3" />
          <field id="3" owned="0" crop="noCrop" />
        </fieldsState>
        XML;

        $merged = ConnectorFieldsParser::merge($geometry, $state);

        $this->assertSame(2048, $merged['mapSize']);
        $this->assertNull($merged['mapFrame']);
        $this->assertTrue($merged['precisionFarming']);
        $this->assertSame('2026-11-02T18:00:00Z', $merged['geometryAt']);
        $this->assertCount(3, $merged['fields']);
        $this->assertSame(1, $merged['fields'][0]['id']);
        $this->assertSame('Weizen & Korn', $merged['fields'][0]['fruitTitle']);
        $this->assertSame('wheat', $merged['fields'][0]['fruitIcon']);
        $this->assertSame(40.0, $merged['fields'][0]['nitrogen']);
        $this->assertSame(6.75, $merged['fields'][0]['phTarget']);
        $this->assertTrue($merged['fields'][0]['owned']);
        $this->assertTrue($merged['fields'][0]['scanned']);
        $this->assertCount(4, $merged['fields'][0]['points']);
        $this->assertSame([1.0, 2.0], $merged['fields'][0]['points'][0]);
        $this->assertNull($merged['fields'][1]['fruitName']);
        $this->assertNull($merged['fields'][1]['nitrogen']);
        $this->assertSame(3, $merged['fields'][2]['id']);
        $this->assertSame([], $merged['fields'][2]['points']);
        $this->assertFalse($merged['fields'][2]['owned']);
        $this->assertNull($merged['fields'][2]['scanned']);
    }

    public function test_map_frame_is_read_when_the_connector_reports_the_pda_placement(): void
    {
        $geometry = <<<'XML'
        <fieldsGeometry schema="1" mapSize="4096" mapWorldX="4096.0" mapWorldZ="4096.0" mapOriginX="2048.0" mapOriginZ="2048.0" mapScaleX="0.8340" mapScaleZ="0.8420" mapPadX="0.0820" mapPadZ="0.0800" writtenAtUtc="2026-11-02T18:00:00Z">
          <field id="1" cx="0" cz="0" points="0,0 1,0 1,1" />
        </fieldsGeometry>
        XML;

        $merged = ConnectorFieldsParser::merge($geometry, '');

        $this->assertEqualsWithDelta(0.834, $merged['mapFrame']['scaleX'], 0.0001);
        $this->assertEqualsWithDelta(0.08, $merged['mapFrame']['padZ'], 0.0001);
        $this->assertEqualsWithDelta(2048.0, $merged['mapFrame']['originX'], 0.0001);
    }

    public function test_fruit_manifest_rejects_paths_outside_the_fruit_folder(): void
    {
        $xml = <<<'XML'
        <fruitsManifest>
          <fruit key="WHEAT" iconFile="icons/fruits/wheat.dds" />
          <fruit key="bad" iconFile="../vehicles_full.xml" />
          <fruit key="nope" iconFile="icons/store/other.dds" />
        </fruitsManifest>
        XML;

        $icons = ConnectorFieldsParser::fruitIcons($xml);
        $this->assertCount(1, $icons);
        $this->assertSame('wheat', $icons[0]['key']);
        $this->assertSame('icons/fruits/wheat.dds', $icons[0]['iconFile']);
    }
}
