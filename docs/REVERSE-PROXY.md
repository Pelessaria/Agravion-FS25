# Reverse Proxy (Nginx Proxy Manager)

**Stand:** 14. Oktober 2026

Beispiel: `https://agravion.pelessaria.de`

## 1. App auf dem VPS

```bash
curl -fsSL https://raw.githubusercontent.com/Pelessaria/Agravion-FS25/main/scripts/setup-vps.sh -o setup-vps.sh
chmod +x setup-vps.sh
sudo ./setup-vps.sh --target /var/www/agravion \
  --with-db --with-nginx --behind-proxy --listen-port 8080 --migrate \
  --db-password 'secret' \
  --app-url https://agravion.pelessaria.de \
  --server-name agravion.pelessaria.de
```

In `backend/.env` muss stehen:

```env
APP_URL=https://agravion.pelessaria.de
TRUSTED_PROXIES=*
SESSION_SECURE_COOKIE=true
```

```bash
cd /var/www/agravion/backend
php artisan config:clear
```

Intern: Nginx auf Port `8080` (nicht oeffentlich 443).

## 2. Proxy Host in NPM

| Feld | Wert |
| --- | --- |
| Domain Names | `agravion.pelessaria.de` |
| Scheme | `http` |
| Forward Hostname / IP | VPS (intern erreichbar) |
| Forward Port | `8080` |
| SSL | Let's Encrypt, Force SSL an |

## 3. Bereits installiert — nur Domain

`.env` wie oben anpassen, `php artisan config:clear`, Nginx-Listen-Port = NPM-Forward-Port.

## 4. HTTP 500 hinter dem Proxy

Auf dem VPS:

```bash
# 1) Laravel-Log
sudo tail -n 80 /var/www/agravion/backend/storage/logs/laravel.log

# 2) Direkt ohne NPM testen (muss 200 sein)
curl -sI http://127.0.0.1:8080/up
curl -sI http://127.0.0.1:8080/

# 3) Typische Fixes
cd /var/www/agravion/backend
sudo chown -R www-data:www-data storage bootstrap/cache
sudo chmod -R ug+rwx storage bootstrap/cache

# In .env sicherstellen:
# APP_URL=https://agravion.pelessaria.de
# TRUSTED_PROXIES=*
# SESSION_SECURE_COOKIE=true
# SESSION_DRIVER=file
# CACHE_STORE=file

php artisan config:clear
php artisan cache:clear
sudo systemctl reload php*-fpm nginx
```

Wenn `/up` lokal OK ist, aber die Domain 500 liefert: NPM Forward Port/IP und „Websockets“ prüfen; SSL nur am NPM.
