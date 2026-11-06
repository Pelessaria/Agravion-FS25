# Self-Hosting

**Status:** Optionaler VPS-Betrieb mit demselben Code wie Shared Hosting. **Kein Docker.**  
**Stand:** 17. Oktober 2026

## 1. Wann dieser Weg passt

Ein eigener VPS ist sinnvoll, wenn der Betreiber PHP und einen Webserver selbst verwaltet, Backups steuert oder den Dateiabruf zum Spielserver aus einem Netz heraus betreibt, das der Shared Hoster nicht erreicht.

Self-Hosting ist keine Voraussetzung. Wer nur Webspace hat, bleibt bei [SHARED-HOSTING.md](SHARED-HOSTING.md). Docker ist bewusst keine unterstützte Variante — dieselbe Pipeline (GitHub → Webspace/Installer → In-App-Update) gilt überall.

## 2. Betrieb mit PHP und Webserver

1. PHP 8.3+, Nginx/Apache/Caddy mit Document Root auf `public/`.
2. MariaDB 10.11+ oder MySQL 8.0+.
3. Code aus dem öffentlichen GitHub-Repo bzw. Release-ZIP (mit `vendor/`).
4. `.env` setzen, Migrationen ausführen (Installer oder `php artisan migrate`).
5. Updates: Einstellungen → Update oder `php artisan agravion:update --apply` — siehe [UPDATES.md](UPDATES.md).
6. Für Store-Icons: `build-essential` (gcc), damit `backend/bin/dds2rgba` gebaut werden kann. Ohne dieses Binary bleiben neuere FS25-Icons (BC7) als DDS liegen und erscheinen nicht in der Equipment-Liste. Details: [INSTALLATION.md](INSTALLATION.md).

Ein Cron-Eintrag je Installation (`/etc/cron.d/agravion-<kennung>`) führt `schedule:run` jede Minute aus. Eine zweite Installation auf demselben VPS bekommt ein eigenes Verzeichnis, eine eigene Datenbank und eine eigene Cron-Datei. Fehlt Cron, läuft der Icon-Abgleich weiter beim nächsten Dashboard-Aufruf.

Diagnose auf dem Server: `php artisan agravion:schedule-status`, `php artisan agravion:icon-status`.

## 3. Lokale Bridge zum Spiel

Auf dem Spielrechner:

- liest `modSettings/<Modname>/`
- sendet ausgehendes HTTPS an die öffentliche URL des Dashboards
- authentifiziert sich mit dem Connector-Geheimnis, das beim Koppeln einmal angezeigt wurde
- schreibt Befehlsdateien für den Mod

Die Bridge ist optional. Auf einem gemieteten Server ohne Shell steht sie nicht zur Verfügung.

## 4. Netz

- Das Dashboard ist über HTTPS erreichbar.
- Der Spielserver braucht für die Bridge ausgehendes HTTPS zum Dashboard.
- Eingehende Ports am Spielserver bleiben zu.
- Der Dedicated-Server-Webadmin (häufig TCP 8080 und 8443) wird nicht veröffentlicht.

## 5. Vergleich

| | Shared Hosting | Self-Hosting (VPS) |
| --- | --- | --- |
| Root | nicht nötig | je nach VPS vorhanden |
| Dauerprozess | nicht nötig | möglich, in Version 1 nicht nötig |
| Cron | oft fehlend | üblich |
| Datenbank | MariaDB oder MySQL des Hosters | derselbe Anwendungscode, selbst betrieben |
| Updates | GitHub-Zipball / Release-ZIP über die UI | dieselbe Update-Funktion |
| Docker | nein | nein |

## 6. Offene Punkte

- Ressourcenbedarf wird gemessen, sobald Installationen auf echten Paketen laufen.
