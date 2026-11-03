<?php

namespace Tests\Unit;

use App\Services\Fs25\SavegameUsage;
use App\Services\Fs25\ZipModDescReader;
use PHPUnit\Framework\TestCase;
use ZipArchive;

class SavegameUsageTest extends TestCase
{
    public function test_only_player_farms_count_as_owning_a_mod(): void
    {
        $farms = <<<'XML'
        <farms>
          <farm farmId="1" name="Eekenwarft"><players><player uniqueUserId="a"/></players></farm>
          <farm farmId="2" name="Landhandel"><statistics/></farm>
          <farm farmId="3" name="Friesenmilch"><players><player uniqueUserId="b"/></players></farm>
        </farms>
        XML;
        $vehicles = <<<'XML'
        <vehicles>
          <vehicle modName="FS25_StrautmannAperion2401" filename="$moddir$FS25_StrautmannAperion2401/aperion2401.xml" farmId="2" propertyState="OWNED"/>
          <vehicle filename="$moddir$FS25_OwnedPack/tractor.xml" farmId="1" propertyState="OWNED"/>
          <vehicle modName="FS25_Traffic" filename="$moddir$FS25_Traffic/car.xml" farmId="1" propertyState="NONE"/>
          <vehicle filename="data/vehicles/johnDeere/series6R/series6R.xml" farmId="1" propertyState="OWNED"/>
        </vehicles>
        XML;
        $placeables = <<<'XML'
        <placeables>
          <placeable filename="$moddir$FS25_Shed/shed.xml" farmId="1"/>
          <placeable modName="FS25_MapDecor" filename="$moddir$FS25_MapDecor/house.xml" farmId="0"/>
          <placeable filename="$moddir$FS25_SecondFarmBarn/barn.xml" farmId="3"/>
        </placeables>
        XML;

        $players = SavegameUsage::playerFarmIds($farms);
        $this->assertSame([1, 3], $players);

        $owned = SavegameUsage::ownedModStems($vehicles, $players) + SavegameUsage::ownedModStems($placeables, $players);
        $this->assertArrayHasKey('fs25_ownedpack', $owned);
        $this->assertArrayHasKey('fs25_shed', $owned);
        $this->assertArrayHasKey('fs25_secondfarmbarn', $owned);
        $this->assertArrayNotHasKey('fs25_strautmannaperion2401', $owned);
        $this->assertArrayNotHasKey('fs25_traffic', $owned);
        $this->assertArrayNotHasKey('fs25_mapdecor', $owned);
    }

    public function test_map_stem_and_dependencies_come_from_the_map_mod(): void
    {
        $career = '<careerSavegame mapId="FS25_SchwesingBahnhof.Schwesing_Bahnhof" mapTitle="Schwesing Bahnhof"/>';
        $installed = ['fs25_schwesingbahnhof' => 'FS25_SchwesingBahnhof'];
        $this->assertSame('FS25_SchwesingBahnhof', SavegameUsage::mapStem($career, $installed));

        $desc = <<<'XML'
        <modDesc>
          <dependencies>
            <dependency>FS25_AddableTriggers</dependency>
            <dependency> </dependency>
          </dependencies>
          <storeItems><storeItem xmlFilename="shed.xml"/></storeItems>
        </modDesc>
        XML;
        $this->assertSame(['FS25_AddableTriggers'], SavegameUsage::dependencies($desc));
        $this->assertTrue(SavegameUsage::hasStoreItems($desc));
        $this->assertFalse(SavegameUsage::hasStoreItems('<modDesc><description>script</description></modDesc>'));
    }

    public function test_moddesc_is_read_from_the_zip_without_the_rest_of_the_archive(): void
    {
        if (! class_exists(ZipArchive::class)) {
            $this->markTestSkipped('ZipArchive is not available.');
        }
        $tmp = tempnam(sys_get_temp_dir(), 'avzip');
        $this->assertNotFalse($tmp);
        @unlink($tmp);
        $zip = new ZipArchive();
        $this->assertTrue($zip->open($tmp, ZipArchive::CREATE) === true);
        $xml = '<modDesc><dependencies><dependency>FS25_Needed</dependency></dependencies></modDesc>';
        $zip->addFromString('nested/modDesc.xml', '<modDesc><dependencies><dependency>FS25_TooDeep</dependency></dependencies></modDesc>');
        $zip->addFromString('modDesc.xml', $xml);
        $zip->addFromString('other/big.dat', str_repeat('x', 20000));
        $zip->close();
        $bytes = (string) file_get_contents($tmp);
        @unlink($tmp);

        $read = ZipModDescReader::xml(strlen($bytes), static function (int $offset, int $length) use ($bytes): string {
            return substr($bytes, $offset, $length);
        });

        $this->assertIsString($read);
        $this->assertSame(['FS25_Needed'], SavegameUsage::dependencies($read));
    }
}
