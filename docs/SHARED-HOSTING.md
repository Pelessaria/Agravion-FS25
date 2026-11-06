# Shared Hosting

**Status:** Anforderungen aus öffentlicher Anbieterdoku und aus den Laravel-13-Systemvoraussetzungen. Noch keine Installation auf einem Webspace durchgeführt.  
**Stand:** 12. Oktober 2026

## 1. Zielumgebung

Klassischer Webspace, auf dem PHP über den Webserver läuft. Beispiele im Auftrag sind STRATO und vergleichbare Angebote. Geprüft wurde am 12. Oktober 2026 die öffentliche STRATO-FAQ, nicht ein konkretes Kundenpaket.

**Fakt, STRATO:**

- PHP 8.2, 8.3, 8.4 und 8.5 sind im Kundenlogin wählbar ([PHP-Einstellungen](https://www.strato.de/faq/hosting/wie-aendere-ich-meine-php-einstellungen-im-hosting-paket/)).
- Neue Datenbanken: MySQL 8 oder MariaDB 10.11 ([Datenbank](https://www.strato.de/faq/hosting/so-nutzen-sie-unsere-datenbank/)).
- SFTP und optional SSH lassen sich im Kundenlogin anlegen ([SFTP/SSH](https://www.strato.de/faq/hosting/so-nutzen-sie-ihren-ssh-sftp-zugang/)). SSH ist eine Erleichterung, keine Voraussetzung unserer Installation.
- Cron existiert auf der Legacy-Plattform in höheren Paketen und ist auf der neuen Plattform laut FAQ nicht verfügbar ([Cron](https://www.strato.de/faq/hosting/so-einfach-richten-sie-ihre-cron-jobs-ein/)).

Andere Hoster werden vor einer Kompatibilitätszusage einzeln nach derselben Liste geprüft.

## 2. Mindestvoraussetzungen der Anwendung

Aus [Laravel 13 Deployment](https://laravel.com/docs/13.x/deployment), plus unsere Datenbankwahl:

| Voraussetzung | Wert |
| --- | --- |
| PHP | 8.3, 8.4 oder 8.5 |
| Erweiterungen | Ctype, cURL, DOM, Fileinfo, Filter, Hash, Mbstring, OpenSSL, PCRE, PDO, pdo_mysql, Session, Tokenizer, XML |
| Datenbank | MySQL 8.0 oder neuer, oder MariaDB 10.11 oder neuer. Details in [DATABASES.md](DATABASES.md) |
| HTTPS | Pflicht für Produktivsitzungen |
| Webroot | ideal `public/` der Anwendung |
| Schreibrechte | `storage/`, `bootstrap/cache/` für den PHP-Benutzer |
| Speicherplatz | Release-ZIP mit `vendor/` und Frontend-Build; konkret zu messen, sobald das erste Paket gebaut ist. Planung rechnet mit deutlich unter 200 MB ohne Datenbank |
| Cron | nicht erforderlich |
| Composer, SSH, Shell, Docker, Redis, Node, WebSockets | nicht erforderlich |
| outbound HTTP(S) | nötig für den Dedicated-Server-Feed und für SFTP/FTPS/HTTPS zum Spielhoster. Klartext-HTTP nur mit ausdrücklicher Bestätigung |

PHP 8.2 ist auf manchen Hostern noch wählbar und für Laravel 13 zu alt. Der Installer lehnt es mit einem Hinweis ab, im Kundenlogin auf 8.3 oder neuer zu wechseln.

`max_execution_time` und `memory_limit` müssen den Installer und den ersten Migrationslauf tragen. Konkrete Untergrenzen werden in Phase 3 auf einem echten Paket gemessen und hier nachgetragen. Bis dahin zeigt der Installer die wirksamen Werte an.

## 3. Verzeichnis auf dem Webspace

Bevorzugt, wenn Dateien neben dem Webroot liegen dürfen:

```text
/home/account/fs25-platform/     .env, app, vendor, storage, bootstrap
/home/account/public_html/       Inhalt von public/, oder ein vom Hoster erlaubter Document Root auf .../fs25-platform/public
```

Wenn der Hoster nur ein Webverzeichnis anbietet:

```text
/webroot/index.php
/webroot/build/
/webroot/app/          per Webserver verboten
/webroot/vendor/       per Webserver verboten
/webroot/storage/      per Webserver verboten
/webroot/.env          per Webserver verboten
```

Apache-Regeln können das verbieten. Nginx-Webspace braucht die passende Regel im Panel. Der Installer prüft beide Fälle, indem er eine Testdatei anfordert. Ist sie lesbar, gilt die Installation als nicht abgeschlossen.

Ob STRATO Dateien außerhalb des Webroots zuverlässig ausliefert, ist **offen** und wird beim ersten Probe-Upload geklärt. Die Fallback-Struktur ist deshalb Teil des Plans, nicht eine Fußnote.

## 4. HTTPS

Zertifikate kommen vom Hoster. Die Anwendung setzt Session-Cookies nur dann mit `Secure`, wenn der Aufruf HTTPS ist. Hinter einem TLS-Terminierer muss der Hoster `X-Forwarded-Proto` setzen; falls er das nicht tut, konfiguriert der Realm-Admin die URL explizit als HTTPS. Ein stilles Downgrade auf HTTP-Cookies in Produktion ist nicht vorgesehen.

## 5. Datenbank anlegen

Im Kundenlogin eine Datenbank vom Typ MariaDB oder MySQL anlegen, Benutzer und Passwort setzen, Hostname aus den Details übernehmen. Oft ist der Hostname nicht `localhost`. Der Installer übernimmt die vier Werte und wählt den Laravel-Treiber passend zum Typ.

Rechte: `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `ALTER`, `INDEX`, `DROP` auf dieser einen Datenbank. `DROP` wird für fehlgeschlagene Installationsversuche und für spätere Migrationen gebraucht. Kein globales Superuser-Recht.

## 6. Upload

1. ZIP auf dem eigenen Rechner entpacken.
2. Dateien per SFTP, FTPS oder dem Dateimanager des Hosters hochladen. Unverschlüsseltes FTP zum Webspace ist ein Notweg mit demselben Hinweis wie beim Spielserver.
3. Im Browser die Installer-URL öffnen und [INSTALLATION.md](INSTALLATION.md) folgen.

Composer wird auf dem Webspace nicht ausgeführt.

## 7. Laufender Betrieb ohne Cron

- Sessions und Cache liegen in der Datenbank.
- „Jetzt synchronisieren“ und ein offener Workspace lösen einen begrenzten Dateiabruf aus.
- Aufräumen alter Payloads läuft höchstens alle paar Stunden, gesteuert durch eine Zeile in der Datenbank, die parallele Requests aussperrt.
- Auf einem VPS legt `scripts/setup-vps.sh` je Installation eine eigene Datei unter `/etc/cron.d/` an (`schedule:run` jede Minute). Eine weitere Kundeninstallation ist ein weiteres `--target` und überschreibt die erste nicht.
- Wer auf Shared Hosting Cron hat, kann zusätzlich `php artisan schedule:run` jede Minute eintragen, oder einmal `php artisan agravion:install-schedule` ausführen. Auf STRATO-Neuverträgen ist Cron derzeit kein Planungsbestandteil; dort zieht der Icon-Abgleich beim nächsten Dashboard-Aufruf nach.
- Store-Icons in FS25 sind oft **BC7-DDS**. Die Umwandlung nach PNG braucht das Binary `backend/bin/dds2rgba` (gcc beim Install). Auf reinem Shared Hosting ohne Compiler und ohne auslieferbares Binary bleiben viele Icons im Cache als DDS und die Equipment-Liste zeigt Platzhalter. Für vollständige Icons ist ein VPS mit `build-essential` der unterstützte Weg ([INSTALLATION.md](INSTALLATION.md)).

## 8. Bekannte Grenzen

- Keine Echtzeit unter einer Sekunde.
- Lange Requests können vom Hoster gekappt werden. Dateiabrufe haben deshalb ein kurzes Zeitlimit und einen Fortsetzungszeiger.
- `putenv`, `symlink`, `proc_open` und `shell_exec` sind auf Shared Hosts manchmal deaktiviert. Ohne `shell_exec` kann `dds2rgba` nicht laufen — dann keine BC7-PNGs. Phase 3 prüft das auf STRATO oder einem vergleichbaren Paket.
- Die Anwendung misst nicht CPU oder RAM des Webspace, außer der Hoster liefert dafür eine API. Eine solche API ist nicht angenommen.
- PHP-Limits für Uploadgröße betreffen das Release-ZIP nur beim manuellen Upload, nicht die Laufzeit. Große Connector-Snapshots lehnt die API ab.

## 9. Nachweis, der noch fehlt

Eine komplette Installation auf einem aktuellen STRATO-Paket oder einem gleichwertigen Webspace: PHP 8.3, einmal MySQL 8, einmal MariaDB 10.11, Document-Root-Variante, Fallback-Variante, Installer-Sperre, Login. Bis dahin bleibt „läuft auf Shared Hosting“ eine begründete Architektur, keine durchgeführte Abnahme.
