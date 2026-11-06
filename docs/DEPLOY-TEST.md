# Deploy-Test (Backend + Datenbank)

Kurzleitfaden für Agravion auf **Webspace / lokalem PHP + MySQL oder MariaDB**. Kein Docker. Keine Feed-Codes oder Passwörter in dieses Dokument schreiben.

## 1. Voraussetzungen

- PHP 8.3+ mit `pdo_mysql`, `mbstring`, `openssl`, `tokenizer`, `xml`, `ctype`, `json`, `fileinfo`, `curl`, `zip`
- Composer 2 (nur zum Bauen des Release-Pakets oder lokal)
- Node 20+ (nur zum Bauen des Frontends)
- Leere MySQL 8.0/8.4 bzw. MariaDB 10.11+ Datenbank beim Hoster (oder lokal)

Siehe [SHARED-HOSTING.md](SHARED-HOSTING.md) und [UPDATES.md](UPDATES.md).

## 2. VPS / lokaler Server

```bash
./scripts/install.sh --skip-download --migrate \
  --db-host 127.0.0.1 --db-name agravion --db-user agravion --db-password '…' \
  --app-url http://127.0.0.1:8000
```

Oder manuell in `backend/`: `.env` setzen, `php artisan key:generate`, `php artisan migrate`.

## 3. Feed-Abfrage (Gameserver Web-API)

Nur serverseitig. Der Feed-Code gehört ausschließlich in `.env` oder in die verschlüsselte Workspace-Spalte — nie ins Frontend.

```bash
cd backend
php artisan fs25:feed-fetch --url="https://HOST:PORT/feed/dedicated-server-stats.json?code=…" --out=feed/last-snapshot.json
```

## 4. Webspace

1. Release aus dem GitHub-Repo (Installer zieht Repo/Release-ZIP) so ablegen, dass das Document Root auf `public/` zeigt.
2. `.env` auf dem Server anlegen (nicht aus dem Repo). `APP_KEY`, DB-Zugangsdaten, optional `FS25_FEED_*`.
3. Migrationen: Web-Installer oder `php artisan migrate --force`.
4. Frontend-Build liegt im Release unter dem vom Installer vorgesehenen Pfad (bzw. `public/app` nach Update).
5. Updates danach über Einstellungen → Update oder `php artisan agravion:update --apply`.

Rechte: `storage/` und `bootstrap/cache/` schreibbar für den PHP-User. Outbound HTTPS zum GitHub-API für Updates.

## 5. Connector-Mod (parallel)

Siehe `connector/PROBE.md`. ZIP: `connector/dist/FS25_AgravionConnector.zip`.

## 6. Smoke-Checkliste

| # | Check |
| --- | --- |
| 1 | `php artisan migrate` ohne Fehler |
| 2 | `php artisan fs25:feed-fetch …` liefert `linkState=online` |
| 3 | `php artisan agravion:update --check` erreicht GitHub |
| 4 | `GET /api/system/update` antwortet JSON |
| 5 | Connector-Probe auf dem Spielserver |

## 7. Sicherheit

- Feed-Code und DB-Passwort nie committen
- Update-Endpoint später nur für Realm-Admin
- Keine Secrets in Issues, Logs oder Chat-Antworten
