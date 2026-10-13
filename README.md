# vbus-to-influx

Liest einen RESOL-VBus-USB-Adapter (z. B. DeltaSol) seriell aus und schreibt die Werte in eine InfluxDB 1.x. Das Schema ist kompatibel zum ioBroker-Adapter `iobroker.resol` (resol.0), sodass bestehende Serien nahtlos weitergeführt werden können.

## Features

- VBus seriell → InfluxDB 1.x im ioBroker-resol.0-Schema: eine Measurement je Datenpunkt, Felder `value`, `ack`, `from`, `q`
- Datenpunkt-Whitelist (leer/`null` = alle erkannten Datenpunkte)
- VBus-over-TCP-Port, über den weitere VBus-Clients mitlesen können
- Web-Oberfläche „VBus Monitor": Live-Werte aller Datenpunkte, Port- und InfluxDB-Status, InfluxDB-Verbindung zur Laufzeit änderbar (gespeichert in `config.local.json`), siehe [Web-Oberfläche](#web-oberfläche)
- Gamification: Level/XP, Sonnenserie, Allzeit-Rekorde, Tagesbilanz und 26 Abzeichen auf Basis von Kollektor, Speicher, Solarpumpe und optional Einstrahlung, siehe [Gamification](#gamification)

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
| `game.collector` | Datenpunkt-ID Kollektortemperatur; `null` = nicht zugeordnet | `null` |
| `game.storage` | Datenpunkt-ID Speichertemperatur | `null` |
| `game.pump` | Datenpunkt-ID Solarpumpe (Drehzahl in %, > 0 = läuft) | `null` |
| `game.irradiation` | Datenpunkt-ID Einstrahlung (optional) | `null` |
| `game.sunnyDayMinutes` | Pumpenlaufzeit in Minuten, ab der ein Tag als Sonnentag zählt | `60` |
| `datapoints` | Whitelist der Datenpunkt-IDs; `null` = alle | `null` |

`config.local.json` (von der Web-UI geschrieben) überschreibt die `influx`- und `game`-Werte aus `config.js`. Wer Werte in `config.js` ändert und keine Wirkung sieht, sollte dort nachsehen.

## Web-Oberfläche

Erreichbar unter `http://<host>:<web.port>/` (Standard Port 80; mit `web: false` abgeschaltet). Hell/Dunkel folgt dem System und lässt sich oben rechts umschalten. Die Seite liegt in `web/index.html`, wird beim Start einmal geladen und gzip-komprimiert ausgeliefert.

**Bereiche:**
- **Spielstand / Sonnenserie / Live-Kacheln / Diagramm / Rekorde / Abzeichen / Ereignisse**, siehe [Gamification](#gamification)
- **System:** Kachel je seriellem Port (Status, Alter der letzten Daten, Anzahl TCP-Clients), Kachel InfluxDB (Status, Version, letzter Schreibvorgang, geschriebene Punkte, Fehlversuche), Laufzeit des Dienstes
- **Datenpunkte:** Tabelle aller empfangenen Datenpunkte mit Suchfeld: Feld, Wert, ob nach InfluxDB geschrieben wird (bzw. „Sensorfehler", wenn der Regler 888,8/999,9 °C meldet und deshalb nichts geschrieben wird), Datenpunkt-ID, Alter des Werts. Nützlich, um die IDs für die `datapoints`-Whitelist zu finden. Fürs Spiel genutzte Datenpunkte sind markiert.

Altersangaben werden gegen die Serverzeit gerechnet, eine falsch gehende Uhr am Browser-Gerät verfälscht sie also nicht.

**Spiel-Zuordnung** (aufklappbar): Auswahl von Kollektor, Speicher, Solarpumpe, Einstrahlung aus den empfangenen Datenpunkten (gefiltert nach Einheit) und Schwelle für Sonnentage. Wird sofort wirksam und in `config.local.json` gespeichert.

**InfluxDB-Einstellungen** (aufklappbar):
- Felder: `URL`, `Bucket`, `Token`, `Org`, `Namespace`, `from-Feld` (entsprechen `influx.*` in der Konfiguration)
- Das Token wird nicht angezeigt. Leer lassen = gespeichertes Token bleibt; „gespeichertes Token entfernen" löscht es
- „Speichern und anwenden" übernimmt die Werte **zur Laufzeit ohne Neustart**: Sie werden in `config.local.json` gespeichert, der Schreib-Client wird neu aufgebaut und die Verbindung sofort geprüft
- Prüfungen: `URL` muss mit `http://` oder `https://` beginnen, `Bucket` darf nicht leer sein (sonst Fehlermeldung, nichts wird gespeichert)

**API** (von der Seite selbst genutzt):

| Pfad | Methode | Inhalt |
|---|---|---|
| `/api/status` | GET | Serverzeit, Ports, letzte Datenpunkte, InfluxDB-Zustand, Spielstand, Uptime |
| `/api/config` | GET | aktuelle `influx`-Einstellungen ohne Token (`tokenSet: true/false`) + Verbindungszustand |
| `/api/config` | POST | JSON mit `url`, `token`, `org`, `bucket`, `namespace`, `from` (Teilmenge genügt; fehlendes `token` = unverändert) → speichern und anwenden |
| `/api/game` | POST | JSON mit `collector`, `storage`, `pump`, `irradiation`, `sunnyDayMinutes` (Teilmenge genügt) → speichern und anwenden |

Kein Endpunkt liefert das Token aus.

## Gamification

Grundlage sind die unter „Spiel-Zuordnung" (oder `game` in `config.js`) gewählten Datenpunkte. Welcher Fühler der Kollektor ist, hängt von der Anlagenhydraulik ab und wird deshalb nicht geraten. Ohne Zuordnung zeigt die Seite einen Einrichtungshinweis.

- **Solarbetrieb:** Zeit, in der die Solarpumpe läuft (Wert > 0 %). Gezählt wird die Zeit zwischen zwei Messzyklen; Lücken von mehr als 4 Intervallen (mind. 60 s, z. B. Neustart oder Portausfall) zählen nicht.
- **Tagesbilanz:** Laufzeit, Höchstwerte von Kollektor/Speicher/Einstrahlung und Einstrahlungssumme (kWh/m²) für den laufenden Tag. Tagesgrenze ist Mitternacht in der Zeitzone des Systems.
- **Sonnentag & Sonnenserie:** Ein Tag mit mindestens `sunnyDayMinutes` Solarbetrieb ist ein Sonnentag. Aufeinanderfolgende Sonnentage bilden die Serie; sie bleibt bis zum Ende des Folgetags bestehen und reißt danach ab.
- **Rekorde:** Allzeit-Höchstwerte (Kollektor, Speicher, Einstrahlung, längster Solartag, längste Serie) mit Datum. Wird ein an einem früheren Tag aufgestellter Rekord gebrochen, gibt es ein Ereignis.
- **XP & Level:** 1 XP je Minute Solarbetrieb plus Bonus-XP je Abzeichen. Level *n* braucht insgesamt 50·n·(n−1) XP (Level 2: 100, Level 3: 300, Level 4: 600 …).
- **Abzeichen:** 26 Stück, z. B. Laufzeit an einem Tag (1/4/8 h), Gesamtlaufzeit (10–1000 h), Sonnentage (10/50/100), Serien (3/7/14/30 Tage), Kollektor ≥ 60/80/100 °C, Speicher ≥ 50/60/70 °C, Einstrahlung ≥ 800/1000 W/m², Solarbetrieb vor 8:00 bzw. nach 19:00 Uhr, Sonnentag im Winter. Abzeichen für nicht zugeordnete Datenpunkte werden ausgeblendet.
- **Ereignisse:** Abzeichen, Rekorde, Level-Aufstiege und Sonnentage erscheinen in der Liste und, wenn sie seit dem letzten Besuch neu sind, als Einblendung mit Konfetti (abgeschaltet bei „Bewegung reduzieren").

Der Spielstand liegt in `game-state.json` im Installationsverzeichnis. Er wird alle 5 Minuten, beim Tageswechsel und beim Beenden atomar geschrieben (SD-Karte schonen); bei einem harten Absturz gehen höchstens die letzten 5 Minuten verloren. Löschen der Datei (bei gestopptem Dienst) setzt das Spiel zurück. Die InfluxDB-Daten sind davon unberührt; das Spiel beginnt mit der Installation dieser Version bei null.

## Betrieb

```sh
systemctl status vbus-to-influx
systemctl restart vbus-to-influx
journalctl -u vbus-to-influx -f
```

Manueller Test: `node main.js` im Installationsverzeichnis. Unit-Tests der Spiel-Logik: `npm test` (nutzt den eingebauten Test-Runner von Node).

## Hinweise

- Nur EIN Prozess darf den seriellen Port lesen. Alte Bridges oder der ioBroker-Adapter müssen vorher gestoppt werden.
- InfluxDB verwirft Punkte stillschweigend, wenn der Feldtyp mit dem einer bestehenden Series kollidiert. Bei fehlenden Daten Influx-Log prüfen und bei Migrationen Feldtypen der vorhandenen Series beachten.
- Auf armv6 (z. B. Raspberry Pi Zero/1) ist `npm install` heikel, weil das native `serialport`-Binding neu gebaut wird. Abhängigkeitsversionen passend zu den bereits installierten `node_modules` halten (`npm ci` mit dem mitgelieferten `package-lock.json`).
- Sicherheit: Die Web-UI hat keine Authentifizierung. Das Influx-Token wird zwar nicht mehr ausgeliefert, URL/Bucket/Org sind aber sichtbar, und jeder im Netz kann die Einstellungen ändern. Nur in einem vertrauenswürdigen Netz betreiben (oder mit `web: false` abschalten).
- TCP-Clients, die mehr als 1 MiB Daten nicht abholen, werden getrennt, damit ein hängender Client den Speicher nicht füllt. Clients bleiben verbunden, wenn der serielle Port kurz wegfällt und neu geöffnet wird.
