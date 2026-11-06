# Changelog

Dieses Protokoll folgt [Keep a Changelog](https://keepachangelog.com/de/1.1.0/). Versionen folgen der semantischen Versionierung, sobald es Releases gibt.

## [Unreleased]

### Hinzugefügt

- Laravel-Backend mit Feed-Client (`fs25:feed-fetch`), Workspace-Migration und In-App-Updater aus GitHub (`agravion:update`, `/api/system/update`).
- Einstellungen → Update in der UI; Docs `UPDATES.md`, Deploy ohne Docker.
- Connector-Mod v0 inkl. Probe-Paket.
- Phase-2-Prototyp in `frontend/` (Agravion-UI).

### Geändert

- Docker / Compose entfällt als Betriebsart. Ziel bleibt Shared Hosting über GitHub-Repo und späteren Installer.

### Noch nicht vorhanden

- Web-Installer, Realm-Admin-Auth am Update-Endpoint, vollständige API-Anbindung des Frontends.
