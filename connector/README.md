# Agravion FS25 Connector

Lua-Mod, der Snapshots unter `modSettings/FS25_AgravionConnector/` schreibt.  
Datenvertrag: [docs/CONNECTOR-CONTRACT.md](../docs/CONNECTOR-CONTRACT.md).

## Transport

- **Primär:** Dateien (`hello.xml`, `state/*`, `icons/*`) — Backend holt per FTP/SFTP.
- **HTTPS aus Lua:** nicht implementiert, optional später testen (Sandbox + Performance offen).

## Paket bauen

```powershell
cd connector
.\pack.ps1
```

Erzeugt:

- `dist/FS25_AgravionConnector.zip` (Dateien an der ZIP-Wurzel)
- Kopie nach `backend/resources/connector/` (für Agravion-Update + UI-Deploy)

Im Dashboard (Workspace → Connector → Paket): ZIP herunterladen **oder** per gespeichertem SFTP/FTPS/FTP in den `mods/`-Ordner des Spielservers legen.

1. Vor dem produktiven Deploy: `descVersion` in `modDesc.xml` aus der Spiel-`log.txt` setzen.
2. ZIP auf den Dedicated Server legen (UI-Deploy oder manuell) und in der Modliste aktivieren.
3. Probe: [PROBE.md](PROBE.md). Ping-Beispiel: `examples/command-ping.xml` → als `command.xml` nach `modSettings/FS25_AgravionConnector/` kopieren.

Im Mehrspieler lädt FS25 keine entpackten Ordner-Mods.

## v0 Leistungsumfang

| Datei | Inhalt |
| --- | --- |
| `hello.xml` | Version, Generation, Höfe (Name/Geld wenn lesbar) |
| `state/vehicles_full.xml` | Platzhalter-Full-Load (Iterator nach Server-Probe) |
| `state/icons_manifest.xml` | leeres Manifest zum GC-Vertrag |
| `command.xml` / `command_result.xml` | `ping` / `noop` |

Kein Geld, keine Secrets im Mod.
