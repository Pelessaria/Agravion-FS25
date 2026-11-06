# FS25-Integration

**Status:** Recherche vor der Implementierung. Kein Mod, kein Test auf einem Dedicated Server.  
**Stand:** 12. Oktober 2026

Es werden keine Lua-Klassen, Events oder Provider-APIs erfunden. Was hier als Funktion genannt wird, stammt aus öffentlich einsehbarem Mod-Quelltext oder aus Herstellermaterial. Das ist ein Beleg, dass die Funktion in diesen Projekten vorkommt, kein Vertrag von GIANTS und kein Test dieser Plattform.

Offizielle Scripting-Dokumentation: [GDN LUADOC FS25](https://gdn.giants-software.com/documentation_scripting_fs25.php). Eine durchsuchbare Community-Fassung liegt unter [FS25 Community LUADOC](https://umbraprior.github.io/FS25-Community-LUADOC/). Vor der Mod-Implementierung werden die genannten Signaturen dort und in `log.txt` der installierten Spielversion gegengeprüft.

## 0. Probe der Dedicated-Server-Web-API

**Fakt, 12. Oktober 2026, ein dafür freigegebener Testserver.** Abgefragt wurde nur lesend. Spiel, Savegame und Mods wurden nicht verändert. Adresse, Feed-Code und Web-Passwort stehen nicht in diesem Repository.

Der Server meldete `GIANTS Dedicated Server/10.0.0.0` und das Spiel `Farming Simulator 25` in Version `1.24.0.0`. Der Feed setzt `Access-Control-Allow-Origin: *`. Der Code gehört deshalb ins Backend, nicht in den Browser.

### 0.1 Was der Feed geliefert hat

| Aufruf | Ergebnis auf diesem Server |
| --- | --- |
| `GET /feed/dedicated-server-stats.xml?code=…` | HTTP 200, XML |
| `GET /feed/dedicated-server-stats.json?code=…` | HTTP 200, JSON, ohne Farmlands |
| `GET /feed/dedicated-server-stats-map.jpg?code=…&quality=60&size=512` | HTTP 200, JPEG |
| `GET /feed/dedicated-server-savegame.html?code=…&file=careerSavegame` | HTTP 200, XML |
| derselbe Pfad, `file=vehicles` | HTTP 200, XML |
| derselbe Pfad, `file=economy` | HTTP 200, XML |
| dieselben Pfade für `farms`, `fields`, `environment`, `placeables`, `items`, `handtools`, `players` | HTTP 204, leerer Body |

Die drei Savegame-Dateien entsprechen der öffentlichen Beschreibung der Web-API bei [Farm Sim Game, Dedicated Servers](https://www.farmsimgame.com/Docs/Farming-Simulator-25/Dedicated-Servers/): Link XML, Kartenbild, Savegame-Dateien. Dieselbe Quelle bezeichnet die Web-API als nur lesend. Auf Mietservern sei sie standardmäßig an und nicht abschaltbar. Das ist eine Drittquelle, kein Giants-Vertrag, und für GPORTAL oder Nitrado hier nicht nachgestellt.

Basis-URL und Code sind je Server verschieden. Der Workspace speichert die konkrete URL.

### 0.2 Inhalt, den wir verwenden können

Stats-Feed, auf diesem Server gezählt: 10 Spielerslots, 0 belegt, 212 Mods, 255 Farmlands, 229 Fields, 226 Vehicles. `mapSize` war `4096`.

| Daten | Vorhanden | Grenze |
| --- | --- | --- |
| Servername, Spiel, Version, Mapname, `mapSize`, Overview-Dateiname | ja | Servernamen können XML-Entities doppelt enthalten. Anzeige als Text, nicht als HTML |
| `dayTime` | ja, eine ganze Zahl | Übliche Deutung ist Millisekunden seit Mitternacht. Die Einheit steht nicht im Feed und bleibt bis zum Abgleich mit der Spieluhr eine Annahme |
| Spielerplätze | `capacity`, `numUsed`, je Slot `isUsed` | In diesem leeren Snapshot kein Name, kein Admin-Flag, keine Spielzeit. Weitere Felder bei belegtem Slot sind noch nicht gesehen |
| Mods | Name, Autor, Version, Hash, Titel | das ist die aktive Modliste des Feeds, kein Beweis, dass unser Connector geladen ist |
| Farmlands, nur XML | `id`, `name`, `owner`, `area`, `price`, `x`, `z` | `owner` ist die Hof-ID. Der Punkt ist ein Anker, kein Polygon |
| Fields | `id`, `isOwned`, `x`, `z` | kein Hof, keine Frucht, kein Wachstum, keine Feldform. `isOwned` ist ein Ja/Nein |
| Fahrzeuge im Stats-Feed | `name`, `category`, `type`, `x`, `y`, `z` | kein `farmId`, keine Ausrichtung, keine Betriebsstunden. JSON ergänzt bei einem Teil `fills` mit `type` und `level`, darunter auch `UNKNOWN` |
| Kartenbild | JPEG, Parameter `quality` und `size` wirken | die PDA-Übersicht. Weltkoordinaten liegen bei dieser Map grob in ±`mapSize`/2. Die Pixel-Formel wird erst benutzt, wenn ein bekannter Punkt auf dem Bild sitzt |
| `careerSavegame` | Spielstandname, Map-ID, Schwierigkeit, Speicherdatum, `timeScale`, Modliste, `statistics/money`, `statistics/playTime` | ein Geldbetrag, nicht je Hof. `playTime` hat keine Einheit im XML |
| `vehicles` im Savegame-Feed | `uniqueId`, `filename`, `farmId`, `age`, `price`, `propertyState`, `operatingTime` | das ist die Speicherdatei, nicht zwingend die Position aus dem Stats-Feed. Auf diesem Server 230 Fahrzeuge in der Datei und 226 im Stats-Feed |
| `economy` | je Fill-Type eine Periode-Historie und oft `totalAmount`, plus `greatDemand` | globale Periodenpreise, keine Preise je Verkaufsstelle |

`server.money` im JSON war `0`, während `statistics/money` im Career-XML eine siebenstellige Zahl war. `server.money` wird nicht als Kontostand angezeigt.

Hof-IDs aus `vehicles.xml` auf diesem Server: 1, 2, 3, 5 und 6. Namen und Kontostände dieser Höfe kamen im Feed nicht vor. `farms.xml` gehört nicht zur freigegebenen Dateiliste.

### 0.3 Web-Oberfläche mit Benutzername

Die Giants-Weboberfläche auf demselben Port ist ein anderes Tor. Sie kann laut Oberfläche und Community-Routen Server starten, stoppen und neu starten sowie Mods und Savegames verwalten. Zwei POST-Versuche auf das Login-Formular, Benutzername `Pelle-Test`, Deutsch und Englisch, antworteten mit „Benutzername oder Passwort falsch“ beziehungsweise „Username or password incorrect“. Es entstand keine Sitzung. Die beiden übergebenen Passwörter stehen nicht in diesem Repository. Start, Stop und Neustart wurden nicht aufgerufen.

Dieser Login ist damit auf diesem Server nicht belegt. Er ist auch nicht der Datenweg. Routine-Sync nutzt den Feed-Code. Ein später funktionierender Web-Benutzer bleibt eine privilegierte Wartungsaktion hinter `workspace_admin` und einer Bestätigung.

### 0.4 Folge für den Connector

Der erste echte Leseweg braucht keinen Lua-Mod:

1. Backend holt Stats-XML, Kartenbild und die drei Savegame-Dateien.
2. Control Center zeigt Erreichbarkeit, Spielerzahl, Map, Spielversion und Mod-Anzahl.
3. Workspace zeigt Fahrzeugpositionen, Fill-Levels wo vorhanden, Farmland-Anker mit Hof-ID, Feld-Anker mit Besitz-Flag und Periodenpreise.
4. Fehlende Hofkonten, Feldformen, Frucht, Tiere, Lager und Verkaufsstellenpreise bleiben „nicht verfügbar“.

`modSettings` bleibt der Kanal für den Mod. Nach Angabe des Betreibers geben die meisten Hoster den FS-Ordner unter My Games per FTP frei, mindestens Mods, Savegames und `modSettings`. Der konkrete Pfad wird je Workspace geprüft, weil er sich unterscheidet. Darüber können später `farms.xml` und die Mod-Dateien gelesen werden, ohne die Web-API um nicht freigegebene Dateinamen zu erweitern.

## 1. Belegte technische Fakten

### 1.1 Mod-Paket

- Ein FS25-Mod ist in Multiplayer ein ZIP. Entpackte Ordner lädt das Spiel im Mehrspielerbetrieb nicht. Belegt durch die Installationsanweisung von [FS25 Farmhand](https://github.com/getflowkits/fs25-farmhand-mod): „FS25 refuses to load folder mods in multiplayer.“
- `modDesc.xml` liegt an der Wurzel des Archivs. `descVersion` ist die Schema-Version des Spiels, nicht die Mod-Version.
- Die gültige `descVersion` wird aus dem Spiel gelesen: Giants-Forum, Hinweis auf `log.txt` und auf `shared/xml/documentation/modDesc.html` in der Spielinstallation ([Forenthread](https://forum.giants-software.com/viewtopic.php?p=1652919)). Community-Seiten nennen unterschiedliche Zahlen. **Die Zahl wird nicht in diese Planung geschrieben und nicht geraten.**

### 1.2 Dateien im Spielprofil

Courseplay für FS25 legt sein Verzeichnis so an ([Courseplay.lua](https://github.com/Courseplay/Courseplay_FS25/blob/main/Courseplay.lua)):

```lua
self.baseDir = getUserProfileAppPath() .. "modSettings/" .. Courseplay.MOD_NAME .. "/"
createFolder(self.baseDir)
```

Farmhand schreibt nach `modSettings/FS25_Farmhand/` und liest Auftragsdateien über die XML-API der Engine, nicht mit `io.open` im Lesemodus ([Farmhand README](https://github.com/getflowkits/fs25-farmhand-mod)).

**Fakt:** `getUserProfileAppPath()`, `createFolder()` und ein Ordner `modSettings/<Modname>/` sind in einem verbreiteten FS25-Mod im Einsatz.  
**Offen:** Liegt dieses Verzeichnis auf einem gemieteten Dedicated Server im per FTP sichtbaren Baum, und darf der Mod dort auf dem Dedicated Server schreiben?

### 1.3 Netzwerk aus Lua

Farmhand, Stand der gelesenen README: „The FS25 Lua sandbox has no sockets, so there is no network path available to the mod even in principle.“ Der Autor transportiert Daten über eine Windows-Named-Pipe und zusätzlich über eine JSON-Datei. Es gibt in diesem Mod kein HTTP.

Dieselbe Grenze umgeht [FS25 FarmMonitor](https://github.com/Cypris2010/FS25_FarmMonitor), indem Lua JSON schreibt und ein separates Go-Programm die Dateien liest. Der Autor schreibt, Dedicated Server ohne lokalen Spieler würden nicht unterstützt.

**Fakt:** Zwei öffentliche Mods verlassen die Sandbox über Dateien. Einer zusätzlich über eine lokale Windows-Pipe.  
**Annahme, bis widerlegt:** Ein gemieteter Linux-Gameserver ohne Shell kann keine Named Pipe und kein zweites Programm für uns starten.  
**Offen:** Ob irgendeine undokumentierte Engine-Funktion trotzdem HTTPS sprechen kann. Solange das nicht in GDN oder in einem minimalen Test auf dem Zielserver sichtbar ist, planen wir keinen Push aus Lua.

`os.execute`, `io.popen` und ein mitgeliefertes `curl` sind kein vorgesehener Weg. Sie brauchen eine Shell, blockieren leicht den Spielthread und sind auf Mietservern oft gesperrt.

### 1.4 Höfe und Geld, lesend und als Funktionsnamen

In [FS25_TransactionLog](https://github.com/rittermod/FS25_TransactionLog) werden diese Aufrufe verwendet:

- `g_farmManager:getFarmById(...)`
- `farm:getBalance()`
- `farm:getEquity()`
- `Farm.changeBalance` als Hook mit den Argumenten Betrag und `moneyType`
- `g_currentMission:addMoney` als Hook mit Betrag, `farmId` und `moneyType`
- `g_currentMission:getFarmId()`

**Fakt:** Diese Namen existieren in einem Mod, der Transaktionen beobachtet.  
**Offen:** Ob ein Dedicated-Server-Mod `changeBalance` so aufrufen darf, dass der neue Kontostand im Savegame bleibt, im Mehrspieler an Clients geht und zwischen zwei Höfen desselben Servers einen nachvollziehbaren Transfer ergibt. Bis zu diesem Test gibt es keine Produktivzahlung.

### 1.5 Weitere Lesepfade in öffentlichen Mods

Farmhand beschreibt Collector-Gruppen für Fahrzeug, Geräte, Tiere, Produktionen, Verträge, Wetter, Kalender und Verkaufsstellenpreise. Die Preise sind dort nicht an einen Hof gebunden. Der Mod läuft nach eigener Beschreibung auf dem Client und filtert auf die Farm des lokalen Spielers.

FarmTablet liest über einen DataProvider unter anderem Kontostand, Kredit, Felder, Tierhaltungen und Fahrzeuge und überspringt auf Dedicated Servern die Initialisierung ([FarmTablet-Architektur](https://github.com/TheCodingDad-TisonK/FS25_FarmTablet/blob/v2.3.0.0/docs/developer/architecture.md)). Das zeigt Client-Daten, nicht die Dedicated-Server-Fähigkeit.

**Annahme:** Ein serverautoritativer Mod kann dieselben Manager lesen, die der Client liest, sofern `g_server` gesetzt ist.  
**Offen:** Welche Manager auf einem Dedicated Server ohne lokalen Spieler befüllt sind.

### 1.6 Feldform

Map-Felder tragen in der GIANTS-Szenenstruktur eine Gruppe `polygonPoints`. Das ist die Form, mit der der Editor Felder beschreibt, nicht automatisch eine Lua-Methode `getPolygonPoints`. Eine solche Methode wird hier nicht behauptet.

**Offen:** die stabile Lua-Abfrage der Punkte auf einem laufenden Dedicated Server und die Umrechnung in Kartenkoordinaten je Mapgröße. Ohne beides zeigt die Karte keine erfundenen Rechtecke.

### 1.7 Ingame-Oberfläche

FS25-Oberflächen sind GUI-XML und Lua der GIANTS-Engine. FarmTablet und Courseplay laden GUI-Profile über `g_gui`. Ein HTML-Browser im Spiel ist nicht belegt und wird nicht vorausgesetzt. Das Tablet ist Phase 6 und nutzt dieselben Datenverträge wie das Web, eine andere Darstellung.

### 1.8 Lokalisierung im Mod

`modDesc.xml` trägt Titel und Beschreibung je Sprache als `<en>` und `<de>`. Weitere Sprachen können als weitere Elemente folgen, sobald das Schema der installierten Version das erlaubt. Das wird beim ersten Mod-Spike gegen `modDesc.html` geprüft.

## 2. Geplanter Connector, Version 0

Quellen liegen unter `connector/FS25_AgravionConnector/`. Verbindlicher Dateivertrag: [CONNECTOR-CONTRACT.md](CONNECTOR-CONTRACT.md).

Der erste Mod tut nur dies:

1. Er startet auf dem Server (`g_server ~= nil`) und bricht bei Fehlern in seinem eigenen Takt ab, ohne den Dedicated Server anzuhalten.
2. Er legt `modSettings/FS25_AgravionConnector/` an.
3. Er schreibt `hello.xml`, wenn der Schreibtest gelingt. Inhalt: Mod-Version, Spielzeit, UTC-Zeit des Schreibens, Liste der Farm-IDs. Je Hof stehen Name und Kontostand nur dann darin, wenn der Aufruf eine Zahl liefert. Eine gemeldete 0 bleibt 0. Liefert der Aufruf nichts, fehlt der Wert und das Dashboard zeigt „nicht verfügbar“.
4. Er schreibt atomar, soweit die Engine das hergibt: temporäre Datei, dann der sichtbare Name. **Offen**, ob Umbenennen erlaubt ist. Fallback: eine Generation-Nummer in der Datei.
5. **Fahrzeuge:** Full-Load nach Start und in grobem Intervall (`state/vehicles_full.xml`). Laufend später Delta; nach Save-Reload wieder Full-Load. Iteratoren werden erst nach Dedicated-Server-Probe finalisiert — bis dahin bleibt der Savegame-Feed die Meta-Quelle.
6. **Icons:** Fahrzeug-StoreIcons bei Full-Load → `icons/store/<storeKey>.*` + Manifest (`kind=store`). Zuordnung über `storeKey`. Mod-Pack-Icons (`icons/mods/`) später. Backend: Cron zieht Manifest und fehlende DDS lokal, wandelt nach PNG um (BC7 braucht `bin/dds2rgba`), Equipment liest nur den lokalen Cache — kein FTP pro Seitenaufruf.
7. Er liest `command.xml` und unterstützt in Version 0 nur `noop` und `ping`. Kein Geld.
8. Er markiert verarbeitete Befehls-IDs, damit ein Reconnect denselben Befehl nicht doppelt ausführt.
9. Er tickt in Abständen von mehreren Sekunden, nicht pro Frame.

Erst ein späterer Modstand nimmt fachliche Deltas (Felder, Tiere, Lager) auf. Geldbefehle kommen nach dem Dedicated-Server-Nachweis in eine eigene Befehlsliste.

## 3. Transporte

| Transport | Wann | Voraussetzung | Stand |
| --- | --- | --- | --- |
| `webapi_feed` | Dedicated Server mit erreichbarer Web-API | Basis-URL und Feed-Code, nur GET | auf einem Testserver mit Spiel 1.24 belegt, siehe Abschnitt 0 |
| `file_pull` | Mod-Dateien und Savegames, die der Feed nicht herausgibt | SFTP, FTPS oder, nur mit ausdrücklicher Warnung, FTP. `modSettings` ist der erwartete Normalfall, der Pfad wird geprüft | Betreiberangabe, noch kein FTP-Test von uns |
| `local_bridge` | eigener PC oder Dedicated Server mit Shell | kleines Programm liest die Dateien und sendet ausgehendes HTTPS an das Dashboard | Muster ist durch FarmMonitor und Farmhand belegt, unsere Bridge existiert nicht |
| `lua_https` | nur nach Nachweis | dokumentierte oder getestete Engine-Funktion | nicht belegt; **kein Pflichtweg**. Hoster lassen ausgehenden Traffic oft zu — unklar ist die Lua-Sandbox und die Performance bei großen Payloads. Icons und Full-Loads bleiben dateibasiert |
| Named Pipe | Windows, lokal | Prozess auf demselben Rechner | für Miet-Linux ungeeignet, nicht der Standardweg |

Eingehende Zusatzports sind nicht nötig. Der Feed nutzt den Web-Port, den der Dedicated Server bereits veröffentlicht. Die Anmeldung an der Web-Oberfläche ist ein separates, privilegiertes Tor und nicht der Leseweg. Steuerbefehle über diese Oberfläche wurden nicht ausgeführt.

## 4. Fachfunktionen und ihr Nachweisgrad

| Funktion | Lesen | Schreiben | Konsequenz für Version 1 |
| --- | --- | --- | --- |
| Serverstatus, Spielerzahl, Map, Spielversion | Web-API-Feed, auf einem Testserver gesehen | | Control-Center-Karte |
| Kartenbild | JPEG-Feed, Parameter `quality` und `size` | | Hintergrund der Karte, sobald die Koordinatenformel an einem bekannten Punkt stimmt |
| Hof-ID | Farmland-`owner` und Fahrzeug-`farmId` im Savegame-Feed | Name und Kontostand je Hof nicht im Feed | Höfe als IDs, Name und Geld „nicht verfügbar“, bis `farms.xml` oder der Mod sie liefert |
| Kontostand, Eigenkapital | ein Summenfeld in `careerSavegame`, nicht je Hof. `getBalance` nur in einem Client-Mod | `changeBalance` / `addMoney` nur als beobachtete Hooks | die Summe wird nicht als Hofkonto angezeigt. Keine Produktivzahlung |
| Fahrzeuge, Position, Füllstände | Stats-Feed: Position, teils Füllstand. Savegame: `farmId`, Betriebsstunden | Ausrichtung fehlt | Position aus dem Stats-Feed, Hof und Stunden aus der Savegame-Datei, mit getrennten Zeitstempeln |
| Felder, Besitz | Feld-Anker und Besitz-Flag, Farmland-Anker mit Hof-ID | Frucht, Wachstum und Polygon fehlen | Marker, keine erfundenen Feldformen |
| Tiere, Futter, Produkte | im geprüften Feed nicht enthalten | | „nicht verfügbar“ |
| Lager, Produktionen | im geprüften Feed nicht enthalten | | „nicht verfügbar“ |
| Verkaufspreise | Periodenpreise und Großbedarf in `economy` | Preise je Verkaufsstelle fehlen | Periodenpreise mit Speicherzeitpunkt, Verkaufsstellen später |
| Live-Karte | Positionen und Kartenbild, `mapSize` | Achsenrichtung noch nicht visuell geprüft | Karte mit Punkten, Feldformen erst mit echten Polygonen |
| Ingame-Tablet | GUI-XML ist der übliche Weg | | Phase 6 |
| Mehrere Höfe auf einem Server | auf dem Testserver mehrere `farmId` in `vehicles.xml` und mehrere `owner` auf Farmlands | Transfer zwischen Höfen offen | Höfe sind Datensätze unter einem Workspace. Namen fehlen, bis eine weitere Quelle sie liefert |

Nicht verfügbare Werte werden als nicht verfügbar gespeichert und angezeigt. Ein Mock-Connector darf Daten erzeugen, die Oberfläche zeigt dann dauerhaft Demo.

## 5. Leistung und Ausfallsicherheit im Mod

- Kein Vollscan aller Objekte in jedem Frame.
- Kein blockierendes Warten auf Dateien oder, falls später vorhanden, auf Netz.
- Fehler im Connector werden geloggt und geschluckt, soweit die Engine das im Mod-Kontext zulässt. Ein defekter Schreibpfad darf den Serverstart nicht abbrechen. Fehlt nur der Mod, bleibt der Web-API-Feed davon unberührt.
- Puffer begrenzen: eine aktuelle Zustandsdatei, eine Befehlsdatei, eine Ergebnisdatei. Keine unbegrenzte Historie im Spielprofil.
- Befehle haben eine ID. Eine bekannte ID wird nicht ein zweites Mal ausgeführt.
- Ein Befehlsablauf, den der Mod nicht kennt, wird mit `unsupported` beantwortet und nicht angenähert.

## 6. Nächster Prüfabschnitt

Ein Wegwerf-Mod auf einem Dedicated Server, mit diesem Protokoll. Der Feed aus Abschnitt 0 ist dafür nicht noch einmal die erste Frage.

1. `descVersion` aus `log.txt` notieren.
2. `modSettings`-Pfad und den Savegame-Ordner über den Dateizugang finden. Der Normalfall ist, dass beide sichtbar sind. Der konkrete Pfad wird notiert.
3. `hello.xml` schreiben und von außen lesen.
4. `ping`-Befehl von außen ablegen und die Antwort lesen.
5. Hofnamen und Kontostände aus `farms.xml` oder aus dem Mod mit dem Spiel abgleichen. Der Feed allein reicht dafür nicht.
6. Einen bekannten Fahrzeugpunkt auf das Karten-JPEG legen und die Achsenrichtung festhalten.
7. Server neu starten und prüfen, dass ein liegengebliebener `ping` nicht doppelt wirkt.
8. Erst danach einen einzelnen, dokumentierten Geldbefehl auf einem Test-Savegame, mit vorherigem Backup.
