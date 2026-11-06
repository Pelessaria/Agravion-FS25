# Connector-Probe auf dem Dedicated Server

Kurzprotokoll. Keine Secrets in dieses Repo schreiben.

## Vorbereitung

1. `descVersion` in `FS25_AgravionConnector/modDesc.xml` aus der Spiel-`log.txt` setzen.
2. `.\pack.ps1` ausführen → `dist/FS25_AgravionConnector.zip`
3. ZIP auf den Server legen, in der Modliste aktivieren, Server starten.

## Checks

| # | Prüfung | OK? |
| --- | --- | --- |
| 1 | Server startet mit aktivem Mod (kein Crash in `log.txt`) | |
| 2 | Ordner `modSettings/FS25_AgravionConnector/` existiert (FTP/SFTP) | |
| 3 | `hello.xml` erscheint und enthält `version`, `generation`, ggf. `<farm …>` | |
| 4 | `state/vehicles_full.xml` und `state/icons_manifest.xml` existieren | |
| 5 | `examples/command-ping.xml` als `command.xml` ablegen → `command_result.xml` mit `status="ok"` | |
| 6 | Server-Neustart: alter `ping` wird nicht doppelt ausgeführt (ID bereits gesehen) | |
| 7 | Pfad `modSettings` und Savegame-Ordner für Agravion notieren | |

## Ergebnis notieren

- `descVersion`: …
- Hoster / Pfad `modSettings`: …
- Hof-IDs aus `hello.xml`: …
- Auffälligkeiten: …
