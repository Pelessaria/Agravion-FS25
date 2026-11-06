# Connector-Datenvertrag

**Status:** Arbeitsvertrag für Mod + Backend. Noch keine Laufzeit-Implementierung im Dashboard.  
**Stand:** 14. Oktober 2026  
**Transport-Primärweg:** Dateien unter `modSettings/FS25_AgravionConnector/` (vom Backend per Dateizugang geholt).  
**HTTPS aus Lua:** optionaler Probe-Pfad, kein Pflichttransport (Performance und Sandbox offen).

## 1. Ordnerlayout im Spielprofil

```text
modSettings/FS25_AgravionConnector/
  hello.xml                 # v0: Lebenszeichen + Höfe
  state/vehicles_full.xml   # voller Fahrzeugbestand (Initial / nach Save-Reload)
  state/vehicles_delta.xml  # optionale Positions-/Fill-Deltas
  state/icons_manifest.xml  # Store-Icons der Fahrzeuge im Save (kind=store)
  icons/store/<storeKey>.*  # Fahrzeug-StoreIcons (DDS/PNG; Backend → PNG)
  icons/mods/<modKey>.*     # später: Mod-Pack-Icons (nicht für Fahrzeugliste)
  command.xml               # Aufträge vom Backend
  command_result.xml        # Antworten des Mods
```

Atomar schreiben wo möglich: `*.tmp` → Zielname, sonst `generation`-Attribut erhöhen.

## 2. Sync-Regeln

| Ereignis | Aktion |
| --- | --- |
| Dedicated Server start / Connector geladen | `hello.xml`, Full-Load Fahrzeuge, Icon-Scan gegen aktive Modliste |
| Periodischer Takt (mehrere Sekunden, nicht pro Frame) | `hello` aktualisieren; Fahrzeug-Delta wenn Full-Load frisch ist |
| Savegame geladen / Reload erkannt | erneut Full-Load Fahrzeuge |
| Modliste geändert (Hash/Name) | Icon-Scan; Icons ohne Treffer in aktueller Liste löschen |
| Backend-Sync | Feed (Web-API) + Dateien aus diesem Ordner zusammenführen |

**Fahrzeuge:** Initial und nach Reload = Full-Load. Laufend = Delta (Position, Fill, operatingTime, Zu-/Abgang).  
**Icons:** Nur bei Start und Modlisten-Änderung, nicht bei jedem Fahrzeug-Poll.

## 3. Schlüssel

| Schlüssel | Bedeutung |
| --- | --- |
| `gameFarmId` | Hof-ID im Savegame (1…n), Workspace-lokal |
| `vehicleUniqueId` | Savegame-`uniqueId` |
| `storeKey` | stabiler Schlüssel fürs Fahrzeug-StoreIcon (normalisierter Config-Pfad) |
| `modKey` | Mod-Pack-Schlüssel (später Modliste); nicht für Fahrzeug-Übersicht |
| `filename` | Fahrzeug-`filename` aus Savegame (für Typ/Icon-Zuordnung) |

Fehlende optionale Felder = Dashboard zeigt „nicht verfügbar“, nie erfundene Werte.

## 4. Dateien (v0 / v0.1)

### 4.1 `hello.xml`

```xml
<agravionConnector version="0.1.0" schema="1" generation="1" writtenAtUtc="2026-10-14T10:00:00Z" gameTimeMs="0">
  <farms>
    <farm id="1" name="Hof 1" money="1245000" />
    <farm id="2" name="Hof 2" />
  </farms>
</agravionConnector>
```

- `money` nur setzen, wenn der Mod eine Zahl lesen konnte (0 ist gültig).
- Ohne `name`/`money`: Attribut weglassen.

### 4.2 `state/vehicles_full.xml`

```xml
<vehiclesFull schema="1" generation="1" writtenAtUtc="…" kind="full">
  <vehicle
    uniqueId="…"
    filename="…"
    farmId="1"
    name="…"
    category="tractor"
    operatingTime="312.5"
    storeKey="data_vehicles_fendt_vario900_vario900"
    modKey="FS25_SomeMod"
    x="1" y="2" z="3"
  />
</vehiclesFull>
```

`storeKey` verknüpft mit Store-Icon-Datei. `modKey` optional für spätere Modliste. Position optional, wenn nur Savegame-Meta vorliegt (Feed kann Position später mergen).

### 4.3 `state/icons_manifest.xml`

```xml
<iconsManifest schema="1" generation="1" writtenAtUtc="…" scan="vehicles" kind="store">
  <store key="data_vehicles_fendt_vario900_vario900" filename="data/vehicles/…" iconFile="icons/store/….dds" />
</iconsManifest>
```

Backend: Manifest ist Quelle der Wahrheit für Store-Icons. Cron aktualisiert den lokalen Cache unter `storage/app/connector/<workspace>/` (State-XML + Icons). Page-Loads öffnen kein FTP. DDS→PNG: DXT1/3/5 in PHP, **BC7 (DXGI 98/99)** über `bin/dds2rgba` (siehe [INSTALLATION.md](INSTALLATION.md)). Diagnose: `php artisan agravion:icon-status`, Statusdatei `icons/.status.json`.

### 4.4 `command.xml` / `command_result.xml` (v0)

Nur `noop` und `ping`. Jeder Befehl hat `id` (UUID). Bereits beantwortete IDs nicht erneut ausführen.

## 5. Zusammenführung mit dem Web-API-Feed

| Quelle | Liefert |
| --- | --- |
| Feed Stats | Online, Spieler, Map, Kartenbild, Live-Positionen, Modliste (für Icon-Scan-Trigger) |
| Feed Savegame `vehicles` | `uniqueId`, `farmId`, `operatingTime`, `filename` |
| Feed `economy` | Periodenpreise |
| Connector `hello` | Hofname, Hofgeld |
| Connector Full/Delta | angereicherte Fahrzeuge + `modKey` |
| Connector Icons | Bilddateien für UI |

Merge-Schlüssel Fahrzeug: `uniqueId` innerhalb des Workspace. Position bevorzugt aus dem frischeren Feed-Stats-Snapshot, Meta aus Savegame/Connector.

## 6. HTTPS aus Lua

Nicht Pflicht. Primärweg bleibt Datei + Backend-Pull.

Falls ein Hoster/Engine-Weg ausgehendes HTTPS erlaubt: nur als **zusätzlicher** Transport für kleine Payloads (`hello`, Manifest-Meta), nicht für Massen-Icons in jedem Tick. Icons weiter dateibasiert oder einmalig. Performance-Probe getrennt dokumentieren, bevor es Produktversprechen wird.

## 7. Versionierung

- `schema`-Attribut an jeder Datei.
- Backend akzeptiert bekannte Schemas, unbekannte → Sync-Warnung, kein Crash.
- Mod-Version in `hello` / `modDesc`.
