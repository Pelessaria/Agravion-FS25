#!/usr/bin/env bash
# Agravion VPS install script (testing / advanced self-hosting)
# No Docker. Provisions OS packages, app code, .env, optional DB + Nginx.
#
# Example behind Nginx Proxy Manager:
#   curl -fsSL https://raw.githubusercontent.com/Pelessaria/Agravion-FS25/main/scripts/setup-vps.sh -o setup-vps.sh
#   chmod +x setup-vps.sh
#   sudo ./setup-vps.sh --target /var/www/agravion \
#     --with-db --with-nginx --behind-proxy --listen-port 8080 --migrate \
#     --db-password 'secret' \
#     --app-url https://agravion.pelessaria.de \
#     --server-name agravion.pelessaria.de
#
# NPM Proxy Host: http://VPS_IP:8080  +  SSL for the domain (Force SSL on)

set -euo pipefail

OWNER="Pelessaria"
REPO="Agravion-FS25"
BRANCH="main"
TARGET=""
SKIP_DOWNLOAD=0
SKIP_PACKAGES=0
MIGRATE=0
BUILD_FRONTEND=0
WITH_DB=0
WITH_NGINX=0
BEHIND_PROXY=0
LISTEN_PORT="80"
DB_HOST="127.0.0.1"
DB_PORT="3306"
DB_NAME="agravion"
DB_USER="agravion"
DB_PASSWORD=""
DB_NAME_EXPLICIT=0
DB_USER_EXPLICIT=0
LISTEN_PORT_EXPLICIT=0
DB_CONNECTION="mariadb"
APP_URL=""
APP_NAME="Agravion"
ADMIN_EMAIL="admin@agravion.local"
ADMIN_USERNAME="admin"
ADMIN_PASSWORD=""
PHP_BIN=""
SERVER_NAME="_"

usage() {
  cat <<'EOF'
Agravion VPS install (no Docker)

Usage:
  sudo ./scripts/setup-vps.sh [options]

By default the script installs PHP 8.3+, extensions, curl, unzip, git
(and optionally MariaDB + Nginx) via the system package manager.

Options:
  --target DIR          Install into DIR (default: /var/www/agravion)
                        A second customer is a second --target, with its own
                        database, Nginx site and scheduler cron.
  --skip-download       Use existing tree (git clone already present)
  --skip-packages       Do not apt/dnf install system packages
  --with-db             Install MariaDB and create database + user
  --with-nginx          Install Nginx, write site config, reload
  --behind-proxy        Trust X-Forwarded-* (Nginx Proxy Manager / TLS at proxy)
  --listen-port PORT    Nginx listen port (default: 80; use 8080 behind NPM)
  --server-name NAME    Nginx server_name (e.g. agravion.pelessaria.de)
  --branch NAME         Git branch (default: main)
  --db-host HOST        Database host (default: 127.0.0.1)
  --db-port PORT        Database port (default: 3306)
  --db-name NAME        Database name (default: agravion)
  --db-user USER        Database user (default: agravion)
  --db-password PASS    Database password (required with --with-db or --migrate)
  --db-connection NAME  mysql or mariadb (default: mariadb)
  --app-url URL         Public URL, e.g. https://agravion.pelessaria.de
  --app-name NAME       APP_NAME (default: Agravion)
  --admin-email EMAIL   Admin login email (default: admin@agravion.local)
  --admin-username NAME Admin username (default: admin)
  --admin-password PASS Admin login password (generated if omitted with --migrate)
  --migrate             Run php artisan migrate --force (+ ensure admin user)
  --build-frontend      npm ci && npm run build (needs Node)
  -h, --help            Show this help
EOF
}

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

instance_slug() {
  local base
  base="$(basename "$1")"
  base="$(printf '%s' "$base" | tr '[:upper:]' '[:lower:]' | sed -e 's/[^a-z0-9]/-/g' -e 's/-\+/-/g' -e 's/^-//' -e 's/-$//')"
  if [[ -z "$base" ]]; then
    base="agravion"
  fi
  printf '%.40s' "$base"
}

run_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    die "Root rights required for: $*"
  fi
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing command: $1"
}

detect_os() {
  if [[ -f /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    OS_ID="${ID:-unknown}"
    OS_LIKE="${ID_LIKE:-}"
    OS_VERSION_ID="${VERSION_ID:-}"
  else
    OS_ID="unknown"
    OS_LIKE=""
    OS_VERSION_ID=""
  fi
}

is_debian_family() {
  [[ "$OS_ID" == "debian" || "$OS_ID" == "ubuntu" || "$OS_LIKE" == *"debian"* ]]
}

is_rhel_family() {
  [[ "$OS_ID" == "fedora" || "$OS_ID" == "rhel" || "$OS_ID" == "centos" || "$OS_ID" == "rocky" || "$OS_ID" == "almalinux" || "$OS_LIKE" == *"rhel"* || "$OS_LIKE" == *"fedora"* ]]
}

resolve_php_bin() {
  if [[ -n "${PHP_BIN}" && -x "$(command -v "${PHP_BIN}" 2>/dev/null || true)" ]]; then
    return 0
  fi
  for candidate in php8.3 php8.4 php8.5 php; do
    if command -v "$candidate" >/dev/null 2>&1; then
      PHP_BIN="$candidate"
      return 0
    fi
  done
  PHP_BIN="php"
}

php_ok() {
  command -v "$PHP_BIN" >/dev/null 2>&1 || return 1
  "$PHP_BIN" -r 'exit(version_compare(PHP_VERSION, "8.3.0", ">=") ? 0 : 1);' 2>/dev/null || return 1
  local ext
  for ext in ctype curl dom fileinfo mbstring openssl pdo_mysql tokenizer xml zip; do
    "$PHP_BIN" -m 2>/dev/null | grep -qi "^${ext}$" || return 1
  done
  return 0
}

remove_broken_ondrej_ppa() {
  # Ubuntu 26.04 (resolute) and other new suites often have no ondrej Release file.
  run_root rm -f /etc/apt/sources.list.d/ondrej-ubuntu-php-*.list \
    /etc/apt/sources.list.d/ondrej-php-*.list 2>/dev/null || true
  run_root rm -f /etc/apt/sources.list.d/*ondrej*php*.sources 2>/dev/null || true
  if command -v add-apt-repository >/dev/null 2>&1; then
    run_root add-apt-repository -y -r ppa:ondrej/php 2>/dev/null || true
  fi
}

pick_debian_php_series() {
  # Prefer distro packages (Ubuntu 24.04+/26.04 often ship 8.4/8.5, not 8.3).
  local series
  for series in php8.5 php8.4 php8.3 php; do
    if apt-cache show "${series}-cli" >/dev/null 2>&1 || apt-cache show "${series}" >/dev/null 2>&1; then
      if [[ "$series" == "php" ]]; then
        printf '%s' "php"
      else
        printf '%s' "$series"
      fi
      return 0
    fi
  done
  return 1
}

provision_debian() {
  log "Installing packages (apt)"
  export DEBIAN_FRONTEND=noninteractive

  # Clear a previously failed ondrej PPA so apt update works again.
  remove_broken_ondrej_ppa
  run_root apt-get update -y

  local series=""
  series="$(pick_debian_php_series || true)"

  if [[ -z "$series" ]]; then
    log "No PHP 8.3+ packages in default repos - trying ondrej/php (may fail on new Ubuntu)"
    run_root apt-get install -y ca-certificates curl gnupg lsb-release software-properties-common apt-transport-https
    if [[ "$OS_ID" == "ubuntu" ]] && command -v add-apt-repository >/dev/null 2>&1; then
      if run_root add-apt-repository -y ppa:ondrej/php \
        && run_root apt-get update -y; then
        series="$(pick_debian_php_series || true)"
      else
        log "ondrej/php unavailable for this Ubuntu suite - removing broken repo"
        remove_broken_ondrej_ppa
        run_root apt-get update -y
      fi
    fi
  fi

  [[ -n "$series" ]] || die "No PHP packages found. On Ubuntu 26.04+ install php-cli/php-fpm from distro repos manually, then re-run with --skip-packages."

  log "Using APT PHP series: ${series}"
  local pkgs=(ca-certificates curl unzip git cron)
  if [[ "$series" == "php" ]]; then
    pkgs+=(
      php-cli php-fpm php-mysql php-xml php-mbstring
      php-curl php-zip php-bcmath php-intl php-sqlite3
    )
  else
    pkgs+=(
      "${series}-cli" "${series}-fpm" "${series}-mysql" "${series}-xml" "${series}-mbstring"
      "${series}-curl" "${series}-zip" "${series}-bcmath" "${series}-intl" "${series}-sqlite3"
    )
  fi

  if [[ "$WITH_DB" -eq 1 ]]; then
    pkgs+=(mariadb-server mariadb-client)
  fi
  if [[ "$WITH_NGINX" -eq 1 ]]; then
    pkgs+=(nginx)
  fi

  run_root apt-get install -y "${pkgs[@]}"

  if [[ "$series" != "php" ]] && command -v "$series" >/dev/null 2>&1; then
    PHP_BIN="$series"
  else
    resolve_php_bin
  fi

  if command -v phpenmod >/dev/null 2>&1; then
    run_root phpenmod mysqli pdo_mysql mbstring xml curl zip 2>/dev/null || true
  fi

  if command -v systemctl >/dev/null 2>&1; then
    local unit
    for unit in "${series}-fpm" php8.5-fpm php8.4-fpm php8.3-fpm php-fpm; do
      if systemctl list-unit-files 2>/dev/null | grep -q "^${unit}\\.service"; then
        run_root systemctl enable --now "$unit"
        break
      fi
    done
    run_root systemctl enable --now cron 2>/dev/null || true
  fi
}

provision_rhel() {
  log "Installing packages (dnf/yum)"
  local mgr="dnf"
  command -v dnf >/dev/null 2>&1 || mgr="yum"

  run_root "$mgr" install -y curl unzip git cronie \
    php php-cli php-fpm php-mysqlnd php-xml php-mbstring \
    php-curl php-zip php-bcmath php-intl php-pdo \
    || die "Package install failed. Install PHP 8.3+ manually, then re-run with --skip-packages."

  PHP_BIN="php"
  if command -v systemctl >/dev/null 2>&1; then
    run_root systemctl enable --now crond 2>/dev/null || true
  fi

  if [[ "$WITH_DB" -eq 1 ]]; then
    run_root "$mgr" install -y mariadb-server mariadb
    run_root systemctl enable --now mariadb 2>/dev/null \
      || run_root systemctl enable --now mysqld 2>/dev/null \
      || true
  fi
  if [[ "$WITH_NGINX" -eq 1 ]]; then
    run_root "$mgr" install -y nginx
    run_root systemctl enable --now nginx || true
  fi
}

provision_packages() {
  if [[ "$SKIP_PACKAGES" -eq 1 ]]; then
    log "Skipping package install (--skip-packages)"
    return 0
  fi

  detect_os
  log "OS: ${OS_ID} ${OS_VERSION_ID}"

  # Always need curl/unzip for download; install them first if missing
  if is_debian_family; then
    if ! command -v curl >/dev/null 2>&1 || ! command -v unzip >/dev/null 2>&1; then
      run_root apt-get update -y
      run_root apt-get install -y curl unzip ca-certificates
    fi
  fi

  if php_ok 2>/dev/null; then
    log "PHP already OK ($("$PHP_BIN" -v | head -n1))"
  else
    if is_debian_family; then
      provision_debian
    elif is_rhel_family; then
      provision_rhel
    else
      die "Unsupported OS for auto-packages (${OS_ID}). Install PHP 8.3+ manually, then use --skip-packages."
    fi
  fi

  # Optional stacks even if PHP was already present
  if [[ "$WITH_DB" -eq 1 ]]; then
    if ! command -v mysql >/dev/null 2>&1 && ! command -v mariadb >/dev/null 2>&1; then
      if is_debian_family; then
        run_root apt-get install -y mariadb-server mariadb-client
      elif is_rhel_family; then
        local mgr="dnf"; command -v dnf >/dev/null 2>&1 || mgr="yum"
        run_root "$mgr" install -y mariadb-server mariadb
      fi
    fi
    if command -v systemctl >/dev/null 2>&1; then
      run_root systemctl enable --now mariadb 2>/dev/null \
        || run_root systemctl enable --now mysql 2>/dev/null \
        || true
    fi
  fi

  if [[ "$WITH_NGINX" -eq 1 ]]; then
    if ! command -v nginx >/dev/null 2>&1; then
      if is_debian_family; then
        run_root apt-get install -y nginx
      elif is_rhel_family; then
        local mgr="dnf"; command -v dnf >/dev/null 2>&1 || mgr="yum"
        run_root "$mgr" install -y nginx
      fi
    fi
  fi

  resolve_php_bin
  php_ok || die "PHP 8.3+ with required extensions still missing after package install"
  need_cmd curl
  need_cmd unzip
  log "Using $($PHP_BIN -v | head -n1)"
}

setup_database() {
  [[ "$WITH_DB" -eq 1 ]] || return 0
  [[ -n "$DB_PASSWORD" ]] || die "--with-db requires --db-password"

  log "Creating MariaDB/MySQL database and user"
  local mysql_cmd=()
  if command -v mariadb >/dev/null 2>&1; then
    mysql_cmd=(mariadb)
  elif command -v mysql >/dev/null 2>&1; then
    mysql_cmd=(mysql)
  else
    die "mysql/mariadb client not found after package install"
  fi

  [[ "$DB_NAME" =~ ^[A-Za-z0-9_]+$ ]] || die "db-name must be alphanumeric/underscore"
  [[ "$DB_USER" =~ ^[A-Za-z0-9_]+$ ]] || die "db-user must be alphanumeric/underscore"

  local pass_sql
  pass_sql=${DB_PASSWORD//\'/\'\'}

  # No SQL backticks here: unquoted heredocs would treat them as shell command substitution.
  local sql
  sql=$(cat <<SQL
CREATE DATABASE IF NOT EXISTS ${DB_NAME} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${pass_sql}';
CREATE USER IF NOT EXISTS '${DB_USER}'@'127.0.0.1' IDENTIFIED BY '${pass_sql}';
GRANT ALL PRIVILEGES ON ${DB_NAME}.* TO '${DB_USER}'@'localhost';
GRANT ALL PRIVILEGES ON ${DB_NAME}.* TO '${DB_USER}'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL
)

  if run_root "${mysql_cmd[@]}" -e "$sql" 2>/dev/null; then
    log "Database ready: ${DB_NAME} / ${DB_USER}@localhost"
  else
    sql=$(cat <<SQL
CREATE DATABASE IF NOT EXISTS ${DB_NAME} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON ${DB_NAME}.* TO '${DB_USER}'@'localhost' IDENTIFIED BY '${pass_sql}';
GRANT ALL PRIVILEGES ON ${DB_NAME}.* TO '${DB_USER}'@'127.0.0.1' IDENTIFIED BY '${pass_sql}';
FLUSH PRIVILEGES;
SQL
)
    run_root "${mysql_cmd[@]}" -e "$sql" \
      || die "Could not create database. Create it manually, then re-run with --migrate."
  fi

  DB_HOST="127.0.0.1"
  DB_CONNECTION="mariadb"
}

detect_fpm_sock() {
  local sock
  for sock in \
    /run/php/php8.3-fpm.sock \
    /run/php/php8.4-fpm.sock \
    /run/php/php8.5-fpm.sock \
    /run/php/php-fpm.sock \
    /var/run/php/php8.3-fpm.sock \
    /var/run/php/php-fpm.sock
  do
    if [[ -S "$sock" ]]; then
      printf '%s' "$sock"
      return 0
    fi
  done
  printf '%s' "/run/php/php8.3-fpm.sock"
}

write_nginx_config() {
  [[ "$WITH_NGINX" -eq 1 ]] || return 0
  need_cmd nginx

  local public_dir="${BACKEND}/public"
  local sock
  sock="$(detect_fpm_sock)"
  local conf="/etc/nginx/sites-available/agravion-${SITE_SLUG}"
  local conf_d="/etc/nginx/conf.d/agravion-${SITE_SLUG}.conf"

  log "Writing Nginx site agravion-${SITE_SLUG} (root ${public_dir}, port ${LISTEN_PORT})"

  local listen_extra=""
  if [[ "$LISTEN_PORT" == "80" && "$SERVER_NAME" == "_" && "$BEHIND_PROXY" -eq 0 ]]; then
    listen_extra=" default_server"
  fi

  # Real IP from NPM / reverse proxy (optional; safe defaults)
  local real_ip_block=""
  if [[ "$BEHIND_PROXY" -eq 1 ]]; then
    real_ip_block=$(cat <<'RIP'
    real_ip_header X-Forwarded-For;
    set_real_ip_from 10.0.0.0/8;
    set_real_ip_from 172.16.0.0/12;
    set_real_ip_from 192.168.0.0/16;
    set_real_ip_from 127.0.0.1;
RIP
)
  fi

  local body
  body=$(cat <<NGINX
server {
    listen ${LISTEN_PORT}${listen_extra};
    listen [::]:${LISTEN_PORT}${listen_extra};
    server_name ${SERVER_NAME};
    root ${public_dir};
    index index.php;

${real_ip_block}

    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;

    charset utf-8;
    client_max_body_size 64M;

    location / {
        try_files \$uri \$uri/ /index.php?\$query_string;
    }

    location = /favicon.ico { access_log off; log_not_found off; }
    location = /robots.txt  { access_log off; log_not_found off; }

    location ~ \.php\$ {
        include fastcgi_params;
        fastcgi_param SCRIPT_FILENAME \$realpath_root\$fastcgi_script_name;
        fastcgi_param DOCUMENT_ROOT \$realpath_root;
        fastcgi_pass unix:${sock};
    }

    location ~ /\.(?!well-known).* {
        deny all;
    }
}
NGINX
)

  if [[ -d /etc/nginx/sites-available ]]; then
    printf '%s\n' "$body" | run_root tee "$conf" >/dev/null
    run_root rm -f /etc/nginx/sites-enabled/default
    run_root ln -sfn "$conf" "/etc/nginx/sites-enabled/agravion-${SITE_SLUG}"
  else
    printf '%s\n' "$body" | run_root tee "$conf_d" >/dev/null
  fi

  # Permissions for www-data / nginx
  local web_user="www-data"
  id -u nginx >/dev/null 2>&1 && web_user="nginx"
  if id -u "$web_user" >/dev/null 2>&1; then
    run_root chown -R "$web_user":"$web_user" "${BACKEND}/storage" "${BACKEND}/bootstrap/cache" || true
  fi

  run_root nginx -t
  if command -v systemctl >/dev/null 2>&1; then
    run_root systemctl enable --now nginx
    run_root systemctl reload nginx
  else
    run_root nginx -s reload || true
  fi

  if [[ -z "$APP_URL" ]]; then
    APP_URL="http://$(detect_public_ip)"
  fi
}

detect_public_ip() {
  local ip
  ip=$(curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null || true)
  if [[ -z "$ip" ]]; then
    ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  fi
  printf '%s' "${ip:-127.0.0.1}"
}

set_env_key() {
  local file="$1"
  local key="$2"
  local value="$3"
  local escaped line tmp

  escaped=$(printf '%s' "$value" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
  line="${key}=\"${escaped}\""
  tmp=$(mktemp)

  KEY="$key" LINE="$line" awk '
    BEGIN { k = ENVIRON["KEY"]; line = ENVIRON["LINE"]; done = 0 }
    index($0, k "=") == 1 { print line; done = 1; next }
    { print }
    END { if (!done) print line }
  ' "$file" >"$tmp"

  mv "$tmp" "$file"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    --owner) OWNER="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --skip-download) SKIP_DOWNLOAD=1; shift ;;
    --skip-packages) SKIP_PACKAGES=1; shift ;;
    --with-db) WITH_DB=1; shift ;;
    --with-nginx) WITH_NGINX=1; shift ;;
    --behind-proxy) BEHIND_PROXY=1; shift ;;
    --listen-port) LISTEN_PORT="$2"; LISTEN_PORT_EXPLICIT=1; shift 2 ;;
    --server-name) SERVER_NAME="$2"; shift 2 ;;
    --migrate) MIGRATE=1; shift ;;
    --build-frontend) BUILD_FRONTEND=1; shift ;;
    --db-host) DB_HOST="$2"; shift 2 ;;
    --db-port) DB_PORT="$2"; shift 2 ;;
    --db-name) DB_NAME="$2"; DB_NAME_EXPLICIT=1; shift 2 ;;
    --db-user) DB_USER="$2"; DB_USER_EXPLICIT=1; shift 2 ;;
    --db-password) DB_PASSWORD="$2"; shift 2 ;;
    --db-connection) DB_CONNECTION="$2"; shift 2 ;;
    --app-url) APP_URL="$2"; shift 2 ;;
    --app-name) APP_NAME="$2"; shift 2 ;;
    --admin-email) ADMIN_EMAIL="$2"; shift 2 ;;
    --admin-username) ADMIN_USERNAME="$2"; shift 2 ;;
    --admin-password) ADMIN_PASSWORD="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown argument: $1 (try --help)" ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
DEFAULT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ -n "$TARGET" ]]; then
  ROOT="$TARGET"
elif [[ -f "${DEFAULT_ROOT}/backend/artisan" ]]; then
  ROOT="$DEFAULT_ROOT"
else
  ROOT="/var/www/agravion"
fi

BACKEND="${ROOT}/backend"
SITE_SLUG="$(instance_slug "$ROOT")"

if [[ "$DB_NAME_EXPLICIT" -eq 0 && "$SITE_SLUG" != "agravion" ]]; then
  DB_NAME="agravion_$(printf '%s' "$SITE_SLUG" | tr '-' '_')"
fi
if [[ "$DB_USER_EXPLICIT" -eq 0 && "$SITE_SLUG" != "agravion" ]]; then
  DB_USER="$DB_NAME"
fi

if [[ -z "$APP_URL" ]]; then
  if [[ "$WITH_NGINX" -eq 1 ]]; then
    APP_URL="http://$(detect_public_ip)"
  else
    APP_URL="http://127.0.0.1:8000"
  fi
fi

# https://ÔÇª implies reverse-proxy TLS termination unless explicitly skipped
if [[ "$APP_URL" == https://* ]]; then
  BEHIND_PROXY=1
fi

if [[ "$BEHIND_PROXY" -eq 1 && "$LISTEN_PORT_EXPLICIT" -eq 0 && "$WITH_NGINX" -eq 1 ]]; then
  if [[ "$SITE_SLUG" == "agravion" ]]; then
    LISTEN_PORT="8080"
  else
    port_sum="$(printf '%s' "$SITE_SLUG" | cksum | awk '{print $1}')"
    LISTEN_PORT="$((8081 + port_sum % 900))"
  fi
  log "Behind proxy: Nginx will listen on ${LISTEN_PORT} (override with --listen-port)"
fi

if [[ "$SERVER_NAME" == "_" && "$APP_URL" == http*://* ]]; then
  SERVER_NAME="$(printf '%s' "$APP_URL" | sed -e 's|^https://||' -e 's|^http://||' -e 's|/.*||')"
fi

if [[ "$WITH_DB" -eq 1 || "$MIGRATE" -eq 1 ]]; then
  if [[ -z "$DB_PASSWORD" ]]; then
    DB_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | head -c 20)"
    log "Generated DB password (saved into backend/.env): ${DB_PASSWORD}"
  fi
fi

log "Agravion install -> ${ROOT}"
resolve_php_bin
provision_packages
setup_database

if [[ "$SKIP_DOWNLOAD" -eq 0 ]]; then
  log "Downloading ${OWNER}/${REPO}@${BRANCH}"
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT
  ZIP="${WORK}/source.zip"
  URL="https://codeload.github.com/${OWNER}/${REPO}/zip/refs/heads/${BRANCH}"
  curl -fsSL "$URL" -o "$ZIP"
  unzip -q "$ZIP" -d "$WORK"
  EXTRACTED="$(find "$WORK" -maxdepth 1 -type d -name "${REPO}-*" | head -n1)"
  [[ -n "$EXTRACTED" ]] || die "Extracted repo folder not found"
  run_root mkdir -p "$ROOT"
  if [[ -f "${BACKEND}/.env" ]]; then
    cp "${BACKEND}/.env" "${WORK}/.env.preserve"
  fi
  run_root cp -a "${EXTRACTED}/." "${ROOT}/"
  if [[ -f "${WORK}/.env.preserve" ]]; then
    run_root mkdir -p "$BACKEND"
    run_root cp "${WORK}/.env.preserve" "${BACKEND}/.env"
  fi
  trap - EXIT
  rm -rf "$WORK"
else
  log "Using existing tree (--skip-download)"
fi

[[ -f "${BACKEND}/artisan" ]] || die "backend/artisan missing under ${ROOT}"

cd "$BACKEND"

log "Composer dependencies"
if [[ ! -f vendor/autoload.php ]]; then
  if [[ -f composer.phar ]]; then
    "$PHP_BIN" composer.phar install --no-dev --optimize-autoloader --no-interaction
  elif command -v composer >/dev/null 2>&1; then
    composer install --no-dev --optimize-autoloader --no-interaction
  else
    curl -fsSL https://getcomposer.org/download/latest-stable/composer.phar -o composer.phar
    "$PHP_BIN" composer.phar install --no-dev --optimize-autoloader --no-interaction
  fi
else
  echo "vendor/ already present - skipping composer install"
fi

if [[ ! -f .env ]]; then
  cp .env.example .env
  log "Created .env from .env.example"
fi

set_env_key .env APP_NAME "$APP_NAME"
set_env_key .env APP_URL "$APP_URL"
set_env_key .env APP_ENV "production"
set_env_key .env APP_DEBUG "false"
set_env_key .env APP_LOCALE "de"
set_env_key .env DB_CONNECTION "$DB_CONNECTION"
set_env_key .env DB_HOST "$DB_HOST"
set_env_key .env DB_PORT "$DB_PORT"
set_env_key .env DB_DATABASE "$DB_NAME"
set_env_key .env DB_USERNAME "$DB_USER"
set_env_key .env DB_PASSWORD "$DB_PASSWORD"
# File drivers avoid 500s when DB sessions/cache tables are missing or unreachable.
set_env_key .env SESSION_DRIVER "file"
set_env_key .env CACHE_STORE "file"
set_env_key .env QUEUE_CONNECTION "sync"
set_env_key .env LOG_CHANNEL "stack"

if [[ "$BEHIND_PROXY" -eq 1 ]]; then
  set_env_key .env TRUSTED_PROXIES "*"
  if [[ "$APP_URL" == https://* ]]; then
    set_env_key .env SESSION_SECURE_COOKIE "true"
  fi
fi

log "Application key"
"$PHP_BIN" artisan key:generate --force
if ! grep -qE '^APP_KEY=base64:.+' .env; then
  die "APP_KEY missing after key:generate. Check .env write permissions."
fi

log "Writable dirs + ownership for in-app updates"
mkdir -p storage/framework/cache/data storage/framework/sessions storage/framework/views
mkdir -p storage/logs storage/app/public bootstrap/cache
chmod -R ug+rwx storage bootstrap/cache || true
# php-fpm must own the Laravel tree so /api/system/update can overlay files.
# Root-owned installs cause: copy(...): Permission denied
web_user="www-data"
id -u nginx >/dev/null 2>&1 && web_user="nginx"
if id -u "$web_user" >/dev/null 2>&1; then
  run_root chown -R "$web_user":"$web_user" "$BACKEND" || true
  run_root chmod 640 .env || true
fi

deploy_frontend() {
  local dist="${ROOT}/frontend/dist"
  local pub="${BACKEND}/public"
  [[ -f "${dist}/index.html" ]] || return 1

  log "Deploying frontend into public/ (SPA at /)"
  mkdir -p "${pub}/assets"
  if [[ -d "${dist}/assets" ]]; then
    cp -a "${dist}/assets/." "${pub}/assets/"
  fi
  # Static files referenced as /favicon.svg etc.
  for f in favicon.svg favicon-light.svg logo.svg; do
    [[ -f "${dist}/${f}" ]] && cp -a "${dist}/${f}" "${pub}/${f}"
  done
  # Do not overwrite Laravel public/index.php
  cp -a "${dist}/index.html" "${pub}/agravion.html"
  return 0
}

if [[ "$BUILD_FRONTEND" -eq 1 ]]; then
  need_cmd npm
  log "Building frontend"
  (
    cd "${ROOT}/frontend"
    npm ci
    npm run build
  )
fi

if ! deploy_frontend; then
  log "No frontend/dist found - Laravel welcome page will show until UI is deployed"
fi

# Re-assert ownership after root copies into public/
if id -u "${web_user:-www-data}" >/dev/null 2>&1; then
  run_root chown -R "${web_user:-www-data}:${web_user:-www-data}" "$BACKEND" || true
  run_root chmod 640 "${BACKEND}/.env" || true
fi

ADMIN_PASSWORD_SHOWN=""
if [[ "$MIGRATE" -eq 1 ]]; then
  log "Running migrations"
  "$PHP_BIN" artisan migrate --force

  log "Ensuring admin login"
  if [[ -z "$ADMIN_PASSWORD" ]]; then
    ADMIN_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | head -c 16)"
    ADMIN_PASSWORD_SHOWN="$ADMIN_PASSWORD"
  fi
  "$PHP_BIN" artisan agravion:admin \
    --email="$ADMIN_EMAIL" \
    --username="$ADMIN_USERNAME" \
    --password="$ADMIN_PASSWORD" \
    --name="Admin"
fi

write_nginx_config

log "DDS decoder (BC7 store icons)"
mkdir -p bin
if command -v gcc >/dev/null 2>&1 && [[ -f tools/dds2rgba/main.c ]]; then
  gcc -O2 -o bin/dds2rgba tools/dds2rgba/main.c
  chmod 755 bin/dds2rgba
elif command -v gcc >/dev/null 2>&1 && [[ -f "${ROOT}/backend/tools/dds2rgba/main.c" ]]; then
  gcc -O2 -o bin/dds2rgba "${ROOT}/backend/tools/dds2rgba/main.c"
  chmod 755 bin/dds2rgba
else
  log "WARN: gcc fehlt — FS25 BC7-Icons werden nicht zu PNG. apt install build-essential, dann Setup erneut."
fi

log "Per-instance scheduler cron (${SITE_SLUG})"
mkdir -p storage/logs storage/framework
"$PHP_BIN" artisan agravion:install-schedule
if id -u "${web_user:-www-data}" >/dev/null 2>&1; then
  run_root chown -R "${web_user:-www-data}:${web_user:-www-data}" "${BACKEND}/storage" "${BACKEND}/bootstrap/cache" bin 2>/dev/null || true
fi

if [[ -d "${ROOT}/.git" ]] && command -v git >/dev/null 2>&1; then
  SHA="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"
else
  SHA=""
fi
mkdir -p storage/app
if [[ -n "$SHA" ]]; then
  printf '{\n  "sha": "%s",\n  "installedAt": "%s",\n  "via": "install.sh",\n  "version": "0.3.0"\n}\n' \
    "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > storage/app/update-state.json
else
  printf '{\n  "sha": null,\n  "installedAt": "%s",\n  "via": "install.sh",\n  "version": "0.3.0"\n}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > storage/app/update-state.json
fi

cat <<EOF

--------------------------------------------------
Agravion install finished
--------------------------------------------------
Root:     ${ROOT}
Backend:  ${BACKEND}
Public:   ${BACKEND}/public
APP_URL:  ${APP_URL}
PHP:      ${PHP_BIN} ($("$PHP_BIN" -r 'echo PHP_VERSION;'))

EOF

if [[ "$WITH_NGINX" -eq 1 ]]; then
  cat <<EOF
Nginx:    site agravion-${SITE_SLUG} -> ${BACKEND}/public
Listen:   ${LISTEN_PORT}
Database: ${DB_NAME}
Open:     ${APP_URL}
EOF
else
  cat <<EOF
Database: ${DB_NAME}
Quick test without Nginx:
  cd ${BACKEND}
  ${PHP_BIN} artisan serve --host=0.0.0.0 --port=8000
EOF
fi

cat <<EOF

Login:
  URL:      ${APP_URL}/login
  Email:    ${ADMIN_EMAIL}
  Username: ${ADMIN_USERNAME}
EOF

if [[ -n "${ADMIN_PASSWORD_SHOWN}" ]]; then
  cat <<EOF
  Pass:     ${ADMIN_PASSWORD_SHOWN}
  (generated — change after first login)
EOF
elif [[ "$MIGRATE" -eq 1 ]]; then
  cat <<EOF
  Pass:     (the --admin-password you set)
EOF
else
  cat <<EOF
  Create/reset admin:
    cd ${BACKEND}
    ${PHP_BIN} artisan agravion:admin --email=you@example.com --username=admin --password='YourSecret'
EOF
fi

cat <<EOF

Updates later (always from backend/):
  cd ${BACKEND}
  ${PHP_BIN} artisan migrate --force
  ${PHP_BIN} artisan agravion:update --check
  ${PHP_BIN} artisan agravion:update --apply

If in-app Update says Permission denied:
  chown -R ${web_user:-www-data}:${web_user:-www-data} ${BACKEND}
  chmod 640 ${BACKEND}/.env

Repo: https://github.com/${OWNER}/${REPO}

Another customer on this VPS is a separate directory, database and cron file.
Do not reuse --target. Example:
  sudo ./setup-vps.sh --target /var/www/hof-nord --with-db --with-nginx --behind-proxy --migrate --db-password 'other-secret' --app-url https://hof-nord.example --server-name hof-nord.example
--------------------------------------------------
EOF
