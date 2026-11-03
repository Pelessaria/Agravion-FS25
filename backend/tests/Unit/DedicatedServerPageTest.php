<?php

namespace Tests\Unit;

use App\Services\Fs25\DedicatedServerConsole;
use App\Services\Fs25\DedicatedServerPage;
use PHPUnit\Framework\TestCase;

class DedicatedServerPageTest extends TestCase
{
    public function test_reads_only_buttons_and_fields_that_are_on_the_page(): void
    {
        $html = <<<'HTML'
        <html><body>
          <form method="post" action="index.html">
            <input type="hidden" name="token" value="abc">
            <input type="submit" name="start_server" value="Server starten">
            <input type="submit" name="stop_server" value="Server stoppen">
          </form>
          <a href="mods.html">Mods</a>
          <a href="log.html?file=log.txt">Log</a>
          <a href="https://example.test/elsewhere">Weg</a>
        </body></html>
        HTML;

        $page = DedicatedServerPage::parse($html, 'http://games.example/index.html');

        $this->assertFalse($page['loginForm']);
        $this->assertSame(['start', 'stop'], array_column($page['actions'], 'id'));
        $this->assertSame('start_server', $page['actions'][0]['buttonName']);
        $this->assertSame('abc', $page['actions'][0]['fields'][0]['value']);
        $this->assertCount(3, $page['links']);
        $this->assertSame('Log', $page['logLinks'][0]['text']);
    }

    public function test_login_page_is_not_treated_as_a_running_console(): void
    {
        $html = <<<'HTML'
        <form method="post" action="index.html">
          <input name="username">
          <input type="password" name="password">
          <input type="submit" name="login" value="Login">
        </form>
        HTML;

        $page = DedicatedServerPage::parse($html, 'http://games.example/index.html');

        $this->assertTrue($page['loginForm']);
        $this->assertSame([], $page['actions']);
    }

    public function test_mods_and_settings_keep_real_controls_and_drop_passwords(): void
    {
        $html = <<<'HTML'
        <html><body>
          <h2>Aktive Mods</h2>
          <form method="post" action="mods.html">
            <table>
              <tr>
                <td>FS25_Example.zip</td>
                <td><input type="checkbox" name="mod_1" value="1" checked></td>
                <td><a href="download/FS25_Example.zip">Download</a></td>
              </tr>
            </table>
            <input type="file" name="modfile">
            <input type="submit" name="save_mods" value="Speichern">
          </form>
          <form method="post" action="settings.html">
            <label>Schwierigkeit
              <select name="difficulty">
                <option value="1">Leicht</option>
                <option value="2" selected>Schwer</option>
              </select>
            </label>
            <input type="checkbox" name="weeds" value="1" checked>
            <input type="password" name="adminpass" value="secret">
            <input type="submit" name="save_settings" value="Speichern">
          </form>
        </body></html>
        HTML;

        $page = DedicatedServerPage::parse($html, 'http://games.example/index.html');

        $this->assertSame('FS25_Example.zip', $page['modRows'][0]['name']);
        $this->assertTrue($page['modRows'][0]['active']);
        $this->assertSame('modfile', $page['modForm']['file']);
        $this->assertSame('save_mods', $page['modForm']['save']['name']);
        $names = array_column($page['settingsForm']['fields'], 'name');
        $this->assertContains('difficulty', $names);
        $this->assertContains('weeds', $names);
        $this->assertNotContains('adminpass', $names);
        $difficulty = null;
        foreach ($page['settingsForm']['fields'] as $field) {
            if ($field['name'] === 'difficulty') {
                $difficulty = $field;
            }
        }
        $this->assertNotNull($difficulty);
        $this->assertSame('2', $difficulty['value']);
        $this->assertSame('Speichern', $page['settingsForm']['save']['value']);
    }

    public function test_named_controls_status_and_inline_log_come_from_the_page(): void
    {
        $html = <<<'HTML'
        <html><body>
          <div class="status-indicator online"><span>ONLINE</span></div>
          <form action="index.html?lang=en" method="post">
            <input type="submit" name="stop_server" value="Stop">
            <input type="submit" name="restart_server" value="Restart">
          </form>
          <div id="log_textarea">GIANTS Engine Runtime</div>
          <form action="logs.html?lang=en" method="post">
            <select name="log_type"><option value="3" selected>Game</option></select>
            <select name="log_file"></select>
            <input type="submit" name="delete_log" value="Delete">
            <input type="submit" name="show_log" value="Select">
          </form>
        </body></html>
        HTML;

        $page = DedicatedServerPage::parse($html, 'http://games.example/index.html');

        $this->assertSame(['stop', 'restart'], array_column($page['actions'], 'id'));
        $this->assertTrue($page['running']);
        $this->assertSame('GIANTS Engine Runtime', $page['logText']);
        $this->assertNull($page['settingsForm']);
        $this->assertSame(
            'http://games.example:8081',
            DedicatedServerConsole::origin('http://games.example:8081/index.html'),
        );
    }

    public function test_mod_cards_keep_name_version_author_and_size_and_ignore_the_inactive_class(): void
    {
        $html = <<<'HTML'
        <html><body>
          <h2>Active Mods</h2>
          <div class="container-row grid-row modSelection-inactive" id="FS25_Example.zip">
            <div class="container-row col col-md-4">
              <div class="col col-md-hidden">Name</div>
              <div class="col">Example Tractor</div>
            </div>
            <div class="container-row col col-md-hidden-toggle">
              <div class="col col-md-hidden">Version</div>
              <div class="col">1.2.0.0</div>
            </div>
            <div class="container-row col">
              <div class="col col-md-hidden">Author</div>
              <div class="col">Farming Dud's</div>
            </div>
            <div class="container-row col">
              <div class="col col-md-hidden">Filename</div>
              <div class="col">FS25_Example.zip</div>
            </div>
            <div class="container-row col">
              <div class="col col-md-hidden">Size</div>
              <div class="col">12.50 MB</div>
            </div>
          </div>
          <h2>Activate Mods</h2>
          <div id="FS25_Other.zip">
            <div class="col col-md-hidden">Name</div>
            <div class="col">Other</div>
          </div>
          <a href="savegame2">Download</a>
        </body></html>
        HTML;

        $page = DedicatedServerPage::parse($html, 'http://games.example/index.html');

        $this->assertCount(2, $page['modCards']);
        $this->assertSame('FS25_Example.zip', $page['modCards'][0]['name']);
        $this->assertSame('Example Tractor', $page['modCards'][0]['title']);
        $this->assertSame('1.2.0.0', $page['modCards'][0]['version']);
        $this->assertSame("Farming Dud's", $page['modCards'][0]['author']);
        $this->assertSame(13107200, $page['modCards'][0]['bytes']);
        $this->assertTrue($page['modCards'][0]['active']);
        $this->assertNull($page['modCards'][1]['active']);
        $this->assertSame(['savegame2'], $page['savegameDownloads']);
    }

    public function test_mod_toggles_come_from_the_active_and_inactive_forms(): void
    {
        $html = <<<'HTML'
        <html><body>
          <form action="index.html?lang=en#mods" method="post" name="ActiveMods">
            <div title="This mod cannot be deactivated because active mods depend on it: FS25_Map.zip">
              <input type="checkbox" disabled class="modSelection" name="moddeactivate_FS25_Needed.zip">
            </div>
            <input type="checkbox" class="modSelection" name="moddeactivate_FS25_Free.zip">
            <input type="submit" name="deactivate_mods" value="Deactivate">
          </form>
          <form action="index.html?lang=en#mods" method="post" name="InactiveMods">
            <input type="checkbox" class="modSelection" name="modactivate_FS25_Parked.zip">
            <input type="submit" name="activate_mods" value="Activate">
          </form>
        </body></html>
        HTML;

        $page = DedicatedServerPage::parse($html, 'http://games.example/index.html');
        $byName = [];
        foreach ($page['modToggles'] as $toggle) {
            $byName[$toggle['name']] = $toggle;
        }

        $this->assertTrue($byName['FS25_Needed.zip']['active']);
        $this->assertTrue($byName['FS25_Needed.zip']['disabled']);
        $this->assertStringContainsString('FS25_Map.zip', $byName['FS25_Needed.zip']['reason']);
        $this->assertSame('deactivate_mods', $byName['FS25_Needed.zip']['submitName']);
        $this->assertFalse($byName['FS25_Free.zip']['disabled']);
        $this->assertFalse($byName['FS25_Parked.zip']['active']);
        $this->assertSame('activate_mods', $byName['FS25_Parked.zip']['submitName']);
        $this->assertSame('Activate', $byName['FS25_Parked.zip']['submitValue']);
    }

    public function test_setting_labels_come_from_the_column_beside_the_field(): void
    {
        $html = <<<'HTML'
        <html><body>
          <form name="configuration" method="post" action="index.html">
            <div class="row column">
              <div class="medium-3 columns column-label">Game</div>
              <div class="medium-9 columns">Farming Simulator 25</div>
            </div>
            <div class="row column">
              <div class="medium-3 columns column-label">Server Game Name</div>
              <div class="medium-9 columns"><input type="text" name="game_name" value="Farm"></div>
            </div>
            <div class="row column">
              <div class="medium-3 columns column-label">Port</div>
              <div class="medium-9 columns"><input type="text" name="server_port" value="10823"></div>
            </div>
            <input type="submit" name="save_settings" value="Save">
          </form>
        </body></html>
        HTML;

        $page = DedicatedServerPage::parse($html, 'http://games.example/index.html');
        $labels = [];
        foreach ($page['settingsForm']['fields'] as $field) {
            $labels[$field['name']] = $field['label'];
        }

        $this->assertSame('Server Game Name', $labels['game_name']);
        $this->assertSame('Port', $labels['server_port']);
        $this->assertSame('Farm', $page['settingsForm']['fields'][0]['value']);
    }
}
