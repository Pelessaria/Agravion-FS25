<?php

namespace Tests\Unit;

use App\Services\Fs25\ModHubCatalog;
use App\Services\Fs25\SavegameModList;
use PHPUnit\Framework\TestCase;

class ModHubCatalogTest extends TestCase
{
    public function test_version_compare_uses_the_four_part_game_version(): void
    {
        $this->assertTrue(ModHubCatalog::newer('1.5.0.0', '1.5.1.0'));
        $this->assertFalse(ModHubCatalog::newer('1.5.1.0', '1.5.1.0'));
        $this->assertFalse(ModHubCatalog::newer('1.6.0.0', '1.5.1.0'));
        $this->assertFalse(ModHubCatalog::newer('', '1.0.0.0'));
        $this->assertFalse(ModHubCatalog::newer('1.0.0.1', 'v1.0.0.1-rc2'));
        $this->assertTrue(ModHubCatalog::newer('1.0.0.0', 'v1.0.0.7'));
    }

    public function test_zip_url_must_be_the_file_linked_on_the_modhub_page(): void
    {
        $html = '<a href="https://cdn25.giants-software.com/modHub/storage/00318936/FS25_precisionFarming.zip">Download</a>';

        $this->assertSame(
            'https://cdn25.giants-software.com/modHub/storage/00318936/FS25_precisionFarming.zip',
            ModHubCatalog::zipUrl($html, 'FS25_precisionFarming.zip'),
        );
        $this->assertNull(ModHubCatalog::zipUrl($html, 'FS25_Other.zip'));
        $this->assertNull(ModHubCatalog::zipUrl(
            '<a href="https://example.test/FS25_precisionFarming.zip">Download</a>',
            'FS25_precisionFarming.zip',
        ));
    }

    public function test_career_mod_list_reads_modname_title_and_version(): void
    {
        $xml = <<<'XML'
        <careerSavegame>
          <mods>
            <mod modName="FS25_precisionFarming" title="Precision Farming" version="1.5.1.0" required="true" fileHash="abc"/>
            <mod modName="FS25_AutoDrive" title="AutoDrive" version="3.0.1.2"/>
          </mods>
        </careerSavegame>
        XML;

        $mods = SavegameModList::parse($xml);

        $this->assertCount(2, $mods);
        $this->assertSame('FS25_precisionFarming', $mods[0]['modName']);
        $this->assertSame('Precision Farming', $mods[0]['title']);
        $this->assertSame('1.5.1.0', $mods[0]['version']);
        $this->assertSame([], SavegameModList::parse('<careerSavegame/>'));
    }
}
