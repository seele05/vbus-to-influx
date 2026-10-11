# vbus-to-influx

Liest einen RESOL-VBus-USB-Adapter (z. B. DeltaSol) seriell aus und schreibt die Werte in eine InfluxDB 1.x. Das Schema ist kompatibel zum ioBroker-Adapter `iobroker.resol` (resol.0), sodass bestehende Serien nahtlos weitergeführt werden können.

## Features

- VBus seriell → InfluxDB 1.x im ioBroker-resol.0-Schema: eine Measurement je Datenpunkt, Felder `value`, `ack`, `from`, `q`
- Datenpunkt-Whitelist (leer/`null` = alle erkannten Datenpunkte)
- VBus-over-TCP-Port, über den weitere VBus-Clients mitlesen können
- Web-Oberfläche „VBus Monitor": Live-Werte aller Datenpunkte, Port- und InfluxDB-Status, InfluxDB-Verbindung zur Laufzeit änderbar (gespeichert in `config.local.json`), siehe [Web-Oberfläche](#web-oberfläche)

## Voraussetzungen

- Node.js (im Betrieb mit Node 21.7.3 auf armv6l eingesetzt; `package.json` enthält kein `engines`-Feld)
- RESOL-VBus-USB-Adapter (USB-ID `1fef:2018`)
- InfluxDB 1.x (Ansprache über den v2-Kompatibilitätslayer, `/api/v2/write`)

## Installation

```sh
git clone <repo-url> /opt/vbus-to-influx
cd /opt/vbus-to-influx
npm ci
cp config.example.js config.js      # anpassen

cp contrib/99-vbus.rules /etc/udev/rules.d/
udevadm control --reload && udevadm trigger

cp contrib/vbus-to-influx.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now vbus-to-influx
```

Die udev-Regel legt `/dev/vbus` als stabilen Gerätenamen an. Die Unit läuft ohne `User=` als root (nötig für Web-Port 80); bei unprivilegiertem Betrieb `User=` setzen, Mitgliedschaft in `dialout` sicherstellen und `web.port` > 1024 wählen.

## Konfiguration

`config.js` (Vorlage: `config.example.js`):

| Key | Bedeutung | Beispiel |
|---|---|---|
| `language` | Sprache der Feldnamen (`de`/`en`) | `'de'` |
| `vbusInterval` | Sammel-/Schreibintervall in Sekunden | `15` |
| `serialPorts[].channel` | VBus-Kanal | `0` |
| `serialPorts[].path` | Serieller Port | `/dev/vbus` |
| `serialPorts[].baudrate` | Baudrate | `9600` |
| `tcp.port` | VBus-over-TCP-Port; `tcp: false` deaktiviert | `7053` |
| `web.port` | Port der Web-UI; `web: false` deaktiviert | `80` |
| `influx.url` | InfluxDB-URL | `http://influxdb.example:8086` |
| `influx.token` | Bei 1.x: leer oder `benutzer:passwort`; bei 2.x: Token | `''` |
| `influx.org` | Organisation (nur InfluxDB 2.x) | `''` |
| `influx.bucket` | 1.x: `<datenbank>/<retention policy>` | `resol/autogen` |
| `influx.namespace` | Measurement-Präfix (ioBroker-Namespace) | `resol.0` |
| `influx.from` | Inhalt des Felds `from` | `system.adapter.resol.0` |
| `datapoints` | Whitelist der Datenpunkt-IDs; `null` = alle | `null` |

`config.local.json` (von der Web-UI geschrieben) überschreibt die `influx`-Werte aus `config.js`. Wer Werte in `config.js` ändert und keine Wirkung sieht, sollte dort nachsehen.

## Web-Oberfläche

Erreichbar unter `http://<host>:<web.port>/` (Standard Port 80; mit `web: false` abgeschaltet).

**Seite „VBus Monitor":**
- Kachel je seriellem Port: Status, Alter der letzten Daten, Anzahl verbundener TCP-Clients
- Kachel InfluxDB: Verbindungsstatus, Version, Alter des letzten Schreibvorgangs, geschriebene Punkte, Fehler
- Tabelle aller empfangenen Datenpunkte: Feld, Wert, ob nach InfluxDB geschrieben wird, Datenpunkt-ID, Alter des Werts — nützlich, um die IDs für die `datapoints`-Whitelist zu finden

**InfluxDB-Einstellungen** (aufklappbarer Bereich „InfluxDB-Einstellungen"):
- Felder: `URL`, `Bucket`, `Token`, `Org`, `Namespace`, `from-Feld` (entsprechen `influx.*` in der Konfiguration)
- „Speichern und anwenden" übernimmt die Werte **zur Laufzeit ohne Neustart**: Sie werden in `config.local.json` gespeichert, der Schreib-Client wird neu aufgebaut und die Verbindung sofort geprüft
- Prüfungen: `URL` muss mit `http://` oder `https://` beginnen, `Bucket` darf nicht leer sein (sonst Fehlermeldung, nichts wird gespeichert)

**API** (von der Seite selbst genutzt):

| Pfad | Methode | Inhalt |
|---|---|---|
| `/api/status` | GET | Ports, letzte Datenpunkte, InfluxDB-Zustand, Uptime |
| `/api/config` | GET | aktuelle `influx`-Einstellungen + Verbindungszustand |
| `/api/config` | POST | JSON mit `url`, `token`, `org`, `bucket`, `namespace`, `from` (Teilmenge genügt) → speichern und anwenden |

Beide GET-Endpunkte liefern das `token` im Klartext.

## Betrieb

```sh
systemctl status vbus-to-influx
systemctl restart vbus-to-influx
journalctl -u vbus-to-influx -f
```

Manueller Test: `node main.js` im Installationsverzeichnis.

## Hinweise

- Nur EIN Prozess darf den seriellen Port lesen. Alte Bridges oder der ioBroker-Adapter müssen vorher gestoppt werden.
- InfluxDB verwirft Punkte stillschweigend, wenn der Feldtyp mit dem einer bestehenden Series kollidiert. Bei fehlenden Daten Influx-Log prüfen und bei Migrationen Feldtypen der vorhandenen Series beachten.
- Auf armv6 (z. B. Raspberry Pi Zero/1) ist `npm install` heikel, weil das native `serialport`-Binding neu gebaut wird. Abhängigkeitsversionen passend zu den bereits installierten `node_modules` halten (`npm ci` mit dem mitgelieferten `package-lock.json`).
- Sicherheit: Die Web-UI hat keine Authentifizierung und zeigt die Influx-Zugangsdaten an. Nur in einem vertrauenswürdigen Netz betreiben (oder mit `web: false` abschalten).
