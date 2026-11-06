# Installation

**Status:** VPS über `scripts/setup-vps.sh` (inkl. Pakete, optional MariaDB/Nginx, NPM).  
**Stand:** 17. Oktober 2026

Updates: [UPDATES.md](UPDATES.md). Reverse Proxy: [REVERSE-PROXY.md](REVERSE-PROXY.md).

## VPS hinter Nginx Proxy Manager

Beispiel-Domain: `https://agravion.pelessaria.de`

```bash
curl -fsSL https://raw.githubusercontent.com/Pelessaria/Agravion-FS25/main/scripts/setup-vps.sh -o setup-vps.sh
chmod +x setup-vps.sh
sudo ./setup-vps.sh --target /var/www/agravion \
  --with-db --with-nginx --behind-proxy --listen-port 8080 --migrate \
  --db-password 'secret' \
  --app-url https://agravion.pelessaria.de \
  --server-name agravion.pelessaria.de
```

NPM Proxy Host: `http://VPS_IP:8080`, SSL + Force SSL für die Domain.

Eine zweite Kundeninstallation auf demselben VPS ist ein zweites Verzeichnis. Datenbank, Nginx-Site und Cron-Datei werden daraus abgeleitet und ersetzen die erste Installation nicht:

```bash
sudo ./setup-vps.sh --target /var/www/hof-nord \
  --with-db --with-nginx --behind-proxy --migrate \
  --db-password 'anderes-geheimnis' \
  --app-url https://hof-nord.example \
  --server-name hof-nord.example
```

Der Scheduler liegt danach in `/etc/cron.d/agravion-<kennung>` und gilt nur für dieses Verzeichnis.

### Store-Icons (DDS → PNG)

FS25-Store-Icons sind oft **DX10/BC7**. Das Dashboard wandelt sie mit dem Hilfsprogramm `backend/bin/dds2rgba` um (Quellcode unter `backend/tools/dds2rgba/`, Bibliothek [bcdec](https://github.com/iOrange/bcdec)).

`setup-vps.sh` baut das Binary, wenn `gcc` installiert ist. Auf einem frischen Ubuntu/Debian-VPS:

```bash
sudo apt install -y build-essential
```

Fehlt `bin/dds2rgba` nach dem Update:

```bash
cd /var/www/agravion/backend
gcc -O2 -o bin/dds2rgba tools/dds2rgba/main.c
chmod 755 bin/dds2rgba
php artisan agravion:sync-store-icons
php artisan agravion:icon-status
```

Diagnose: `php artisan agravion:schedule-status` (Cron), `php artisan agravion:icon-status` (Cache: PNG vs. DDS-only, Formate). Log-Zeilen `Agravion icon sync pass` in `storage/logs/laravel.log` bzw. `storage/logs/icon-sync.log`.

> Nicht `cdn.jsdelivr.net/.../install.sh` verwenden — dort kann eine veraltete Datei ohne `--with-db` gecacht sein. Kanonisch ist `setup-vps.sh` über raw.githubusercontent.com.

## Ohne Proxy (direkt)

```bash
sudo ./setup-vps.sh --target /var/www/agravion --with-db --migrate \
  --db-password 'secret'
cd /var/www/agravion/backend && php artisan serve --host=0.0.0.0 --port=8000
```

## Aus Clone

```bash
git clone https://github.com/Pelessaria/Agravion-FS25.git
cd Agravion-FS25
sudo ./scripts/setup-vps.sh --skip-download --with-db --with-nginx --behind-proxy --migrate \
  --db-password 'secret' \
  --app-url https://agravion.pelessaria.de
```

`sudo` braucht es für Pakete, MariaDB und Nginx. Nur App ohne Systempakete: `--skip-packages`.
