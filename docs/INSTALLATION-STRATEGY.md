# Installationsstrategie

**Status:** Plan. Der Installer existiert noch nicht; In-App-Update aus GitHub ist vorhanden.  
**Stand:** 14. Oktober 2026

Bedienschritte für spätere Nutzer stehen gesammelt in [INSTALLATION.md](INSTALLATION.md). Dieses Dokument begründet die Varianten.

## 1. Grundsatz

Die Installation muss ohne Shell gelingen. Shell, Composer, Cron und SSH sind Abkürzungen, wo sie vorhanden sind, und keine Voraussetzung.

Geheimnisse verlassen die Installation nicht. Es gibt in Version 1 keinen zentralen Einrichtungsdienst, der `.env` oder Datenbankpasswörter empfängt.

## 2. Varianten

| Variante | Ziel | Pflicht in Version 1 |
| --- | --- | --- |
| `scripts/install.sh` auf VPS | Testserver / fortgeschrittenes Self-Hosting mit Shell | ja (aktueller Install-Pfad) |
| In-App-Update aus demselben Repo | laufende Installation | ja |
| Web-Installer (Browser) | Shared Hosting ohne Shell | später — derzeit nicht aktiv |
| CLI `php artisan` | Entwicklung und Shell-Hosts | ja für Entwickler |
| Docker / Compose / PowerShell-Installer | | **nein** — nicht unterstützt |
| Grafischer Desktop-Installer | | nein, solange der Web-Installer führt |
| Zentraler SaaS-Einrichtungsdienst | Menschen ohne eigenen Webspace | später, mit eigener Datenschutzbeschreibung |

Docker ist keine Option. Jede Installation muss auf typischem Webspace ohne Root, ohne Shell und ohne Container laufen können.

## 3. Release-Paket

`fs25-platform-<version>-web.zip` enthält:

- Anwendungscode und `vendor/`
- gebautes Frontend
- keinen `node_modules`-Ordner
- keine `.env` mit echten Werten
- eine `.env.example` ohne Geheimnisse
- den Installer, der sich nach Erfolg sperrt

Das Connector-ZIP ist ein zweites Artefakt. Es enthält keine Zugangsdaten des Webspace und keine Zugangsdaten des Spielhosters.

## 4. Ablauf des Web-Installers

1. **Voraussetzungen.** PHP-Version, Erweiterungen aus [SHARED-HOSTING.md](SHARED-HOSTING.md), Schreibrecht auf `storage/` und `bootstrap/cache`, erreichbares Webroot.
2. **HTTPS.** Der Installer zeigt die aufgerufene URL. Ohne HTTPS erklärt er, dass Cookies sonst nicht als `Secure` gesetzt werden, und setzt die Installation nicht stillschweigend auf HTTP-Sessions fort. Ein lokaler Entwicklungslauf darf HTTP ausdrücklich bestätigen.
3. **Datenbank.** Auswahl MariaDB oder MySQL. Verbindungstest mit den eingegebenen Daten. Anschließend `SELECT VERSION()` und Abgleich mit den unterstützten Versionen aus [DATABASES.md](DATABASES.md). Fehlermeldung ohne Passwort und ohne vollständigen DSN.
4. **Migrationen.** Über den PHP-Migrator im Webprozess, nicht über eine Shell.
5. **Geheimnisse.** `APP_KEY` zufällig. Keine festen Salts.
6. **Administrator.** Name, E-Mail, Passwort, Passwortwiederholung. Passwort mindestens 12 Zeichen. Hash sofort, Klartext nur im Request.
7. **Anzeigename und URL.** `APP_NAME`, öffentliche HTTPS-URL, Standardsprache.
8. **Prüfung.** Login-Seite antwortet, Datenbankabfrage der neuen Admin-Zeile gelingt, eine absichtlich gesperrte Datei ist von außen nicht lesbar.
9. **Ergebnis.** Nächste Schritte: erster Workspace, Connector-ZIP, Hinweis auf den Spielhoster. Einmalig angezeigte Geheimnisse werden danach nicht erneut im Klartext gezeigt.
10. **Sperre.** `storage/installed.lock`, Installationsrouten antworten 404. Ein zweiter paralleler Aufruf wartet auf eine exklusive Sperre und endet, sobald die Lock-Datei existiert.

Wenn ein Schritt auf dem konkreten Hoster nicht automatisierbar ist, zeigt der Installer die konkrete manuelle Handlung und den Grund. Er behauptet keine universelle Automatik.

## 5. Fallbacks

| Hindernis | Fallback |
| --- | --- |
| Document Root lässt sich nicht auf `public/` setzen | Layout mit geschützten Unterverzeichnissen und Webserver-Verbot. Der Installer prüft den Schutz per HTTP. Schlägt die Prüfung fehl, endet die Installation mit der Anleitung, das Webroot zu ändern |
| `putenv` ist deaktiviert | Bootstrap lädt die Umgebung ohne `putenv`, sofern der Installer den Zustand erkennt. Das ist eine Phase-3-Aufgabe und vor der Shared-Hosting-Abnahme zu testen |
| kein `mod_rewrite` | Front-Controller über `index.php`; der Installer nennt die hübsche URL als optional |
| kein Cron | Aufräumen und Abholen laufen beim authentifizierten Request mit Sperre. Ein Cron bleibt eine Beschleunigung |
| kein Composer auf dem Host | `vendor/` liegt im ZIP |
| FTP des Spielservers nur unverschlüsselt | der Workspace-Assistent verlangt eine Bestätigung und speichert das Protokoll als `ftp` |
| Spielhoster ohne lesbares `modSettings` | der Assistent endet bei „Mod hochgeladen, Live-Daten nicht verfügbar“ und verweist auf die lokale Bridge, falls der Betreiber einen Rechner mit Dateizugriff hat |

## 6. Updates

Führend: In-App-Update aus dem öffentlichen GitHub-Repository (Zipball des konfigurierten Zweigs). Details: [UPDATES.md](UPDATES.md).

- `.env`, `storage/` und das lokale `vendor/` bleiben erhalten.
- Migrationen laufen nach dem Overlay automatisch.
- Die UI liegt unter Einstellungen → Update; CLI: `php artisan agravion:update`.
- Realm-Admin-Auth am Endpoint folgt mit dem Installer; bis dahin ist `confirm=true` Pflicht.

Alternativ bleibt ein manuelles Release-ZIP möglich (ohne `.env` / `storage/installed.lock` zu überschreiben). Vor größeren Updates: Datenbankexport — siehe [BACKUP-RESTORE.md](BACKUP-RESTORE.md).

## 7. Connector auf dem Spielserver

Der Dashboard-Assistent ist führend, der Spielhoster bleibt manuell, bis ein Anbieter getestet ist:

1. Connector-ZIP bereitstellen.
2. Upload-Weg der gewählten Umgebung beschreiben: Panel, SFTP, FTPS oder FTP mit Warnung.
3. Aktivierung im Panel oder in der Mod-Liste des Servers beschreiben.
4. Neustart erklären, ohne ihn fernzusteuern, solange keine getestete API existiert.
5. Nach dem Start `hello.xml` abholen oder den Betreiber bitten, den Pfad zu prüfen.
6. Konkrete nächste Handlung bei Timeout, leerem Verzeichnis oder Schema-Fehler.

Automatischer Upload wird je Anbieter-Profil einzeln freigeschaltet. Profile stehen in [HOSTING-COMPATIBILITY.md](HOSTING-COMPATIBILITY.md).

## 8. Was Version 1 nicht verspricht

- Installation per einem Klick bei jedem Hoster ohne Angabe von Datenbank und URL
- automatisches Hochladen des Mods auf ungeprüfte Anbieter
- einen von uns betriebenen Zentralserver als Voraussetzung für Self-Hosting
