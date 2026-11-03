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
        </body></html>
        HTML;

        $page = DedicatedServerPage::parse($html, 'http://games.example/index.html');

        $this->assertSame(['stop', 'restart'], array_column($page['actions'], 'id'));
        $this->assertTrue($page['running']);
        $this->assertSame('GIANTS Engine Runtime', $page['logText']);
        $this->assertSame(
            'http://games.example:8081',
            DedicatedServerConsole::origin('http://games.example:8081/index.html'),
        );
    }
}
