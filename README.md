# Agravion (FS25 Management Platform)

**Status:** Phase 3 gestartet — React-Prototyp, Laravel-Backend-Grundgerüst, Connector v0, Feed-Client.  
**Stand:** 14. Oktober 2026  
**Produktname in der UI:** Agravion

Der Ordnername dieses Arbeitsverzeichnisses ist kein Produktname. Anzeigename, Texte und spätere Domain bleiben Konfiguration.

## Worum es geht

Die Plattform soll Daten mehrerer Farming-Simulator-25-Spielstände erfassen, sie in getrennten Workspaces zeigen und ausgewählte Aktionen erst dann als erledigt werten, wenn ein Connector die Ausführung im Spiel bestätigt hat.

Sie besteht perspektivisch aus:

- einem Web-Control-Center für die gesamte Installation,
- einem Workspace je registriertem Gameserver,
- einem PHP-Backend mit MariaDB oder MySQL,
- einem FS25-Lua-Connector,
- später einer Ingame-Oberfläche, sobald die Modding-Schnittstelle dafür geprüft ist.

## Kernentscheidung

Das Webdashboard wird als **PHP-8.3-Monolith mit Laravel** und einem **statisch gebauten React-Frontend** geplant. Es braucht keinen dauerhaft laufenden Node-Prozess, kein Redis, keine WebSockets und **kein Docker**. Dieselbe Codebasis läuft auf klassischem Shared Hosting; Updates kommen aus dem öffentlichen GitHub-Repository.

Lesen vom Dedicated Server läuft zuerst über die eingebaute Web-API. Ein Testserver hat am 12. Oktober 2026 den Stats-Feed, das Kartenbild und drei Savegame-Dateien geliefert. Schreiben und fehlende Fachdaten bleiben beim Lua-Mod. Dessen Dateien liegen unter `modSettings`; Miet-Hoster geben diesen Ordner nach Betreiberangabe zusammen mit Mods und Savegames per FTP frei. Die Pfade sind je Server verschieden und werden bei der Einrichtung geprüft. Ausgehendes HTTPS aus Lua ist weiterhin nicht nachgewiesen.

Details, Belege und offene Punkte stehen in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) und [docs/FS25-INTEGRATION.md](docs/FS25-INTEGRATION.md).

## Prototyp ansehen

Der klickbare Prototyp liegt in `frontend/`. Er spricht kein Backend an und enthält keine Zugangsdaten. Demo-Änderungen bleiben im `sessionStorage` des Browsers.

```bash
cd frontend
npm install
npm run dev
```

Lokal (Vite-Demo ohne Laravel): beliebige gültige E-Mail und Passwort mit mindestens 8 Zeichen (`wrong-password` = Fehler). Auf dem Server: Login mit dem Admin-Konto aus dem Installer; die UI kommt aus `frontend/dist` → `public/agravion.html`.

## VPS-Installation (Test / hinter NPM)

```bash
curl -fsSL https://raw.githubusercontent.com/Pelessaria/Agravion-FS25/main/scripts/setup-vps.sh -o setup-vps.sh
chmod +x setup-vps.sh
sudo ./setup-vps.sh --target /var/www/agravion \
  --with-db --with-nginx --behind-proxy --listen-port 8080 --migrate \
  --db-password 'secret' \
  --app-url https://agravion.pelessaria.de
```

Details: [docs/INSTALLATION.md](docs/INSTALLATION.md), [docs/REVERSE-PROXY.md](docs/REVERSE-PROXY.md).  
Repo: https://github.com/Pelessaria/Agravion-FS25

## Dokumente

| Dokument | Inhalt |
| --- | --- |
| [docs/DEPLOY-TEST.md](docs/DEPLOY-TEST.md) | Webserver/DB-Test, Feed-Fetch, Smoke-Checks |
| [docs/UPDATES.md](docs/UPDATES.md) | Selbst-Update aus GitHub (Shared Hosting) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Stack, Grenzen, Kommunikation, Verzeichnisplan |
| [docs/DATA-MODEL.md](docs/DATA-MODEL.md) | Realms, Benutzer, Workspaces, Höfe, Spielobjekte |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Phasen und prüfbare Schritte |
| [docs/SECURITY.md](docs/SECURITY.md) | Bedrohungsmodell und sichere Defaults |
| [docs/FS25-INTEGRATION.md](docs/FS25-INTEGRATION.md) | Belegte, angenommene und offene Spielschnittstellen |
| [docs/CONNECTOR-CONTRACT.md](docs/CONNECTOR-CONTRACT.md) | Dateivertrag Mod ↔ Backend (hello, Fahrzeuge, Icons) |
| [connector/](connector/) | FS25-Connector-Quellen (v0) |
| [docs/INSTALLATION-STRATEGY.md](docs/INSTALLATION-STRATEGY.md) | Installer, Release-Paket, Fallbacks |
| [docs/SHARED-HOSTING.md](docs/SHARED-HOSTING.md) | Webspace ohne Root |
| [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md) | VPS ohne Docker, gleicher Code wie Webspace |
| [docs/DATABASES.md](docs/DATABASES.md) | MariaDB und MySQL |
| [docs/HOSTING-COMPATIBILITY.md](docs/HOSTING-COMPATIBILITY.md) | Spielserver-Anbieter, ungeprüft markiert |
| [docs/I18N.md](docs/I18N.md) | Deutsch, Englisch, weitere Sprachen |
| [docs/PLUGIN-ARCHITECTURE.md](docs/PLUGIN-ARCHITECTURE.md) | Spätere Erweiterungen ohne unsichere Sandbox-Behauptung |
| [docs/API.md](docs/API.md) | Geplante API, noch ohne Implementierung |
| [docs/INSTALLATION.md](docs/INSTALLATION.md) | Geplante Bedienschritte für die Einrichtung |
| [docs/BACKUP-RESTORE.md](docs/BACKUP-RESTORE.md) | Geplantes Sicherungsmodell |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Geplante Entwicklungsumgebung und Tests |
| [docs/UX.md](docs/UX.md) | Designrichtung für den Prototyp, Nalika nur als Strukturreferenz |
| [CHANGELOG.md](CHANGELOG.md) | Änderungsprotokoll |

## Lesarten in den Dokumenten

- **Fakt:** durch Herstellerdoku oder ein öffentlich einsehbares Projekt zum Stand dieser Analyse belegt.
- **Annahme:** für die Architektur verwendet, von uns noch nicht getestet.
- **Offen:** vor der zugehörigen Implementierung zu prüfen. Darauf wird keine Kernfunktion zugesichert.

## Nächster Schritt

Installer, Sessions/Rollen und Anbindung des React-Frontends an die Laravel-API. Feed- und Connector-Pfade bleiben serverseitig.
